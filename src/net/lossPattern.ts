/**
 * Uc panel icin TEK kayip deseni kaynagi.
 *
 * Karar paket SIRA NUMARASINA (ordinal) baglidir, cagri sirasina degil.
 * Ayni ordinal kac kez sorulursa sorulsun ayni cevabi verir (memoize),
 * dolayisiyla uc panel ayni paketi ayni sekilde kaybeder.
 *
 * Gilbert-Elliott modunda durum makinesi de TEKTIR — uc panel ayni
 * burst'leri yasar.
 *
 * Kayip enjeksiyonu `channel.send()` ONCESI uygulanir; mobilde de
 * calisir, `tc` gerekmez.
 */

export type LossModel = 'iid' | 'gilbert';

export const GE_R = 0.632;

/** Pencere boyu: bu kadar gerideki ordinal'ler hatirlanir. */
const MEMO_SIZE = 16384;

// enum degil sabit — Node'un tip siyirma modu enum'u desteklemiyor
const UNKNOWN = 0;
const LOST = 1;
const KEPT = 2;

/** Tohumlu, hizli, tekrarlanabilir PRNG. */
function xorshift32(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** (seed, ordinal) -> [0,1) — i.i.d. icin rastgele erisimli. */
function hashUniform(seed: number, ordinal: number): number {
  let h = (seed ^ Math.imul(ordinal + 1, 0x9e3779b1)) >>> 0;
  h = xorshift32(h);
  h = xorshift32(h ^ Math.imul(ordinal + 0x85ebca6b, 0xc2b2ae35));
  return h / 4294967296;
}

export interface LossPatternStats {
  queried: number;
  lost: number;
}

export class LossPattern {
  readonly stats: LossPatternStats = { queried: 0, lost: 0 };

  private readonly seed: number;
  private p = 0;
  private model: LossModel = 'iid';

  /** ring buffer: ordinal % MEMO_SIZE -> Decision */
  private memo = new Uint8Array(MEMO_SIZE);
  /** memo[i]'nin hangi ordinal'e ait oldugunu dogrulamak icin */
  private memoOrdinal = new Int32Array(MEMO_SIZE).fill(-1);

  /** siradaki degerlendirilecek ordinal (GE zinciri buraya kadar ilerledi) */
  private nextOrdinal = 0;
  /** Gilbert-Elliott durumu: false = Good, true = Bad */
  private bad = false;
  /** tum kararlar uzerinde donen FNV-1a — uc panelin desenini karsilastirmak icin */
  private hash = 0x811c9dc5;

  constructor(seed = 0x6b616d61) {
    this.seed = seed >>> 0;
  }

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

  /**
   * Bu ordinal'e sahip paket dusurulecek mi?
   * Memoize — ayni ordinal her sorulusta ayni cevabi verir.
   */
  isLost(ordinal: number): boolean {
    this.stats.queried++;

    // Ileriye dogru sirali degerlendir (GE zinciri sirali olmak zorunda)
    while (this.nextOrdinal <= ordinal) {
      this.evaluate(this.nextOrdinal);
      this.nextOrdinal++;
    }

    const slot = ((ordinal % MEMO_SIZE) + MEMO_SIZE) % MEMO_SIZE;
    const decision = this.memoOrdinal[slot] === ordinal ? this.memo[slot] : UNKNOWN;

    // Pencerenin cok gerisinde kalan ordinal — pratikte olmaz
    if (decision === UNKNOWN) return false;

    const lost = decision === LOST;
    if (lost) this.stats.lost++;
    return lost;
  }

  private evaluate(ordinal: number): void {
    let lost: boolean;

    if (this.p <= 0) {
      lost = false;
      this.bad = false;
    } else if (this.model === 'iid') {
      lost = hashUniform(this.seed, ordinal) < this.p;
    } else {
      // Gilbert-Elliott:
      //   pGB = p*r/(1-p),  pBG = r  ->  durgun P(Bad) = p
      // Paket ICINDE BULUNDUGU duruma gore degerlendirilir, zincir sonra
      // ilerler. Gecisi tetikleyen paketi de kayip saymak durgun orani
      // p'nin uzerine cikarirdi.
      const pGB = Math.min(1, (this.p * GE_R) / (1 - this.p));
      const r = hashUniform(this.seed, ordinal);
      lost = this.bad;
      this.bad = this.bad ? !(r < GE_R) : r < pGB;
    }

    const slot = ((ordinal % MEMO_SIZE) + MEMO_SIZE) % MEMO_SIZE;
    this.memo[slot] = lost ? LOST : KEPT;
    this.memoOrdinal[slot] = ordinal;

    // FNV-1a
    this.hash = Math.imul(this.hash ^ (lost ? 1 : 0), 0x01000193) >>> 0;
  }

  /**
   * Su ana kadar uretilen tum kararlarin ozeti. Uc panelin ayni deseni
   * gordugunu dogrulamak icin konsola basilir.
   */
  patternHash(): string {
    return this.hash.toString(16).padStart(8, '0');
  }

  /** Kac karar uretildi (ordinal ilerlemesi). */
  get evaluated(): number {
    return this.nextOrdinal;
  }

  reset(): void {
    this.memo.fill(UNKNOWN);
    this.memoOrdinal.fill(-1);
    this.nextOrdinal = 0;
    this.bad = false;
    this.hash = 0x811c9dc5;
    this.stats.queried = 0;
    this.stats.lost = 0;
  }
}
