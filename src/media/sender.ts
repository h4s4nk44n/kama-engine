/**
 * getUserMedia -> VideoEncoder (WebCodecs) -> fragmentation
 *
 * Encoder ciktisi (EncodedVideoChunk) ham baytlara alinir, MAX_PAYLOAD_LEN
 * boyunda fragmanlara bolunur, her fragman bir Protected Unit'e sarilir ve
 * GroupBuilder'a verilir. Buradan sonrasi bizim kodumuz.
 *
 * Kare kaynagi icin iki yol var:
 *   1. MediaStreamTrackProcessor   - masaustu Chrome
 *   2. <video> + requestVideoFrameCallback + canvas + new VideoFrame(canvas)
 *      - Chrome Android ve iOS Safari'de MediaStreamTrackProcessor yok,
 *        bu yol kullanilir; canvas adimi kamera donusunu (rotation) kareye
 *        isler — bkz. pumpViaVideoElement
 *
 * VideoFrame sizintisi olmamasi icin her kare islendikten sonra close()
 * edilir; hata yollarinda da.
 */

import { MAX_PAYLOAD_LEN, type ProtectedUnit } from '../wire/protectedUnit.ts';

export interface SenderConfig {
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  /** keyframe araligi, ms */
  keyframeIntervalMs: number;
}

export const DEFAULT_SENDER_CONFIG: SenderConfig = {
  width: 640,
  height: 360,
  framerate: 20,
  bitrate: 750_000,
  keyframeIntervalMs: 2000,
};

export interface SenderStats {
  framesCaptured: number;
  framesEncoded: number;
  /** encoder kuyrugu dolu oldugu icin atlanan kare */
  framesDropped: number;
  chunksProduced: number;
  keyframes: number;
  fragmentsProduced: number;
  encodedBytes: number;
  codec: string;
  frameSource: 'track-processor' | 'video-rvfc' | 'none';
  videoSource: VideoSource | 'none';
}

export type VideoSource = 'camera' | 'pattern';

/**
 * Encoder'in urettigi gercek decoder yapilandirmasi. Alici tarafi bunu
 * kullanmali — kendi encoder'inin sectigi codec'i DEGIL. Masaustu VP8,
 * iPhone H.264 secerse iki taraf da karsi tarafi cozemez.
 */
export interface RemoteDecoderConfig {
  codec: string;
  /** H.264 avcC gibi formatlarda gerekli; annexb'de bulunmaz */
  description?: Uint8Array;
  codedWidth?: number;
  codedHeight?: number;
}

export interface SenderOptions {
  onPU: (pu: ProtectedUnit) => void;
  /** Ilk chunk ile birlikte bir kez cagrilir. */
  onDecoderConfig?: (cfg: RemoteDecoderConfig) => void;
  onError?: (err: unknown) => void;
  config?: Partial<SenderConfig>;
  /**
   * 'camera' (varsayilan) kamera yoksa/izin verilmezse otomatik olarak
   * 'pattern'a duser. 'pattern' hareketli bir test deseni uretir —
   * kamerasiz makinede de tum boru hatti (encode -> FEC -> decode)
   * gercekten kosar.
   */
  source?: VideoSource;
}

/** Chrome'da var, lib.dom'da yok. */
declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }
  // eslint-disable-next-line no-var
  var MediaStreamTrackProcessor:
    | { new (init: MediaStreamTrackProcessorInit): { readable: ReadableStream<VideoFrame> } }
    | undefined;
}

/** Denenecek codec'ler; ilk desteklenen kullanilir. */
const CODEC_CANDIDATES = [
  { codec: 'vp8', label: 'VP8' },
  { codec: 'avc1.42001f', label: 'H.264 baseline', avc: { format: 'annexb' as AvcBitstreamFormat } },
  { codec: 'vp09.00.10.08', label: 'VP9' },
];

export class MediaSender {
  readonly stats: SenderStats = {
    framesCaptured: 0,
    framesEncoded: 0,
    framesDropped: 0,
    chunksProduced: 0,
    keyframes: 0,
    fragmentsProduced: 0,
    encodedBytes: 0,
    codec: '-',
    frameSource: 'none',
    videoSource: 'none',
  };

  private stream: MediaStream | null = null;
  private encoder: VideoEncoder | null = null;
  private config: SenderConfig;
  private readonly onPU: SenderOptions['onPU'];
  private readonly onError: SenderOptions['onError'];

  private chunkId = 0;
  private lastKeyframeMs = 0;
  private running = false;

  /** Kare kaynagi temizligi icin */
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private rvfcHandle: number | null = null;

  private readonly wantSource: VideoSource;

  private readonly onDecoderConfig: SenderOptions['onDecoderConfig'];
  private decoderConfigSent = false;

  constructor(opts: SenderOptions) {
    this.onPU = opts.onPU;
    this.onDecoderConfig = opts.onDecoderConfig;
    this.onError = opts.onError;
    this.config = { ...DEFAULT_SENDER_CONFIG, ...opts.config };
    this.wantSource = opts.source ?? 'camera';
  }

  getConfig(): SenderConfig {
    return { ...this.config };
  }

  /**
   * Bir sonraki karenin keyframe olmasini zorlar.
   *
   * ARQ tarafindaki alici referans zincirini kaybettiginde (grup dustu,
   * FEC+ARQ da yetmedi) kontrol kanalindan keyframe ister; 2 saniyelik
   * periyodik keyframe'i beklemek yerine akis ~1 RTT'de toparlanir.
   */
  forceKeyframe(): void {
    this.lastKeyframeMs = Number.NEGATIVE_INFINITY;
  }

  /** Bitrate calisirken degistirilebilir - encoder yeniden yapilandirilir. */
  setBitrate(bps: number): void {
    const clamped = Math.max(150_000, Math.min(3_000_000, Math.round(bps)));
    if (clamped === this.config.bitrate) return;
    this.config.bitrate = clamped;
    if (this.encoder && this.encoder.state === 'configured') {
      try {
        this.encoder.configure(this.buildEncoderConfig());
        // Yeni yapilandirmadan sonra ilk kare keyframe olmali
        this.lastKeyframeMs = 0;
      } catch (err) {
        this.onError?.(err);
      }
    }
  }

  async start(): Promise<MediaStream> {
    if (this.running) throw new Error('sender zaten calisiyor');

    this.stream = await this.acquireStream();

    const track = this.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    // Kameranin gercekten verdigi cozunurluk kullanilir
    this.config.width = settings.width ?? this.config.width;
    this.config.height = settings.height ?? this.config.height;

    const picked = await this.pickCodec();
    if (!picked) throw new Error('Desteklenen bir VideoEncoder codec bulunamadi (VP8/H.264/VP9)');
    this.stats.codec = picked.label;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onChunk(chunk, meta),
      error: (err) => this.onError?.(err),
    });
    this.encoder.configure(this.buildEncoderConfig());

    this.running = true;
    void this.pumpFrames(track);
    return this.stream;
  }

  stop(): void {
    this.running = false;

    if (this.rvfcHandle !== null && this.videoEl) {
      this.videoEl.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
    if (this.reader) {
      this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.encoder && this.encoder.state !== 'closed') {
      try {
        this.encoder.close();
      } catch {
        /* yoksay */
      }
    }
    if (this.patternHandle !== null) {
      clearInterval(this.patternHandle);
      this.patternHandle = null;
    }
    this.patternCanvas = null;

    this.encoder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /**
   * Kamera akisini alir. Kamera yoksa ya da izin verilmezse test desenine
   * duser — boru hatti (encode -> FEC -> kayip -> decode) yine gercek kosar.
   */
  private async acquireStream(): Promise<MediaStream> {
    if (this.wantSource === 'camera') {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: this.config.width },
            height: { ideal: this.config.height },
            frameRate: { ideal: this.config.framerate },
          },
          audio: false,
        });
        this.stats.videoSource = 'camera';
        return s;
      } catch (err) {
        this.onError?.(
          new Error(`kamera acilamadi (${errName(err)}) — test desenine geciliyor`),
        );
      }
    }
    this.stats.videoSource = 'pattern';
    return this.startPatternSource();
  }

  /** Hareketli test deseni: canvas -> captureStream. */
  private startPatternSource(): MediaStream {
    const canvas = document.createElement('canvas');
    canvas.width = this.config.width;
    canvas.height = this.config.height;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    this.patternCanvas = canvas;

    let n = 0;
    const paint = (): void => {
      if (!this.patternCanvas) return;
      const w = canvas.width;
      const h = canvas.height;
      const t = n / this.config.framerate;

      // Kayan degradeli zemin — sikismasi kolay olmayan, hareketli icerik
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${(n * 2) % 360} 70% 22%)`);
      grad.addColorStop(1, `hsl(${(n * 2 + 120) % 360} 70% 12%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Dolanan disk
      ctx.fillStyle = '#3ddc84';
      ctx.beginPath();
      ctx.arc(
        w / 2 + Math.cos(t * 1.7) * w * 0.32,
        h / 2 + Math.sin(t * 2.3) * h * 0.32,
        Math.min(w, h) * 0.11,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Dikey tarama cizgisi + kare sayaci: donma gozle ayirt edilebilsin
      ctx.fillStyle = '#ff5f56';
      ctx.fillRect(((n * 9) % w), 0, 5, h);

      ctx.fillStyle = '#eef3fa';
      ctx.font = `700 ${Math.round(h * 0.16)}px ui-monospace, monospace`;
      ctx.textBaseline = 'top';
      ctx.fillText(String(n).padStart(5, '0'), 14, 12);

      n++;
    };

    // requestAnimationFrame DEGIL: rAF ekran tazeleme hizina bagli ve
    // arka plandaki sekmelerde tamamen durdurulur. Desen, yapilandirilan
    // framerate'te uretilmeli.
    paint();
    this.patternHandle = setInterval(paint, Math.max(1, Math.round(1000 / this.config.framerate)));

    return canvas.captureStream(this.config.framerate);
  }

  private patternCanvas: HTMLCanvasElement | null = null;
  private patternHandle: ReturnType<typeof setInterval> | null = null;

  private buildEncoderConfig(): VideoEncoderConfig {
    const cand = CODEC_CANDIDATES.find((c) => c.label === this.stats.codec) ?? CODEC_CANDIDATES[0];
    const cfg: VideoEncoderConfig = {
      codec: cand.codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.framerate,
      latencyMode: 'realtime',
    };
    // annexb: chunk'lar kendi kendine yeter, decoder'a description gerekmez
    if (cand.avc) (cfg as VideoEncoderConfig & { avc?: unknown }).avc = cand.avc;
    return cfg;
  }

  private async pickCodec(): Promise<(typeof CODEC_CANDIDATES)[number] | null> {
    for (const cand of CODEC_CANDIDATES) {
      const cfg: VideoEncoderConfig = {
        codec: cand.codec,
        width: this.config.width,
        height: this.config.height,
        bitrate: this.config.bitrate,
        framerate: this.config.framerate,
        latencyMode: 'realtime',
      };
      if (cand.avc) (cfg as VideoEncoderConfig & { avc?: unknown }).avc = cand.avc;
      try {
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup.supported) return cand;
      } catch {
        /* sonrakini dene */
      }
    }
    return null;
  }

  // --- kare kaynagi ---

  private async pumpFrames(track: MediaStreamTrack): Promise<void> {
    if (typeof globalThis.MediaStreamTrackProcessor === 'function') {
      this.stats.frameSource = 'track-processor';
      await this.pumpViaTrackProcessor(track);
    } else {
      this.stats.frameSource = 'video-rvfc';
      await this.pumpViaVideoElement();
    }
  }

  private async pumpViaTrackProcessor(track: MediaStreamTrack): Promise<void> {
    const Ctor = globalThis.MediaStreamTrackProcessor!;
    const processor = new Ctor({ track });
    const reader = processor.readable.getReader();
    this.reader = reader;

    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.handleFrame(value);
      }
    } catch (err) {
      if (this.running) this.onError?.(err);
    } finally {
      reader.releaseLock?.();
    }
  }

  /**
   * Chrome Android / iOS Safari yolu: MediaStreamTrackProcessor yok.
   * <video> ogesi + requestVideoFrameCallback ile kare basina bir kez uyanir.
   *
   * DONUS DUZELTMESI: Telefon kameralari tamponu sensore gore YATAY verir;
   * <video> ogesi donus metadatasini uygulayarak dik gosterir ama
   * new VideoFrame(video) WebKit'te HAM tamponu alir — karsi tarafta
   * goruntu 90 derece yatik cikar. drawImage donusu uyguladigi icin kare
   * once bir canvas'a cizilir, VideoFrame oradan uretilir: yon kaynaginda
   * duzelir, alici tarafta degisiklik gerekmez.
   */
  private async pumpViaVideoElement(): Promise<void> {
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    this.videoEl = video;
    await video.play();

    const canvas = document.createElement('canvas');
    const cctx = canvas.getContext('2d', { alpha: false })!;

    const tick = (_now: number, meta: { mediaTime: number }): void => {
      if (!this.running || !this.videoEl) return;
      let frame: VideoFrame | null = null;
      try {
        // videoWidth/Height donus UYGULANMIS (gosterim) boyutlardir;
        // portre tutulan telefonda w < h olur. Telefon dondurulunce
        // boyutlar degisir — canvas ve encoder birlikte guncellenir.
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w > 0 && h > 0) {
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            this.ensureEncoderDims(w, h);
          }
          cctx.drawImage(video, 0, 0, w, h);
          frame = new VideoFrame(canvas, { timestamp: Math.round(meta.mediaTime * 1e6) });
          this.handleFrame(frame);
          frame = null; // handleFrame sahipligi devraldi
        }
      } catch (err) {
        this.onError?.(err);
      } finally {
        frame?.close();
      }
      if (this.running && this.videoEl) {
        this.rvfcHandle = this.videoEl.requestVideoFrameCallback(tick);
      }
    };

    this.rvfcHandle = video.requestVideoFrameCallback(tick);
  }

  /** Kare boyutu yapilandirmadan farkliysa encoder gercek boyuta gecirilir. */
  private ensureEncoderDims(w: number, h: number): void {
    if (this.config.width === w && this.config.height === h) return;
    this.config.width = w;
    this.config.height = h;
    if (this.encoder && this.encoder.state === 'configured') {
      try {
        this.encoder.configure(this.buildEncoderConfig());
        this.lastKeyframeMs = 0; // yeni boyutta ilk kare keyframe olsun
      } catch (err) {
        this.onError?.(err);
      }
    }
  }

  /** Kare sahipligini devralir - her yolda close() edilir. */
  private handleFrame(frame: VideoFrame): void {
    this.stats.framesCaptured++;

    const enc = this.encoder;
    if (!enc || enc.state !== 'configured') {
      frame.close();
      return;
    }

    // Encoder kuyrugu birikirse gecikme ucar; en yeni kare degerlidir.
    if (enc.encodeQueueSize > 2) {
      this.stats.framesDropped++;
      frame.close();
      return;
    }

    const nowMs = performance.now();
    const wantKey = nowMs - this.lastKeyframeMs >= this.config.keyframeIntervalMs;
    if (wantKey) this.lastKeyframeMs = nowMs;

    try {
      enc.encode(frame, { keyFrame: wantKey });
      this.stats.framesEncoded++;
    } catch (err) {
      this.onError?.(err);
    } finally {
      frame.close();
    }
  }

  // --- fragmentation ---

  private onChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    // Decoder yapilandirmasini encoder'in kendisinden al ve bir kez bildir.
    // Codec dizesini tahmin etmek yerine buradan almak, farkli tarayicilar
    // arasindaki gorusmede (VP8 <-> H.264) tek dogru yoldur.
    if (!this.decoderConfigSent && meta?.decoderConfig) {
      const dc = meta.decoderConfig;
      const desc = dc.description;
      this.decoderConfigSent = true;
      this.onDecoderConfig?.({
        codec: dc.codec,
        description: desc ? new Uint8Array(descriptionBytes(desc)) : undefined,
        codedWidth: dc.codedWidth,
        codedHeight: dc.codedHeight,
      });
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const keyframe = chunk.type === 'key';
    const chunkId = this.chunkId;
    this.chunkId = (this.chunkId + 1) >>> 0;

    this.stats.chunksProduced++;
    if (keyframe) this.stats.keyframes++;
    this.stats.encodedBytes += data.length;

    const fragCount = Math.max(1, Math.ceil(data.length / MAX_PAYLOAD_LEN));
    if (fragCount > 0xffff) {
      // 65535 fragman = ~75 MB; pratikte imkansiz ama sessizce bozulmasin
      this.onError?.(new Error(`chunk cok buyuk: ${data.length} bayt`));
      return;
    }

    for (let i = 0; i < fragCount; i++) {
      const start = i * MAX_PAYLOAD_LEN;
      const end = Math.min(data.length, start + MAX_PAYLOAD_LEN);
      this.stats.fragmentsProduced++;
      this.onPU({
        chunkId,
        keyframe,
        fragIndex: i,
        fragCount,
        payload: data.subarray(start, end),
      });
    }
  }
}

/** description ArrayBuffer ya da ArrayBufferView olabilir. */
function descriptionBytes(d: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d as ArrayBuffer);
}

function errName(e: unknown): string {
  if (e instanceof DOMException) return e.name;
  if (e instanceof Error) return e.message;
  return String(e);
}
