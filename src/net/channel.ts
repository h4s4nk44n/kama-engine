/**
 * RTCDataChannel sarmalayici.
 *
 * Kanal { ordered: false, maxRetransmits: 0 } ile acilir — bu onu gercek
 * bir guvenilmez datagram tasiyicisi yapar; SCTP retransmit devreye
 * girmez, sira garantisi yoktur. Kayip olcumunun anlamli olmasi buna bagli.
 *
 * MEDYA TRACK'I YOK: pc.addTrack / pc.ontrack hicbir yerde kullanilmaz.
 * Kullanilsa tarayicinin kendi medya motoru devreye girer ve bu kod hic
 * kosmaz.
 *
 * bufferedAmount 1 MB'i asarsa gonderim duraklatilir (backpressure);
 * aksi hâlde encoder kanali bogar ve olculen kayip anlamsizlasir.
 */

export const DATA_CHANNEL_LABEL = 'kama';
export const CONTROL_CHANNEL_LABEL = 'kama-ctrl';

export const HIGH_WATER_MARK = 1 << 20; // 1 MB
export const LOW_WATER_MARK = 1 << 18; // 256 KB

export interface ChannelStats {
  sent: number;
  bytesSent: number;
  /** backpressure yuzunden dusurulen datagram */
  backpressureDropped: number;
}

/** Datagram tasiyicisi — gercek DataChannel ve loopback ayni arayuzu paylasir. */
export interface DatagramTransport {
  send(bytes: Uint8Array): boolean;
  readonly ready: boolean;
  onDatagram: ((bytes: Uint8Array) => void) | null;
  close(): void;
  readonly stats: ChannelStats;
}

export class DataChannelTransport implements DatagramTransport {
  onDatagram: ((bytes: Uint8Array) => void) | null = null;
  readonly stats: ChannelStats = { sent: 0, bytesSent: 0, backpressureDropped: 0 };

  private paused = false;

  constructor(private readonly dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
    dc.addEventListener('bufferedamountlow', () => {
      this.paused = false;
    });
    dc.addEventListener('message', (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) this.onDatagram?.(new Uint8Array(data));
    });
  }

  get ready(): boolean {
    return this.dc.readyState === 'open';
  }

  send(bytes: Uint8Array): boolean {
    if (this.dc.readyState !== 'open') return false;

    if (this.paused) {
      this.stats.backpressureDropped++;
      return false;
    }
    if (this.dc.bufferedAmount > HIGH_WATER_MARK) {
      // Gercek zamanli akista kuyruga almanin anlami yok — en yenisi
      // en degerlisi. Duraklat ve bu paketi dusur.
      this.paused = true;
      this.stats.backpressureDropped++;
      return false;
    }

    try {
      this.dc.send(bytes as unknown as ArrayBufferView as never);
    } catch {
      this.stats.backpressureDropped++;
      return false;
    }
    this.stats.sent++;
    this.stats.bytesSent += bytes.length;
    return true;
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      /* zaten kapali */
    }
  }
}

/**
 * Loopback tasiyici — esles yokken motoru tek tarayicida uctan uca
 * kosturmak icin. Datagramlar yine tam boru hattindan (fragmentation,
 * FEC, kayip enjeksiyonu, RS decode) gecer; yalnizca fiziksel ag yoktur.
 */
export class LoopbackTransport implements DatagramTransport {
  onDatagram: ((bytes: Uint8Array) => void) | null = null;
  readonly stats: ChannelStats = { sent: 0, bytesSent: 0, backpressureDropped: 0 };
  readonly ready = true;

  private queue: Uint8Array[] = [];
  private scheduled = false;
  private closed = false;

  send(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    this.stats.sent++;
    this.stats.bytesSent += bytes.length;
    // Kopya: cagiran tamponu yeniden kullanabilir
    this.queue.push(bytes.slice());
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.drain());
    }
    return true;
  }

  private drain(): void {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    for (const b of batch) this.onDatagram?.(b);
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }
}
