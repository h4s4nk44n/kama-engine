/**
 * Kontrollu kayip ureteci. `channel.send()` ONCESI, gonderim aninda
 * uygulanir — mobilde de calisir, `tc` gerekmez.
 *
 * Iki model:
 *   iid(p)              her paket bagimsiz, olasilik p
 *   gilbert(p, r=0.632) Gilbert-Elliott; pGoodToBad = p*r/(1-p),
 *                       pBadToGood = r  (durgun kayip olasiligi = p)
 *
 * ONEMLI — DURUST KARSILASTIRMA:
 * Source paketlerinin kayip kararlari TEK bir tohumlu akistan gelir ve
 * bu akis FEC oranindan/panelden bagimsizdir. Parity paketleri AYRI bir
 * akistan karar alir. Boylece koruma orani degistiginde source kayip
 * deseni bit birebir ayni kalir; iki panel ayni deseni gorur.
 *
 * Gilbert-Elliott zinciri yalniz source paketleriyle ilerletilir; parity
 * paketleri zincirin o anki durumunu okur ama ilerletmez. Aksi hâlde
 * parity sayisi degisince source deseni kayardi.
 */

export type LossModel = 'iid' | 'gilbert';

/** Tohumlu, hizli, tekrarlanabilir PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GE_R = 0.632;

export interface LossStats {
  sourceSent: number;
  sourceDropped: number;
  paritySent: number;
  parityDropped: number;
}

export class LossInjector {
  private p = 0;
  private model: LossModel = 'iid';
  private readonly seed: number;

  /** source karar akisi — panel/FEC orani bundan etkilenmez */
  private rndSource: () => number;
  /** parity karar akisi — ayri, source desenini kaydirmaz */
  private rndParity: () => number;

  /**
   * Gilbert-Elliott durumlari: false = Good, true = Bad.
   * Source ve parity ayri zincirler kullanir — ayni durgun kayip oranina
   * ve ayni burst yapisina sahiptirler, ama biri digerini kaydirmaz.
   */
  private badSource = false;
  private badParity = false;

  readonly stats: LossStats = { sourceSent: 0, sourceDropped: 0, paritySent: 0, parityDropped: 0 };

  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this.rndSource = mulberry32(this.seed);
    this.rndParity = mulberry32(this.seed ^ 0x5bf03635);
  }

  /** Kayip orani ve model. Degisiklik akislari SIFIRLAMAZ. */
  setLoss(p: number, model: LossModel): void {
    this.p = Math.max(0, Math.min(0.95, p));
    this.model = model;
  }

  getLoss(): number {
    return this.p;
  }

  getModel(): LossModel {
    return this.model;
  }

  /** Akislari basa sar — iki kosumu birebir karsilastirmak icin. */
  reseed(): void {
    this.rndSource = mulberry32(this.seed);
    this.rndParity = mulberry32(this.seed ^ 0x5bf03635);
    this.badSource = false;
    this.badParity = false;
    this.stats.sourceSent = 0;
    this.stats.sourceDropped = 0;
    this.stats.paritySent = 0;
    this.stats.parityDropped = 0;
  }

  /**
   * true -> paket dusurulecek.
   * isParity, kararin hangi akistan alinacagini belirler.
   */
  shouldDrop(isParity: boolean): boolean {
    // Her paket icin HER ZAMAN tam bir cekilis yapilir (p=0 olsa bile).
    // Boylece akistaki konum yalnizca paket sayisina bagli kalir; kayip
    // oranini oynatmak deseni kaydirmaz.
    const r = isParity ? this.rndParity() : this.rndSource();
    const drop = this.model === 'iid' ? this.iidDecide(r) : this.gilbertDecide(r, isParity);

    if (isParity) {
      this.stats.paritySent++;
      if (drop) this.stats.parityDropped++;
    } else {
      this.stats.sourceSent++;
      if (drop) this.stats.sourceDropped++;
    }
    return drop;
  }

  private iidDecide(r: number): boolean {
    return this.p > 0 && r < this.p;
  }

  /**
   * Gilbert-Elliott: Good durumunda kayip yok, Bad durumunda kayip kesin.
   *   pGB = p*r/(1-p),  pBG = r   ->   durgun P(Bad) = pGB/(pGB+pBG) = p
   * Ortalama burst uzunlugu = 1/pBG ~ 1.58 paket.
   *
   * Source ve parity kendi zincirlerini ilerletir; boylece parity sayisi
   * degistiginde source deseni etkilenmez.
   */
  private gilbertDecide(r: number, isParity: boolean): boolean {
    const p = this.p;
    if (p <= 0) {
      if (isParity) this.badParity = false;
      else this.badSource = false;
      return false;
    }

    const pGB = Math.min(1, (p * GE_R) / (1 - p));
    const pBG = GE_R;
    const inBad = isParity ? this.badParity : this.badSource;

    // Paket, ICINDE BULUNDUGU duruma gore degerlendirilir; zincir sonra
    // ilerler. Gecisi tetikleyen paketi de kayip saymak durgun kayip
    // oranini p'nin uzerine cikarirdi.
    const drop = inBad;
    const nextBad = inBad ? !(r < pBG) : r < pGB;

    if (isParity) this.badParity = nextBad;
    else this.badSource = nextBad;
    return drop;
  }
}
