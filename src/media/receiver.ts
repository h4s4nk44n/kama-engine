/**
 * chunk yeniden insasi -> VideoDecoder (WebCodecs) -> canvas
 *
 * GroupAssembler'dan cikan PU'lar chunk_id bazinda toplanir. Bir chunk'in
 * tum fragmanlari geldiginde birlestirilir ve decoder'a verilir.
 *
 * Eksik fragmanli chunk CHUNK_TIMEOUT_MS sonra dusurulur. Bir chunk
 * dustugunde referans zinciri kirildigi icin sonraki keyframe'e kadar
 * delta chunk'lar da atilir — decoder'i bozuk referansla beslemek hem
 * gorsel copluk hem de decoder'in kapanmasi demek.
 *
 * VideoFrame sizintisi olmamasi icin decoder ciktisi cizildikten hemen
 * sonra close() edilir.
 */

import type { ProtectedUnit } from '../wire/protectedUnit.ts';

export const CHUNK_TIMEOUT_MS = 600;
export const FREEZE_THRESHOLD_MS = 600;

/** chunk_id'den turetilen zaman damgasi tabani (20 fps). */
const TIMESTAMP_STEP_US = Math.round(1_000_000 / 20);

export interface ReceiverStats {
  pusReceived: number;
  chunksCompleted: number;
  /** eksik fragman yuzunden dusen chunk */
  chunksDropped: number;
  /** keyframe beklendigi icin atlanan delta chunk */
  chunksSkippedWaitingKey: number;
  framesDecoded: number;
  framesDrawn: number;
  decoderErrors: number;
  freezes: number;
  freezeMs: number;
  /** son 1 saniyedeki cizim sayisi */
  fps: number;
  waitingForKey: boolean;
}

export interface ReceiverOptions {
  canvas: HTMLCanvasElement;
  onError?: (err: unknown) => void;
}

interface PendingChunk {
  chunkId: number;
  keyframe: boolean;
  fragCount: number;
  frags: Array<Uint8Array | undefined>;
  have: number;
  bytes: number;
  firstSeenMs: number;
}

export class MediaReceiver {
  readonly stats: ReceiverStats = {
    pusReceived: 0,
    chunksCompleted: 0,
    chunksDropped: 0,
    chunksSkippedWaitingKey: 0,
    framesDecoded: 0,
    framesDrawn: 0,
    decoderErrors: 0,
    freezes: 0,
    freezeMs: 0,
    fps: 0,
    waitingForKey: true,
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onError: ReceiverOptions['onError'];

  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private description: Uint8Array | undefined;

  private pending = new Map<number, PendingChunk>();
  /** Teslim edilmis/iptal edilmis chunk'lar — gec gelen fragmanlar yutulur */
  private done = new Set<number>();

  /**
   * YENIDEN SIRALAMA TAMPONU.
   *
   * Source semboller geldigi anda iletildigi icin chunk'lar SIRASIZ
   * tamamlanabilir: kurtarma bekleyen chunk N dururken N+1 hemen biter.
   * Decoder'a sirasiz vermek referans zincirini bozar. Bu yuzden tamamlanan
   * chunk'lar burada bekletilir ve decoder'a yalnizca SIRAYLA verilir.
   *
   * Eskiden "chunkId ileri atladi" durumu dogrudan "zincir koptu" sayilip
   * keyframe bekleniyordu; bu, yalnizca yeniden siralama yuzunden saniyelerce
   * donmaya yol aciyordu.
   */
  private ready = new Map<number, { chunkId: number; keyframe: boolean; data: Uint8Array }>();
  /** Kesin dusmus chunk id'leri — sira bunlarin uzerinden atlar */
  private droppedIds = new Set<number>();
  /** Decoder'a verilecek siradaki chunk */
  private nextDecode: number | null = null;
  private nextDecodeSince = 0;

  private lastDrawMs = 0;
  private freezeOpen = false;
  private drawTimes: number[] = [];

  constructor(opts: ReceiverOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas baglami alinamadi');
    this.ctx = ctx;
    this.onError = opts.onError;
  }

  /**
   * KARSI TARAFIN encoder'inin bildirdigi decoder yapilandirmasi.
   * Yerel encoder'in codec'i degil — heterojen gorusmede (masaustu VP8,
   * iPhone H.264) dogru olan tek kaynak karsi taraftir.
   */
  configure(cfg: { codec: string; description?: Uint8Array }): void {
    const sameDesc = sameBytes(this.description, cfg.description);
    if (this.codec === cfg.codec && sameDesc && this.decoder?.state === 'configured') return;
    this.codec = cfg.codec;
    this.description = cfg.description;
    this.resetDecoder();
  }

  get configuredCodec(): string | null {
    return this.codec;
  }

  private resetDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* yoksay */
      }
    }
    this.decoder = null;
    this.stats.waitingForKey = true;

    if (!this.codec) return;

    const dec = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (err) => {
        this.stats.decoderErrors++;
        this.onError?.(err);
        // Decoder kapandi; yeni bir tane kur ve keyframe bekle
        this.decoder = null;
        this.stats.waitingForKey = true;
      },
    });

    try {
      const cfg: VideoDecoderConfig = { codec: this.codec, optimizeForLatency: true };
      // H.264 avcC gibi formatlarda description sart; annexb'de hic gelmez
      if (this.description) cfg.description = this.description;
      dec.configure(cfg);
      this.decoder = dec;
    } catch (err) {
      this.stats.decoderErrors++;
      this.onError?.(err);
    }
  }

  pushPU(pu: ProtectedUnit, nowMs: number): void {
    this.stats.pusReceived++;

    if (this.done.has(pu.chunkId)) return;

    let c = this.pending.get(pu.chunkId);
    if (!c) {
      c = {
        chunkId: pu.chunkId,
        keyframe: pu.keyframe,
        fragCount: pu.fragCount,
        frags: new Array(pu.fragCount),
        have: 0,
        bytes: 0,
        firstSeenMs: nowMs,
      };
      this.pending.set(pu.chunkId, c);
    }

    if (c.fragCount !== pu.fragCount) return; // tutarsiz, at
    if (c.frags[pu.fragIndex]) return; // yinelenen

    c.frags[pu.fragIndex] = pu.payload;
    c.have++;
    c.bytes += pu.payload.length;
    c.keyframe = c.keyframe || pu.keyframe;

    if (c.have === c.fragCount) this.complete(c);
  }

  /** Periyodik cagrilir: zaman asimi, freeze olcumu, fps. */
  tick(nowMs: number): void {
    for (const c of [...this.pending.values()]) {
      if (nowMs - c.firstSeenMs >= CHUNK_TIMEOUT_MS) this.dropChunk(c);
    }
    // Hic gelmeyen bir chunk sirayi kilitlemesin
    this.unstick(nowMs);

    if (this.done.size > 512) {
      this.done = new Set([...this.done].slice(-256));
    }
    if (this.droppedIds.size > 512) {
      this.droppedIds = new Set([...this.droppedIds].slice(-256));
    }

    // Freeze: canvas'a son cizim uzerinden FREEZE_THRESHOLD_MS gectiyse
    if (this.lastDrawMs > 0) {
      const gap = nowMs - this.lastDrawMs;
      if (gap >= FREEZE_THRESHOLD_MS && !this.freezeOpen) {
        this.freezeOpen = true;
        this.stats.freezes++;
      }
      if (this.freezeOpen) {
        // Donma suresi, esigi asan kismi degil, tum bosluk olarak sayilir
        this.stats.freezeMs = this.freezeMsBase + gap;
      }
    }

    const cutoff = nowMs - 1000;
    while (this.drawTimes.length > 0 && this.drawTimes[0] < cutoff) this.drawTimes.shift();
    this.stats.fps = this.drawTimes.length;
  }

  reset(): void {
    this.pending.clear();
    this.done.clear();
    this.ready.clear();
    this.droppedIds.clear();
    this.nextDecode = null;
    this.nextDecodeSince = 0;
    this.lastDrawMs = 0;
    this.freezeOpen = false;
    this.freezeMsBase = 0;
    this.drawTimes = [];
    for (const k of Object.keys(this.stats) as Array<keyof ReceiverStats>) {
      if (typeof this.stats[k] === 'number') (this.stats[k] as number) = 0;
    }
    this.stats.waitingForKey = true;
    this.resetDecoder();
  }

  dispose(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* yoksay */
      }
    }
    this.decoder = null;
    this.pending.clear();
    this.ready.clear();
  }

  /** Grup tamamen dustugunde alici referans zincirini kirik sayar. */
  noteGroupLost(): void {
    this.stats.waitingForKey = true;
  }

  // --- ic isleyis ---

  private freezeMsBase = 0;

  private complete(c: PendingChunk): void {
    this.pending.delete(c.chunkId);
    this.done.add(c.chunkId);
    this.stats.chunksCompleted++;

    const data = new Uint8Array(c.bytes);
    let off = 0;
    for (let i = 0; i < c.fragCount; i++) {
      const f = c.frags[i]!;
      data.set(f, off);
      off += f.length;
    }

    this.ready.set(c.chunkId, { chunkId: c.chunkId, keyframe: c.keyframe, data });
    // Tampon sinirsiz buyumesin
    if (this.ready.size > 128) {
      const oldest = Math.min(...this.ready.keys());
      this.ready.delete(oldest);
    }
    this.drainReady(performance.now());
  }

  private dropChunk(c: PendingChunk): void {
    this.pending.delete(c.chunkId);
    this.done.add(c.chunkId);
    this.droppedIds.add(c.chunkId);
    this.stats.chunksDropped++;
    this.drainReady(performance.now());
  }

  /** Elimizdeki en kucuk keyframe id'si (yeniden senkron noktasi). */
  private lowestKeyframe(): number | null {
    let best: number | null = null;
    for (const item of this.ready.values()) {
      if (item.keyframe && (best === null || item.chunkId < best)) best = item.chunkId;
    }
    return best;
  }

  /** Sirasi gelen chunk'lari decoder'a verir. */
  private drainReady(nowMs: number): void {
    for (;;) {
      if (this.nextDecode === null) {
        // Akisa her zaman bir keyframe ile baslanir
        const kf = this.lowestKeyframe();
        if (kf === null) return;
        this.nextDecode = kf;
        this.nextDecodeSince = nowMs;
      }

      const item = this.ready.get(this.nextDecode);
      if (item) {
        this.ready.delete(this.nextDecode);
        this.droppedIds.delete(this.nextDecode);
        this.feedDecoder(item);
        this.nextDecode++;
        this.nextDecodeSince = nowMs;
        continue;
      }

      if (this.droppedIds.has(this.nextDecode)) {
        // Bu chunk kesin dustu: uzerinden atla, zincir kirildi
        this.droppedIds.delete(this.nextDecode);
        this.nextDecode++;
        this.nextDecodeSince = nowMs;
        this.stats.waitingForKey = true;
        continue;
      }

      return; // henuz gelmedi — bekle
    }
  }

  /**
   * Sira takildiysa (beklenen chunk hic gelmedi) ileri atla.
   * Aksi hâlde tek bir kayip chunk tum akisi kilitlerdi.
   */
  private unstick(nowMs: number): void {
    if (this.nextDecode === null || this.ready.size === 0) return;
    if (nowMs - this.nextDecodeSince < CHUNK_TIMEOUT_MS) return;

    let lowest = Infinity;
    for (const id of this.ready.keys()) if (id < lowest) lowest = id;
    if (lowest === Infinity || lowest <= this.nextDecode) return;

    this.nextDecode = lowest;
    this.nextDecodeSince = nowMs;
    this.stats.waitingForKey = true;
    this.drainReady(nowMs);
  }

  private feedDecoder(item: { chunkId: number; keyframe: boolean; data: Uint8Array }): void {
    if (item.keyframe) this.stats.waitingForKey = false;
    else if (this.stats.waitingForKey) {
      // Bozuk referansla decoder'i besleme
      this.stats.chunksSkippedWaitingKey++;
      return;
    }

    if (!this.decoder || this.decoder.state !== 'configured') {
      this.resetDecoder();
      if (!this.decoder) return;
      if (!item.keyframe) {
        this.stats.waitingForKey = true;
        return;
      }
    }

    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: item.keyframe ? 'key' : 'delta',
          // Zaman damgasi chunk_id'den turetilir: tek yonlu artan, esit
          // araliklı. Chunk dusse bile monotonluk bozulmaz.
          timestamp: item.chunkId * TIMESTAMP_STEP_US,
          data: item.data,
        }),
      );
      this.stats.framesDecoded++;
    } catch (err) {
      this.stats.decoderErrors++;
      this.stats.waitingForKey = true;
      this.onError?.(err);
      this.resetDecoder();
    }
  }

  private draw(frame: VideoFrame): void {
    try {
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

      const now = performance.now();
      if (this.freezeOpen) {
        // Acik donmayi kapat, suresini kalici toplama ekle
        this.freezeMsBase += now - this.lastDrawMs;
        this.stats.freezeMs = this.freezeMsBase;
        this.freezeOpen = false;
      }
      this.lastDrawMs = now;
      this.drawTimes.push(now);
      this.stats.framesDrawn++;
    } catch (err) {
      this.onError?.(err);
    } finally {
      // Sizinti olmamasi icin her yolda kapat
      frame.close();
    }
  }
}

function sameBytes(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
