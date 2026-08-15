/**
 * Cauchy generator matrisi.
 *
 *   G[r][j] = inv( (K + r) XOR j )      0 <= r < M,  0 <= j < K
 *
 * (K+r) >= K > j oldugundan XOR asla 0 olmaz; inv() her zaman tanimli.
 *
 * Cauchy matrisinin HER kare altmatrisi tekil degildir. Dolayisiyla
 * [I ; G] sistematik uretec matrisinin her KxK altmatrisi de tersinirdir
 * (MDS). Vandermonde bu garantiyi vermez — buyuk K+M'de tekil altmatris
 * uretir, bu yuzden kullanilmiyor.
 */

import { inv } from './gf256.ts';

/** GF(256) sinirlari: X kumesi {K..K+M-1}, Y kumesi {0..K-1}, hepsi < 256 olmali. */
export const MAX_K = 80;
export const MAX_M = 32;

const cache = new Map<number, Uint8Array[]>();

/**
 * (K,M) icin MxK Cauchy matrisi dondurur. Sonuc onbeklenir — her grupta
 * yeniden uretilmez. Donen diziyi DEGISTIRME (paylasimli referans).
 */
export function generatorMatrix(K: number, M: number): Uint8Array[] {
  if (!Number.isInteger(K) || K < 1 || K > MAX_K) {
    throw new RangeError(`cauchy: gecersiz K=${K} (1..${MAX_K})`);
  }
  if (!Number.isInteger(M) || M < 0 || M > MAX_M) {
    throw new RangeError(`cauchy: gecersiz M=${M} (0..${MAX_M})`);
  }
  if (K + M > 256) {
    throw new RangeError(`cauchy: K+M=${K + M} GF(256) alfabesini asiyor`);
  }

  const key = (K << 8) | M;
  const hit = cache.get(key);
  if (hit) return hit;

  const G: Uint8Array[] = new Array(M);
  for (let r = 0; r < M; r++) {
    const row = new Uint8Array(K);
    const x = K + r;
    for (let j = 0; j < K; j++) {
      row[j] = inv(x ^ j); // XOR = GF(2^8) uzerinde cikarma
    }
    G[r] = row;
  }

  cache.set(key, G);
  return G;
}

/**
 * Sistematik uretec matrisinin tek bir satirini dondurur.
 * index < K  -> birim satir (source sembolu)
 * index >= K -> G[index - K] (parity sembolu)
 */
export function codeRow(index: number, K: number, M: number): Uint8Array {
  if (index < 0 || index >= K + M) {
    throw new RangeError(`cauchy: index ${index} kod blogu disinda (N=${K + M})`);
  }
  if (index < K) {
    const row = new Uint8Array(K);
    row[index] = 1;
    return row;
  }
  return generatorMatrix(K, M)[index - K];
}
