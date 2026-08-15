/**
 * GF(2^8) aritmetigi.
 *
 * Indirgenemez polinom: 0x11D  (x^8 + x^4 + x^3 + x^2 + 1)
 * Ureteç (generator):   0x02
 *
 * Tum tablolar modul yuklenirken bir kez uretilir. Sicak dongude
 * mul() cagrisi yerine onceden uretilmis 256x256 carpim tablosundan
 * lookup yapilir; encode ~20x hizlanir.
 */

export const POLY = 0x11d;

/** exp tablosu 512 uzunluk — katlanmis, boylece LOG[a]+LOG[b] icin mod 255 gerekmez. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** Tablolara disaridan salt-okunur erisim (testler icin). */
export function expOf(i: number): number {
  return EXP[i];
}
export function logOf(a: number): number {
  if (a === 0) throw new Error('gf256: log(0) tanimsiz');
  return LOG[a];
}

export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function div(a: number, b: number): number {
  if (b === 0) throw new Error('gf256: sifira bolme');
  if (a === 0) return 0;
  return EXP[LOG[a] - LOG[b] + 255];
}

export function inv(a: number): number {
  if (a === 0) throw new Error('gf256: inv(0) tanimsiz');
  return EXP[255 - LOG[a]];
}

/**
 * MUL_TABLE[c][x] === mul(c, x).
 * 256 satir x 256 bayt = 64 KB. Bir kez uretilir.
 */
export const MUL_TABLE: Uint8Array[] = (() => {
  const table: Uint8Array[] = new Array(256);
  for (let c = 0; c < 256; c++) {
    const row = new Uint8Array(256);
    if (c !== 0) {
      const lc = LOG[c];
      for (let x = 1; x < 256; x++) row[x] = EXP[lc + LOG[x]];
    }
    table[c] = row;
  }
  return table;
})();

/**
 * dst ^= c * src   (sicak dongu, tek gecis, tablo lookup)
 * dst ve src ayni uzunlukta olmali.
 */
export function mulScaleXor(dst: Uint8Array, src: Uint8Array, c: number): void {
  if (c === 0) return;
  const n = dst.length;
  if (c === 1) {
    // c=1 icin lookup bile gereksiz; saf XOR
    for (let i = 0; i < n; i++) dst[i] ^= src[i];
    return;
  }
  const t = MUL_TABLE[c];
  for (let i = 0; i < n; i++) dst[i] ^= t[src[i]];
}

/** dst = c * src   (XOR biriktirmeden, dogrudan atama) */
export function mulScaleSet(dst: Uint8Array, src: Uint8Array, c: number): void {
  const n = dst.length;
  if (c === 0) {
    dst.fill(0);
    return;
  }
  const t = MUL_TABLE[c];
  for (let i = 0; i < n; i++) dst[i] = t[src[i]];
}
