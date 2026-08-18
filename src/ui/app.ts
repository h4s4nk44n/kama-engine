/**
 * Arayuz ve boru hattinin baglanmasi.
 *
 * TEK kamera, TEK encoder, TEK fragman listesi, UC boru hatti:
 *
 *   getUserMedia -> VideoEncoder -> fragmentation -> GroupBuilder
 *        -> RS FEC encode -> kayip enjeksiyonu -> yapay gecikme
 *        -> RTCDataChannel
 *              |
 *              v  (alicida ayni fiziksel paketler uc yola beslenir)
 *   +----------+--------------------+--------------------+
 *   |                               |                    |
 *  KORUMASIZ                       FEC                FEC + ARQ
 *  useFec=false                 useFec=true         useFec=true
 *  parity'yi kullanmaz          RS decode           RS decode + NACK
 *
 * EncodedVideoChunk UC KEZ FRAGMANLANMAZ — bir kez fragmanlanir, uc
 * pipeline ayni fragman listesini alir. Uc ayri VideoEncoder CPU'yu
 * bogar ve kayip desenlerini ayristirirdi.
 *
 * KAYIP DESENI TEKTIR: kablodan tek datagram akisi gecer, kayip karari
 * paket sira numarasina (ordinal) gore bir kez verilir. Uc panel ayni
 * fiziksel paketleri kaybeder. Yalnizca retransmit paketleri panel 3'e
 * ozeldir ve AYRI bir ordinal uzayi kullanir — boylece ARQ etkinken bile
 * ana desen kaymaz.
 */

import { GroupBuilder } from '../wire/groupBuilder.ts';
import { GroupAssembler } from '../wire/groupAssembler.ts';
import { decodeDatagram, encodePing, decodePing, decodeNack, packetKind, blockIndex } from '../wire/datagram.ts';
import { SenderSymbolCache, NackController, RtxBudget } from '../net/arq.ts';
import { LossPattern, type LossModel } from '../net/lossPattern.ts';
import { DelayQueue, RttMeter } from '../net/delayQueue.ts';
import { DataChannelTransport, LoopbackTransport, type DatagramTransport } from '../net/channel.ts';
import { PeerSession, type PeerState, type TransportInfo } from '../net/signaling.ts';
import { MediaSender, type RemoteDecoderConfig } from '../media/sender.ts';
import { MediaReceiver } from '../media/receiver.ts';
import { MetricsOverlay, snapshot, platformLine, type ArqPanelStats } from './metrics.ts';
import { codecName } from '../fec/index.ts';

interface Settings {
  lossPct: number;
  /** yapay gidis-donus suresi, ms (tek yon = yarisi) */
  rttMs: number;
  bitrateKbps: number;
  ratio: number;
  kTarget: number;
  model: LossModel;
}

const DEFAULT_SETTINGS: Settings = {
  lossPct: 30,
  rttMs: 60,
  bitrateKbps: 750,
  ratio: 0.8,
  kTarget: 16,
  model: 'iid',
};

const PING_INTERVAL_MS = 1000;
/** Assembler/alici tik araligi — ARQ 600 ms deadline ile calisiyor. */
const TICK_MS = 30;
/** Metrik DOM guncelleme araligi (tik katı). */
const UI_EVERY = 4;

interface Panel {
  id: 'plain' | 'fec' | 'arq';
  useFec: boolean;
  useArq: boolean;
  assembler: GroupAssembler;
  receiver: MediaReceiver;
  overlay: MetricsOverlay;
  badge: HTMLElement;
  label: string;
}

export class App {
  private settings: Settings = { ...DEFAULT_SETTINGS };

  private sender: MediaSender | null = null;
  private builder: GroupBuilder | null = null;
  private transport: DatagramTransport | null = null;
  private peer: PeerSession | null = null;

  /** Uc panelin PAYLASTIGI kayip deseni — ordinal tabanli. */
  private readonly lossMain = new LossPattern(0x6b616d61); // "kama"
  /** Retransmit'ler ayri ordinal uzayi kullanir; ana deseni kaydirmaz. */
  private readonly lossRtx = new LossPattern(0x6b616d61 ^ 0x5bf03635);
  private txOrdinal = 0;
  private rtxOrdinal = 0;
  private txDropped = 0;
  private rtxDropped = 0;

  private readonly delayQueue = new DelayQueue(() => this.settings.rttMs / 2);
  private readonly rtt = new RttMeter();
  private pingHandle: number | null = null;

  // --- ARQ ---
  /** Gonderici tarafi sembol onbellegi (sinirli: 8 grup / 600 ms / 4 MB) */
  private readonly symbolCache = new SenderSymbolCache();
  private readonly rtxBudget = new RtxBudget();
  /** Alici tarafi: yalniz panel 3 icin NACK uretir */
  private readonly nack = new NackController({
    // NACK de yapay gecikmeden gecer — yoksa ARQ'nun gidis-donusu
    // gercekci olmaz. Kayip enjeksiyonuna tabi degildir: kriter 7'de
    // "yanitsiz NACK" orani retransmit kaybindan gelsin diye.
    send: (bytes) => this.delayQueue.send(bytes, (b) => this.transport?.send(b)),
    rttEstMs: () => this.rttEstMs(),
  });
  /** Toplam giden bayt (RTX butcesi paydasi) */
  private txBytes = 0;
  /** Son grup kayiplari — hata ayiklama */
  private lossLog: Array<{ panel: string; groupId: number; missing: number; K: number }> = [];
  /** Kablodaki gercek tasima (tarayici istatistiklerinden okunur) */
  private transportInfo: TransportInfo | null = null;
  private transportPollHandle: number | null = null;

  private panels: Panel[] = [];
  private tickHandle: number | null = null;
  private tickCount = 0;
  private running = false;
  private localDecoderConfig: RemoteDecoderConfig | null = null;
  private remoteDecoderConfig: RemoteDecoderConfig | null = null;

  private readonly el = {
    startBtn: byId<HTMLButtonElement>('startBtn'),
    stopBtn: byId<HTMLButtonElement>('stopBtn'),
    status: byId<HTMLElement>('status'),
    platform: byId<HTMLElement>('platform'),
    linkInfo: byId<HTMLElement>('linkInfo'),
    statusLine: byId<HTMLElement>('statusLine'),
    preview: byId<HTMLCanvasElement>('previewCanvas'),
    sourceInfo: byId<HTMLElement>('sourceInfo'),
    errors: byId<HTMLElement>('errors'),
    pairBar: byId<HTMLElement>('pairBar'),
    pairUrl: byId<HTMLElement>('pairUrl'),
    pairNote: byId<HTMLElement>('pairNote'),
    loopbackBanner: byId<HTMLElement>('loopbackBanner'),
    maxRetries: byId<HTMLElement>('maxRetriesOut'),
    infeasible: byId<HTMLElement>('infeasibleOut'),
  };

  private readonly sliders = {
    loss: byId<HTMLInputElement>('lossSlider'),
    rtt: byId<HTMLInputElement>('rttSlider'),
    bitrate: byId<HTMLInputElement>('bitrateSlider'),
    ratio: byId<HTMLInputElement>('ratioSlider'),
    kTarget: byId<HTMLInputElement>('kSlider'),
  };

  private readonly outputs = {
    loss: byId<HTMLElement>('lossOut'),
    rtt: byId<HTMLElement>('rttOut'),
    bitrate: byId<HTMLElement>('bitrateOut'),
    ratio: byId<HTMLElement>('ratioOut'),
    kTarget: byId<HTMLElement>('kOut'),
    m: byId<HTMLElement>('mOut'),
  };

  private readonly modelRadios = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="lossModel"]'),
  );
  private readonly sourceRadios = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="videoSource"]'),
  );

  start(): void {
    this.el.platform.textContent = platformLine();
    this.buildPanels();
    this.bindControls();
    this.checkSupport();
    void this.showPairUrl();
    this.connectSignaling();

    this.el.startBtn.addEventListener('click', () => void this.startMedia());
    this.el.stopBtn.addEventListener('click', () => this.stopMedia());
  }

  // --- kurulum ---

  private buildPanels(): void {
    const specs: Array<{
      id: Panel['id'];
      label: string;
      useFec: boolean;
      useArq: boolean;
      canvas: string;
      metrics: string;
      badge: string;
    }> = [
      { id: 'plain', label: 'KORUMASIZ', useFec: false, useArq: false, canvas: 'plainCanvas', metrics: 'plainMetrics', badge: 'plainBadge' },
      { id: 'fec', label: 'FEC', useFec: true, useArq: false, canvas: 'fecCanvas', metrics: 'fecMetrics', badge: 'fecBadge' },
      { id: 'arq', label: 'FEC + ARQ', useFec: true, useArq: true, canvas: 'arqCanvas', metrics: 'arqMetrics', badge: 'arqBadge' },
    ];

    this.panels = specs.map((s) => {
      const receiver = new MediaReceiver({
        canvas: byId<HTMLCanvasElement>(s.canvas),
        onError: (e) => this.note(`decoder (${s.label}): ${errText(e)}`),
      });
      const assembler = new GroupAssembler({
        useFec: s.useFec,
        onPU: (pu) => receiver.pushPU(pu, performance.now()),
        onGroupLost: (groupId, missing, K) => {
          receiver.noteGroupLost();
          // Son kayiplarin kaydi — kayipsiz durumda grup dusuyorsa
          // sebebini gormek icin (kama.debug().lossLog)
          this.lossLog.push({ panel: s.id, groupId, missing, K });
          if (this.lossLog.length > 24) this.lossLog.shift();
        },
      });
      return {
        id: s.id,
        label: s.label,
        useFec: s.useFec,
        useArq: s.useArq,
        assembler,
        receiver,
        overlay: new MetricsOverlay(byId<HTMLElement>(s.metrics), s.useArq),
        badge: byId<HTMLElement>(s.badge),
      };
    });
  }

  private panel(id: Panel['id']): Panel {
    const p = this.panels.find((x) => x.id === id);
    if (!p) throw new Error(`panel yok: ${id}`);
    return p;
  }

  private checkSupport(): void {
    const missing: string[] = [];
    if (typeof VideoEncoder === 'undefined') missing.push('VideoEncoder');
    if (typeof VideoDecoder === 'undefined') missing.push('VideoDecoder');
    if (!navigator.mediaDevices?.getUserMedia) missing.push('getUserMedia');
    if (!window.isSecureContext) missing.push('güvenli bağlam (HTTPS/localhost)');

    if (missing.length > 0) {
      this.note(`Eksik: ${missing.join(', ')} — README'deki sertifika / chrome://flags adımına bakın.`);
      this.el.startBtn.disabled = true;
    }
  }

  private async showPairUrl(): Promise<void> {
    try {
      const res = await fetch('/lan.json', { cache: 'no-store' });
      const info = (await res.json()) as {
        addresses: string[];
        httpPort: number;
        tlsPort: number;
        https: boolean;
      };
      const ip = info.addresses[0];
      if (!ip) {
        this.el.pairBar.classList.add('hidden');
        return;
      }
      if (info.https) {
        this.el.pairUrl.textContent = `https://${ip}:${info.tlsPort}/`;
        this.el.pairNote.textContent =
          `iPhone ilk kez bağlanıyorsa önce sertifikayı kurun: https://${ip}:${info.tlsPort}/kama-cert.crt`;
      } else {
        this.el.pairUrl.textContent = `http://${ip}:${info.httpPort}/`;
        this.el.pairNote.textContent = 'iPhone için HTTPS gerekir — "npm run cert" çalıştırın.';
      }
    } catch {
      this.el.pairBar.classList.add('hidden');
    }
  }

  private bindControls(): void {
    const s = this.sliders;
    const onInput = (): void => {
      this.applySettings(
        {
          lossPct: Number(s.loss.value),
          rttMs: Number(s.rtt.value),
          bitrateKbps: Number(s.bitrate.value),
          ratio: Number(s.ratio.value) / 100,
          kTarget: Number(s.kTarget.value),
          model: this.modelRadios.find((r) => r.checked)?.value === 'gilbert' ? 'gilbert' : 'iid',
        },
        true,
      );
    };

    for (const input of [s.loss, s.rtt, s.bitrate, s.ratio, s.kTarget]) {
      input.addEventListener('input', onInput);
    }
    for (const r of this.modelRadios) r.addEventListener('change', onInput);

    this.applySettings(this.settings, false);
  }

  private applySettings(next: Settings, propagate: boolean): void {
    this.settings = { ...next };

    this.lossMain.setLoss(this.settings.lossPct / 100, this.settings.model);
    this.lossRtx.setLoss(this.settings.lossPct / 100, this.settings.model);
    this.builder?.setParams({ kTarget: this.settings.kTarget, ratio: this.settings.ratio });
    this.sender?.setBitrate(this.settings.bitrateKbps * 1000);

    this.outputs.loss.textContent = `${this.settings.lossPct} %`;
    this.outputs.rtt.textContent = `${this.settings.rttMs} ms`;
    this.outputs.bitrate.textContent = `${this.settings.bitrateKbps} kbps`;
    this.outputs.ratio.textContent = this.settings.ratio.toFixed(2);
    this.outputs.kTarget.textContent = String(this.settings.kTarget);
    this.outputs.m.textContent = `M = ${this.currentM()}  ·  ${this.settings.kTarget}+${this.currentM()} paket/grup`;

    this.sliders.loss.value = String(this.settings.lossPct);
    this.sliders.rtt.value = String(this.settings.rttMs);
    this.sliders.bitrate.value = String(this.settings.bitrateKbps);
    this.sliders.ratio.value = String(Math.round(this.settings.ratio * 100));
    this.sliders.kTarget.value = String(this.settings.kTarget);
    for (const r of this.modelRadios) r.checked = r.value === this.settings.model;

    this.updateStatusLine();
    if (propagate) this.peer?.sendControl({ type: 'settings', settings: this.settings });
  }

  private currentM(): number {
    return Math.min(32, Math.max(1, Math.ceil(this.settings.kTarget * this.settings.ratio)));
  }

  /** Fizibilite hesabinda kullanilan toplam tur suresi. */
  rttEstMs(): number {
    return this.settings.rttMs + this.rtt.measuredRttMs;
  }

  private updateStatusLine(): void {
    const fec = this.panel('fec').assembler.stats;
    const total = fec.sourceBytes + fec.parityBytes;
    const overhead = total > 0 ? (fec.parityBytes / total) * 100 : 0;
    this.el.statusLine.innerHTML =
      `kayıp <b>%${this.settings.lossPct}</b> · RTT <b>${this.settings.rttMs} ms</b>` +
      ` · K=<b>${this.settings.kTarget}</b> · M=<b>${this.currentM()}</b>` +
      ` · overhead <b>%${overhead.toFixed(1)}</b>` +
      ` · fec: <b>${codecName()}</b> · ${platformLine()}`;
  }

  // --- ag ---

  private connectSignaling(): void {
    this.peer = new PeerSession({
      onState: (state, detail) => this.onPeerState(state, detail),
      onTransport: (t) => this.useTransport(t),
      onControl: (msg) => {
        const m = msg as { type?: string; settings?: Settings; codec?: string; description?: string };
        if (m.type === 'settings' && m.settings) {
          this.applySettings(m.settings, false);
        } else if (m.type === 'codec' && m.codec) {
          this.remoteDecoderConfig = {
            codec: m.codec,
            description: m.description ? b64ToBytes(m.description) : undefined,
          };
          this.configureReceivers();
        }
      },
    });
    this.peer.connect();
  }

  private onPeerState(state: PeerState, detail?: string): void {
    const labels: Record<PeerState, string> = {
      idle: 'boşta',
      waiting: 'eşleş bekleniyor',
      connecting: 'bağlanıyor',
      connected: 'eşleş bağlı',
      closed: 'bağlantı kapandı',
      failed: 'bağlantı başarısız',
    };
    this.el.status.dataset.state = state;
    this.el.status.textContent = detail ? `${labels[state]} — ${detail}` : labels[state];
    this.el.pairBar.classList.toggle('hidden', state === 'connected');

    // 'connecting' de dahil: yeniden muzakere basladiginda ('ready')
    // eski olu tasiyiciyla donup kalmak yerine loopback'e dusulur.
    if (state !== 'connected') {
      this.dropDeadTransport();
    }

    if (state === 'connected') {
      this.updateLinkInfo();
      this.startTransportPoll();
      this.peer?.sendControl({ type: 'settings', settings: this.settings });
      this.announceCodec();
    } else if (this.transport instanceof LoopbackTransport) {
      this.el.linkInfo.textContent = 'loopback (eşleş yok) · tam boru hattı çalışıyor';
    }
  }

  /**
   * Kablodaki gercek protokolu tarayicidan okur.
   * DataChannel yigini SCTP -> DTLS -> UDP'dir; TCP yalniz sinyallesmede
   * (WebSocket) kullanilir. Bunu ekranda gostermek, "UDP mi TCP mi"
   * sorusunu tahminle degil olcumle cevaplar.
   */
  private startTransportPoll(): void {
    if (this.transportPollHandle !== null) return;
    const poll = async (): Promise<void> => {
      this.transportInfo = (await this.peer?.transportInfo()) ?? null;
      this.updateLinkInfo();
    };
    void poll();
    this.transportPollHandle = window.setInterval(() => void poll(), 2000);
  }

  private stopTransportPoll(): void {
    if (this.transportPollHandle !== null) {
      window.clearInterval(this.transportPollHandle);
      this.transportPollHandle = null;
    }
    this.transportInfo = null;
  }

  private updateLinkInfo(): void {
    const t = this.transportInfo;
    if (!t) {
      this.el.linkInfo.textContent = 'RTCDataChannel · ordered:false · maxRetransmits:0';
      return;
    }
    const proto = (t.relayProtocol ?? t.protocol).toUpperCase();
    const path = [t.localType, t.remoteType].filter(Boolean).join('/');
    this.el.linkInfo.textContent =
      `SCTP/DTLS/${proto} · ordered:false · maxRetransmits:0` +
      (path ? ` · ${path}` : '') +
      (t.rttMs !== undefined ? ` · ağ RTT ${t.rttMs} ms` : '');
    // UDP degilse (ör. TURN/TCP yedegi) kullaniciya belli olsun
    this.el.linkInfo.style.color = proto === 'UDP' ? 'var(--accent)' : 'var(--warn)';
  }

  private useTransport(t: DatagramTransport): void {
    if (this.transport && this.transport !== t) this.transport.close();
    this.transport = t;
    t.onDatagram = (bytes) => this.onDatagram(bytes);
    if (t instanceof LoopbackTransport) {
      // Kendi kendine test: kendi karelerimiz kendi encoder config'imizle
      // cozulur.
      if (this.localDecoderConfig) this.remoteDecoderConfig = this.localDecoderConfig;
    } else {
      // Gercek eslese gecis: loopback'ten kalan YEREL config ile karsi
      // tarafin kareleri COZULMEZ — guvenilir kanaldan gelecek 'codec'
      // duyurusu beklenir (sendControl kuyrukladigi icin kaybolmaz).
      this.remoteDecoderConfig = null;
    }
    this.resetPanels();
    this.updateLoopbackBanner();
  }

  /**
   * Esles koptugunda olu DataChannelTransport birakilir. Yayin suruyorsa
   * SESSIZCE degil, banner ile birlikte loopback'e dusulur; yeni esles
   * baglaninca useTransport gercek tasiyiciya geri gecer.
   */
  private dropDeadTransport(): void {
    if (!(this.transport instanceof DataChannelTransport)) return;
    // DC hala acik (or. yalniz sinyallesme koptu) — calisan yolu bozma
    if (this.transport.ready) return;
    this.stopTransportPoll();
    this.transport.close();
    this.transport = null;
    if (this.running) this.useTransport(new LoopbackTransport());
    this.updateLoopbackBanner();
  }

  /** Yayin loopback'teyken ekranda ACIK uyari: kullanici kendi goruntusunu izliyor. */
  private updateLoopbackBanner(): void {
    const show = this.running && this.transport instanceof LoopbackTransport;
    this.el.loopbackBanner.classList.toggle('hidden', !show);
  }

  /** Kablodan gelen her datagram uc yola da beslenir. */
  private onDatagram(bytes: Uint8Array): void {
    switch (packetKind(bytes)) {
      case 'ping':
        this.onPing(bytes);
        return;
      case 'nack':
        this.onNack(bytes);
        return;
      case 'media':
        break;
      default:
        return;
    }

    const dg = decodeDatagram(bytes);
    if (!dg) return;
    const now = performance.now();

    if (dg.isRetransmit) {
      // Retransmit YALNIZ ARQ paneline gider — yoksa panel 2 de ARQ'dan
      // yararlanir ve karsilastirma anlamsizlasirdi.
      this.nack.noteRetransmit(dg.groupId, blockIndex(dg));
      this.panel('arq').assembler.push(dg, now);
      return;
    }
    for (const p of this.panels) p.assembler.push(dg, now);
  }

  private onPing(bytes: Uint8Array): void {
    const p = decodePing(bytes);
    if (!p) return;
    if (p.isPong) {
      this.rtt.onPong(p.nonce);
      return;
    }
    this.transport?.send(encodePing({ isPong: true, nonce: p.nonce }));
  }

  /**
   * Periyodik RTT olcumu.
   *
   * Ping/pong yapay gecikme kuyrugunu ATLAR: fizibilite hesabi
   *     rttEst = artificialRttMs + measuredRttMs
   * seklinde ve measuredRttMs GERCEK ag turunu olcmeli. Ping'ler de
   * kuyruktan gecseydi yapay gecikme iki kez sayilirdi.
   *
   * Ping'ler kayip enjeksiyonuna da tabi degildir — olcum trafigidir.
   */
  private startPinging(): void {
    if (this.pingHandle !== null) return;
    this.pingHandle = window.setInterval(() => {
      if (!this.transport?.ready) return;
      const nonce = this.rtt.startPing();
      this.transport.send(encodePing({ isPong: false, nonce }));
    }, PING_INTERVAL_MS);
  }

  /** Orijinal (retransmit olmayan) datagram gonderimi. */
  private sendOriginal(bytes: Uint8Array): void {
    this.txBytes += bytes.length;
    const ordinal = this.txOrdinal++;
    if (this.lossMain.isLost(ordinal)) {
      this.txDropped++;
      return;
    }
    this.delayQueue.send(bytes, (b) => this.transport?.send(b));
  }

  /**
   * Retransmit gonderimi. AYRI ordinal uzayi kullanir ama AYNI kayip
   * parametreleri — retransmit paketleri de kayba tabidir, yoksa ARQ
   * yapay olarak avantajli gorunurdu.
   */
  private sendRetransmit(bytes: Uint8Array): void {
    this.txBytes += bytes.length;
    this.rtxBudget.note(bytes.length);
    const ordinal = this.rtxOrdinal++;
    if (this.lossRtx.isLost(ordinal)) {
      this.rtxDropped++;
      return;
    }
    this.delayQueue.send(bytes, (b) => this.transport?.send(b));
  }

  /**
   * Karsi taraftan NACK geldi — istenen sembolleri onbellekten uretip
   * geri gonder. Kural 3 ve 4 onbellekte, kural 5 burada uygulanir.
   */
  private onNack(bytes: Uint8Array): void {
    const n = decodeNack(bytes);
    if (!n) return;
    const now = performance.now();

    for (const idx of n.indices) {
      const dg = this.symbolCache.buildRetransmit(n.groupId, idx, now);
      if (!dg) continue; // onbellekte yok / deadline gecmis -> sessizce yok say

      // Kural 5: RTX butcesi asilirsa NACK'ler yanitsiz birakilir
      if (!this.rtxBudget.allows(this.txBytes, dg.length)) return;
      this.sendRetransmit(dg);
    }
  }

  // --- medya ---

  private async startMedia(): Promise<void> {
    if (this.running) return;
    this.el.startBtn.disabled = true;

    try {
      if (!this.transport) {
        this.useTransport(new LoopbackTransport());
        this.el.linkInfo.textContent = 'loopback (eşleş yok) · tam boru hattı çalışıyor';
      }

      this.builder = new GroupBuilder({
        params: {
          kTarget: this.settings.kTarget,
          ratio: this.settings.ratio,
          windowMs: 200,
          // Parity HER ZAMAN uretilir: panel 2 ve 3 kullanir, panel 1 yok sayar.
          fecEnabled: true,
        },
        // Source datagrami fragman uretilir uretilmez kabloya cikar —
        // grubun kapanmasini beklemez. Puruzsuz oynatmanin sarti bu.
        onSource: (e) => this.sendOriginal(e.bytes),
        onGroup: (parity, stats) => {
          // ARQ gonderici onbellegi: kapanan grubun TUM sembolleri
          this.symbolCache.store(
            stats.groupId,
            stats.K,
            stats.M,
            stats.symbolSize,
            stats.symbols,
            performance.now(),
          );
          // Kapanista yalniz parity gonderilir
          for (const e of parity) this.sendOriginal(e.bytes);
        },
      });

      const wantSource =
        this.sourceRadios.find((r) => r.checked)?.value === 'pattern' ? 'pattern' : 'camera';

      this.sender = new MediaSender({
        // TEK fragman listesi — uc pipeline ayni PU'lari alir
        onPU: (pu) => this.builder?.push(pu),
        onDecoderConfig: (cfg) => {
          this.localDecoderConfig = cfg;
          this.announceCodec();
          if (this.transport instanceof LoopbackTransport) {
            this.remoteDecoderConfig = cfg;
            this.configureReceivers();
          }
        },
        onError: (e) => this.note(`encoder: ${errText(e)}`),
        config: { bitrate: this.settings.bitrateKbps * 1000 },
        source: wantSource,
      });

      const stream = await this.sender.start();
      this.startPreview(stream);

      const src = this.sender.stats.videoSource === 'pattern' ? 'test deseni' : 'kamera';
      this.el.sourceInfo.textContent = `${src} · ${this.sender.stats.frameSource}`;
      for (const r of this.sourceRadios) r.checked = r.value === this.sender.stats.videoSource;

      this.running = true;
      this.updateLoopbackBanner();
      this.el.stopBtn.disabled = false;
      this.startTicker();
      this.startPinging();
    } catch (err) {
      this.note(`başlatılamadı: ${errText(err)}`);
      this.el.startBtn.disabled = false;
    }
  }

  private stopMedia(): void {
    this.running = false;
    this.sender?.stop();
    this.sender = null;
    this.builder?.dispose();
    this.builder = null;
    this.stopPreview();
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.pingHandle !== null) {
      clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
    if (this.transportPollHandle !== null) {
      clearInterval(this.transportPollHandle);
      this.transportPollHandle = null;
    }
    this.delayQueue.clear();
    this.rtt.reset();
    this.symbolCache.reset();
    this.nack.reset();
    this.rtxBudget.reset();
    this.txBytes = 0;
    this.el.startBtn.disabled = false;
    this.el.stopBtn.disabled = true;
    this.updateLoopbackBanner();
  }

  private resetPanels(): void {
    for (const p of this.panels) {
      p.assembler.reset();
      p.receiver.reset();
    }
    this.configureReceivers();
  }

  private configureReceivers(): void {
    const cfg = this.remoteDecoderConfig;
    if (!cfg) return;
    const short = cfg.codec.split('.')[0].toUpperCase();
    for (const p of this.panels) {
      p.receiver.configure(cfg);
      p.badge.textContent = `${p.label} · ${short}`;
    }
  }

  private announceCodec(): void {
    const cfg = this.localDecoderConfig;
    if (!cfg) return;
    this.peer?.sendControl({
      type: 'codec',
      codec: cfg.codec,
      description: cfg.description ? bytesToB64(cfg.description) : undefined,
    });
  }

  private startTicker(): void {
    if (this.tickHandle !== null) return;
    this.tickHandle = window.setInterval(() => {
      const now = performance.now();
      for (const p of this.panels) {
        p.assembler.tick(now);
        p.receiver.tick(now);
      }
      this.onTick(now);

      if (++this.tickCount % UI_EVERY === 0) this.refreshMetrics();
    }, TICK_MS);
  }

  private onTick(now: number): void {
    // Gonderici onbellegini yasla — 5 dakikalik kosumda boyut sabit kalir
    this.symbolCache.prune(now);
    // Alici tarafi: yalniz ARQ paneli NACK uretir
    this.nack.tick(now, this.panel('arq').assembler.openGroups());
  }

  /** ARQ paneli icin ek sayaclar. */
  private arqStats(): ArqPanelStats {
    const s = this.nack.stats;
    return {
      nackSent: s.nackSent,
      nackAnswered: s.nackAnswered,
      retransmitReceived: s.retransmitReceived,
      nackInfeasible: s.nackInfeasible,
      maxRetries: this.nack.currentMaxRetries(),
      rtxBudgetUsed: this.rtxBudget.used(this.txBytes),
      rtxBudgetExceeded: this.rtxBudget.exceeded,
      groupsSavedByArq: this.panel('arq').assembler.stats.groupsSavedByArq,
    };
  }

  private refreshMetrics(): void {
    const a = this.arqStats();
    for (const p of this.panels) {
      p.overlay.update(snapshot(p.assembler.stats, p.receiver.stats, p.useArq ? a : undefined));
    }
    this.el.maxRetries.textContent = String(a.maxRetries);
    this.el.infeasible.textContent = String(a.nackInfeasible);
    // max_retries 0 -> ARQ kapandi, kirmizi
    this.el.maxRetries.parentElement?.classList.toggle('dead', a.maxRetries === 0);
    this.updateStatusLine();
  }

  // --- yerel onizleme ---

  private previewVideo: HTMLVideoElement | null = null;
  private previewHandle: number | null = null;

  private startPreview(stream: MediaStream): void {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    this.previewVideo = video;
    const ctx = this.el.preview.getContext('2d', { alpha: false })!;

    void video.play().then(() => {
      const paint = (): void => {
        if (!this.previewVideo) return;
        const c = this.el.preview;
        if (video.videoWidth > 0 && c.width !== video.videoWidth) {
          c.width = video.videoWidth;
          c.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0, c.width, c.height);
        this.previewHandle = requestAnimationFrame(paint);
      };
      this.previewHandle = requestAnimationFrame(paint);
    });
  }

  private stopPreview(): void {
    if (this.previewHandle !== null) cancelAnimationFrame(this.previewHandle);
    this.previewHandle = null;
    if (this.previewVideo) {
      this.previewVideo.srcObject = null;
      this.previewVideo = null;
    }
  }

  /** Konsoldan tum katmanlarin ham sayaclarina bakmak icin. */
  debug(): unknown {
    const panelDump = Object.fromEntries(
      this.panels.map((p) => [
        p.id,
        {
          useFec: p.useFec,
          useArq: p.useArq,
          assembler: p.assembler.stats,
          receiver: p.receiver.stats,
          /** uc panelde AYNI olmali — ayni kayip deseni kaniti */
          receivedHash: p.assembler.receivedHash(),
        },
      ]),
    );

    return {
      running: this.running,
      fecCodec: codecName(),
      transport: this.transport
        ? { kind: this.transport.constructor.name, ready: this.transport.ready, ...this.transport.stats }
        : null,
      /** Kablodaki gercek protokol — 'udp' bekleniyor */
      wire: this.transportInfo,
      loss: {
        p: this.lossMain.getLoss(),
        model: this.lossMain.getModel(),
        txSent: this.txOrdinal,
        txDropped: this.txDropped,
        rtxSent: this.rtxOrdinal,
        rtxDropped: this.rtxDropped,
        /** gonderici tarafi desen ozeti */
        patternHash: this.lossMain.patternHash(),
      },
      rtt: {
        artificialMs: this.settings.rttMs,
        measuredMs: Math.round(this.rtt.measuredRttMs * 10) / 10,
        estMs: Math.round(this.rttEstMs() * 10) / 10,
        samples: this.rtt.samples,
      },
      delayQueue: { ...this.delayQueue.stats },
      sender: this.sender?.stats ?? null,
      arq: {
        ...this.arqStats(),
        raw: { ...this.nack.stats },
        cache: { ...this.symbolCache.stats },
        txBytes: this.txBytes,
      },
      lossLog: this.lossLog.slice(),
      panels: panelDump,
    };
  }

  /**
   * Uc panelin ayni ORIJINAL paketleri aldigini dogrular.
   * Konsoldan: kama.patternCheck()
   */
  patternCheck(): { hashes: Record<string, string>; equal: boolean } {
    const hashes: Record<string, string> = {};
    for (const p of this.panels) hashes[p.id] = p.assembler.receivedHash();
    const values = Object.values(hashes);
    return { hashes, equal: values.every((v) => v === values[0]) };
  }

  private note(msg: string): void {
    console.warn('[kama]', msg);
    this.el.errors.textContent = msg;
    this.el.errors.classList.add('visible');
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`DOM ogesi bulunamadi: #${id}`);
  return el as T;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
