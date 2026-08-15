/**
 * Yapay gecikme kuyrugu.
 *
 * Her iki yondeki datagramlar gonderim ONCESI buradan gecer. Tek yon
 * gecikmesi = artificialRttMs / 2; gidis-donus toplamda artificialRttMs
 * eder. Kuyruk hem medya hem NACK datagramlarina uygulanir — yoksa
 * ARQ'nun gidis-donusu gercekci olmaz ve deadline aritmetigi anlamsizlasir.
 *
 * SIRA KORUNUMU: gecikme degeri paket kuyruga GIRERKEN sabitlenir ve
 * kuyruk boyunca degistirilmez. Ayrica teslim zamani monoton artar
 * (max(sonTeslim, simdi + gecikme)); boylece slider calisma aninda
 * kaydirilsa bile paketler sirasi bozulmaz.
 */

export interface DelayQueueStats {
  enqueued: number;
  delivered: number;
  /** su an kuyrukta bekleyen paket */
  pending: number;
  /** kuyrugun bosaldigi ana kadar en yuksek bekleyen sayisi */
  peakPending: number;
}

export class DelayQueue {
  readonly stats: DelayQueueStats = { enqueued: 0, delivered: 0, pending: 0, peakPending: 0 };

  /**
   * Bekleyen paketler, teslim zamanina gore SIRALI.
   * deliverAt insaat geregi azalmaz, dolayisiyla dizi hep sirali kalir.
   */
  private queue: Array<{ deliverAt: number; data: Uint8Array; sink: (d: Uint8Array) => void }> = [];
  /**
   * TEK zamanlayici. Paket basina ayri setTimeout kullanmak yanlisti:
   * ayni teslim anina denk gelen iki paketin timeout suresi kendi
   * gonderim anlarina gore hesaplandigi icin sonraki paket once
   * atesleniyordu. Tek zamanlayici + sirali kuyruk FIFO'yu garanti eder.
   */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDeliverAt = 0;
  private disposed = false;

  // NOT: constructor parametre ozellikleri (private readonly x: T) Node'un
  // tip siyirma modunda calismiyor — alanlar acikca tanimlanir.
  private readonly oneWayDelayMs: () => number;
  private readonly now: () => number;

  /**
   * @param oneWayDelayMs her cagrida guncel tek yon gecikmesini dondurur
   * @param now test edilebilirlik icin saat kaynagi
   */
  constructor(oneWayDelayMs: () => number, now: () => number = () => performance.now()) {
    this.oneWayDelayMs = oneWayDelayMs;
    this.now = now;
  }

  send(data: Uint8Array, sink: (d: Uint8Array) => void): void {
    if (this.disposed) return;

    const delay = Math.max(0, this.oneWayDelayMs());

    // Gecikme yok VE kuyruk bossa dogrudan gecir — gereksiz setTimeout
    // gecikmesi eklemeyelim. Kuyrukta paket varsa sira icin kuyruga gir.
    if (delay <= 0 && this.stats.pending === 0) {
      this.stats.enqueued++;
      this.stats.delivered++;
      sink(data);
      return;
    }

    const t0 = this.now();
    const deliverAt = Math.max(this.lastDeliverAt, t0 + delay);
    this.lastDeliverAt = deliverAt;

    this.stats.enqueued++;
    this.stats.pending++;
    if (this.stats.pending > this.stats.peakPending) this.stats.peakPending = this.stats.pending;

    this.queue.push({ deliverAt, data, sink });
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null || this.queue.length === 0 || this.disposed) return;
    const wait = Math.max(0, this.queue[0].deliverAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }

  private drain(): void {
    if (this.disposed) return;
    const t = this.now();
    // 1 ms tolerans: zamanlayici erken atesleyince bosuna yeniden kurmayalim
    while (this.queue.length > 0 && this.queue[0].deliverAt <= t + 1) {
      const item = this.queue.shift()!;
      this.stats.pending--;
      this.stats.delivered++;
      item.sink(item.data);
    }
    this.arm();
  }

  /** Bekleyen her seyi iptal eder (akis durdurulurken). */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.stats.pending = 0;
    this.lastDeliverAt = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  resetStats(): void {
    this.stats.enqueued = 0;
    this.stats.delivered = 0;
    this.stats.peakPending = 0;
  }
}

/**
 * Gidis-donus suresi olcumu. Periyodik ping/pong ile olculur ve
 * yapay RTT'nin USTUNE eklenir: rttEst = artificialRttMs + measuredRttMs.
 *
 * Ping paketleri kayip enjeksiyonuna tabi DEGILDIR — olcum trafigidir,
 * kaybolursa yalnizca o tur atlanir ve tahmin gurultulenir.
 */
export class RttMeter {
  /** duzlestirilmis olcum (EWMA) */
  private smoothed = 0;
  private inflight = new Map<number, number>();
  private nextNonce = 1;

  /** son ham olcum */
  lastSampleMs = 0;
  samples = 0;

  private readonly alpha: number;
  private readonly now: () => number;

  constructor(alpha = 0.25, now: () => number = () => performance.now()) {
    this.alpha = alpha;
    this.now = now;
  }

  /** Yeni bir ping icin nonce uretir ve gonderim anini kaydeder. */
  startPing(): number {
    const nonce = this.nextNonce;
    this.nextNonce = (this.nextNonce + 1) >>> 0 || 1;
    this.inflight.set(nonce, this.now());

    // Yanit gelmeyen ping'ler birikmesin
    if (this.inflight.size > 32) {
      const oldest = this.inflight.keys().next().value;
      if (oldest !== undefined) this.inflight.delete(oldest);
    }
    return nonce;
  }

  /** Pong geldiginde cagrilir. */
  onPong(nonce: number): void {
    const sentAt = this.inflight.get(nonce);
    if (sentAt === undefined) return;
    this.inflight.delete(nonce);

    const sample = this.now() - sentAt;
    this.lastSampleMs = sample;
    this.samples++;
    this.smoothed = this.samples === 1 ? sample : this.alpha * sample + (1 - this.alpha) * this.smoothed;
  }

  get measuredRttMs(): number {
    return this.smoothed;
  }

  reset(): void {
    this.smoothed = 0;
    this.samples = 0;
    this.lastSampleMs = 0;
    this.inflight.clear();
  }
}
