/**
 * WebSocket sinyallesme istemcisi + peer kurulumu.
 *
 * Tek oda, iki esles. Sunucu offer/answer/ICE mesajlarini oldugu gibi
 * karsi tarafa iletir.
 *
 * DIKKAT: pc.addTrack / pc.ontrack HIC KULLANILMAZ. Tum medya
 * RTCDataChannel uzerinden, kendi paket katmanimizla tasinir.
 */

import {
  DataChannelTransport,
  DATA_CHANNEL_LABEL,
  CONTROL_CHANNEL_LABEL,
  type DatagramTransport,
} from './channel.ts';

export type PeerState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'closed' | 'failed';

/** Secilen ICE aday ciftinden okunan gercek tasima bilgisi. */
export interface TransportInfo {
  /** 'udp' | 'tcp' — medyanin kablo uzerindeki protokolu */
  protocol: string;
  /** TURN uzerinden gidiliyorsa relay protokolu */
  relayProtocol?: string;
  localType?: string;
  remoteType?: string;
  localAddress?: string;
  remoteAddress?: string;
  remotePort?: number;
  /** tarayicinin olctugu gercek ag RTT'si */
  rttMs?: number;
  dtlsState?: string;
  sctpState?: string;
}

export interface PeerEvents {
  onState: (state: PeerState, detail?: string) => void;
  /** Guvenilmez medya kanali acildi */
  onTransport: (t: DatagramTransport) => void;
  /** Guvenilir kontrol kanalindan JSON mesaj geldi */
  onControl: (msg: unknown) => void;
}

interface SignalMessage {
  type: string;
  [k: string]: unknown;
}

const ICE_SERVERS: RTCIceServer[] = [
  // Ayni LAN'da STUN gereksiz; yine de host adaylari disinda bir sey
  // gerekirse diye bos birakiliyor. Harici sunucuya bagimlilik yok.
];

export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class PeerSession {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private mediaDc: RTCDataChannel | null = null;
  private controlDc: RTCDataChannel | null = null;
  private isInitiator = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;
  private disposed = false;

  constructor(private readonly ev: PeerEvents) {}

  connect(url = signalingUrl()): void {
    this.ev.onState('waiting', 'sinyallesme sunucusuna baglaniliyor');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.ev.onState('waiting', 'eslesme bekleniyor');
      this.sendSignal({ type: 'join', room: 'kama' });
    });

    ws.addEventListener('message', (e) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      void this.handleSignal(msg);
    });

    ws.addEventListener('close', () => {
      if (!this.disposed) this.ev.onState('closed', 'sinyallesme kapandi');
    });

    ws.addEventListener('error', () => {
      this.ev.onState('failed', 'sinyallesme hatasi');
    });
  }

  /**
   * Medyanin kablo uzerinde HANGI protokolle gittigini soyler.
   *
   * DataChannel yigini: uygulama -> SCTP -> DTLS -> **UDP**.
   * TCP yalnizca sinyallesmede (WebSocket) kullanilir; medya ona hic
   * dokunmaz. Bunu tahmin etmek yerine tarayicinin kendi istatistiklerinden
   * okuyoruz: secilen ICE aday ciftinin protokolu.
   *
   * TURN/TCP yedegine dusulurse burada 'tcp' gorunur — bu kurulumda
   * ICE sunucusu tanimli olmadigi icin yalniz host adaylari, yani dogrudan
   * UDP kullanilir.
   */
  async transportInfo(): Promise<TransportInfo | null> {
    if (!this.pc) return null;

    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return null;
    }

    type PairStats = RTCStats & {
      state?: string;
      nominated?: boolean;
      localCandidateId?: string;
      remoteCandidateId?: string;
      currentRoundTripTime?: number;
    };
    type CandStats = RTCStats & {
      protocol?: string;
      candidateType?: string;
      address?: string;
      port?: number;
      relayProtocol?: string;
    };

    let best: PairStats | null = null;
    report.forEach((r) => {
      const s = r as PairStats;
      if (s.type !== 'candidate-pair' || s.state !== 'succeeded') return;
      // Nominated cift onceliklidir
      if (!best || (s.nominated && !best.nominated)) best = s;
    });
    if (!best) return null;

    const pair: PairStats = best;
    const local = pair.localCandidateId ? (report.get(pair.localCandidateId) as CandStats | undefined) : undefined;
    const remote = pair.remoteCandidateId ? (report.get(pair.remoteCandidateId) as CandStats | undefined) : undefined;

    return {
      protocol: (local?.protocol ?? 'bilinmiyor').toLowerCase(),
      relayProtocol: local?.relayProtocol,
      localType: local?.candidateType,
      remoteType: remote?.candidateType,
      localAddress: local?.address,
      remoteAddress: remote?.address,
      remotePort: remote?.port,
      rttMs:
        pair.currentRoundTripTime !== undefined
          ? Math.round(pair.currentRoundTripTime * 1000 * 10) / 10
          : undefined,
      dtlsState: this.pc.sctp?.transport?.state,
      sctpState: this.pc.sctp?.state,
    };
  }

  /** Kontrol kanalindan JSON gonderir (guvenilir, sirali). */
  sendControl(msg: unknown): void {
    if (this.controlDc?.readyState === 'open') {
      this.controlDc.send(JSON.stringify(msg));
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.mediaDc?.close();
      this.controlDc?.close();
      this.pc?.close();
      this.ws?.close();
    } catch {
      /* yoksay */
    }
  }

  /** Mevcut peer baglantisini tamamen birakir; yeniden eslesmeye hazirlar. */
  private resetPeer(): void {
    try {
      this.mediaDc?.close();
      this.controlDc?.close();
      this.pc?.close();
    } catch {
      /* zaten kapali */
    }
    this.mediaDc = null;
    this.controlDc = null;
    this.pc = null;
    this.pendingIce = [];
    this.remoteDescSet = false;
  }

  private sendSignal(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        // Ikinci esles odaya girdi. Esles yeniden yuklendiyse elimizde
        // olu bir RTCPeerConnection kalmis olabilir — her 'ready' temiz
        // sayfadan baslar.
        this.resetPeer();
        this.isInitiator = Boolean(msg.initiator);
        this.ev.onState('connecting', this.isInitiator ? 'teklif hazirlaniyor' : 'teklif bekleniyor');
        this.createPeer();
        if (this.isInitiator) await this.makeOffer();
        break;
      }
      case 'offer': {
        if (!this.pc) this.createPeer();
        await this.pc!.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
        this.remoteDescSet = true;
        await this.flushIce();
        const answer = await this.pc!.createAnswer();
        await this.pc!.setLocalDescription(answer);
        this.sendSignal({ type: 'answer', sdp: this.pc!.localDescription });
        break;
      }
      case 'answer': {
        if (!this.pc) return;
        await this.pc.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
        this.remoteDescSet = true;
        await this.flushIce();
        break;
      }
      case 'ice': {
        const cand = msg.candidate as RTCIceCandidateInit | null;
        if (!cand) return;
        if (!this.pc || !this.remoteDescSet) {
          this.pendingIce.push(cand);
        } else {
          try {
            await this.pc.addIceCandidate(cand);
          } catch {
            /* gec/yinelenen aday */
          }
        }
        break;
      }
      case 'peer-left': {
        this.resetPeer();
        this.ev.onState('waiting', 'esles ayrildi');
        break;
      }
      case 'evicted': {
        // Baska bir cihaz odaya girdi ve bizi dusurdu. Kendiliginden
        // geri girmeye CALISMA — yoksa iki sekme birbirini surekli atar.
        this.resetPeer();
        this.ev.onState('closed', 'baska bir cihaz baglandi — bu sekme devre disi');
        break;
      }
      case 'full': {
        this.ev.onState('failed', 'oda dolu (iki esles zaten bagli)');
        break;
      }
    }
  }

  private async flushIce(): Promise<void> {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) {
      try {
        await this.pc!.addIceCandidate(c);
      } catch {
        /* yoksay */
      }
    }
  }

  private createPeer(): void {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.sendSignal({ type: 'ice', candidate: e.candidate.toJSON() });
    });

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed') this.ev.onState('failed', 'ICE baglantisi kurulamadi');
      else if (s === 'disconnected') this.ev.onState('connecting', 'baglanti kesildi, toparlaniyor');
    });

    if (this.isInitiator) {
      // GUVENILMEZ datagram kanali — retransmit yok, sira yok.
      const media = pc.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      this.attachMedia(media);

      // Kontrol kanali guvenilir: slider degerlerini eslese aynen tasir.
      const ctrl = pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
      this.attachControl(ctrl);
    } else {
      pc.addEventListener('datachannel', (e) => {
        if (e.channel.label === DATA_CHANNEL_LABEL) this.attachMedia(e.channel);
        else if (e.channel.label === CONTROL_CHANNEL_LABEL) this.attachControl(e.channel);
      });
    }
  }

  private attachMedia(dc: RTCDataChannel): void {
    this.mediaDc = dc;
    dc.addEventListener('open', () => {
      this.ev.onState('connected', 'veri kanali acik');
      this.ev.onTransport(new DataChannelTransport(dc));
    });
    dc.addEventListener('close', () => {
      this.ev.onState('closed', 'veri kanali kapandi');
    });
  }

  private attachControl(dc: RTCDataChannel): void {
    this.controlDc = dc;
    dc.addEventListener('message', (e) => {
      try {
        this.ev.onControl(JSON.parse(String(e.data)));
      } catch {
        /* yoksay */
      }
    });
  }

  private async makeOffer(): Promise<void> {
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.sendSignal({ type: 'offer', sdp: this.pc!.localDescription });
  }
}
