/**
 * Reed-Solomon — YALNIZ SILINTI (erasure) kodlamasi.
 *
 * Kayip indeksleri biliniyor (paket ya geldi ya gelmedi), dolayisiyla
 * sendrom hesabi, hata konum polinomu ve Chien aramasi YOK.
 * Tek is: KxK altmatrisin GF(256) uzerinde tersi.
 *
 * Sistematik kod:  codeword = [ source(0..K-1) ; parity(K..K+M-1) ]
 */

import { mulScaleXor, inv as gfInv, MUL_TABLE } from './gf256.ts';
import { generatorMatrix, codeRow } from './cauchy.ts';

export class InsufficientSymbols extends Error {
  readonly have: number;
  readonly need: number;
  constructor(have: number, need: number) {
    super(`RS: yetersiz sembol — ${have} geldi, ${need} gerekli`);
    this.name = 'InsufficientSymbols';
    this.have = have;
    this.need = need;
  }
}

export class SingularMatrix extends Error {
  constructor(msg: string) {
    super(`RS: tekil matris — ${msg}`);
    this.name = 'SingularMatrix';
  }
}

export interface PresentSymbol {
  /** 0..K-1 source blok indeksi, K..K+M-1 parity indeksi */
  index: number;
  symbol: Uint8Array;
}

/**
 * parity[r] = XOR_j  G[r][j] * source[j]
 * Tum source sembolleri ayni uzunlukta olmali (symbol_size).
 */
export function encode(source: Uint8Array[], M: number): Uint8Array[] {
  const K = source.length;
  if (K === 0) throw new RangeError('RS: bos source');
  if (M === 0) return [];

  const size = source[0].length;
  for (let j = 1; j < K; j++) {
    if (source[j].length !== size) {
      throw new RangeError(`RS: sembol boyu tutarsiz (blok ${j}: ${source[j].length} != ${size})`);
    }
  }

  const G = generatorMatrix(K, M);
  const parity: Uint8Array[] = new Array(M);
  for (let r = 0; r < M; r++) {
    const p = new Uint8Array(size);
    const row = G[r];
    for (let j = 0; j < K; j++) mulScaleXor(p, source[j], row[j]);
    parity[r] = p;
  }
  return parity;
}

/**
 * Gelen sembollerden K adet source sembolunu geri kurar.
 *
 * 1. present indekse gore siralanir, EN KUCUK indeksli K tanesi secilir
 *    (deterministik — ayni girdi hep ayni matrisi verir).
 * 2. A = secilen satirlar (index<K ise birim satir, degilse G[index-K]).
 * 3. A, GF(256) uzerinde Gauss-Jordan ile terslenir.
 * 4. source[i] = XOR_j  Ainv[i][j] * y[j]
 */
export function decode(present: PresentSymbol[], K: number, M: number): Uint8Array[] {
  if (present.length < K) throw new InsufficientSymbols(present.length, K);

  const sorted = present.slice().sort((a, b) => a.index - b.index);
  const chosen = sorted.slice(0, K);

  const size = chosen[0].symbol.length;
  for (let j = 1; j < K; j++) {
    if (chosen[j].symbol.length !== size) {
      throw new RangeError('RS: decode girdisinde sembol boyu tutarsiz');
    }
  }

  // Hizli yol: en kucuk K indeks tam olarak 0..K-1 ise hicbir sey kaybolmamis.
  let identical = true;
  for (let i = 0; i < K; i++) {
    if (chosen[i].index !== i) {
      identical = false;
      break;
    }
  }
  if (identical) return chosen.map((c) => c.symbol);

  const A: Uint8Array[] = new Array(K);
  for (let i = 0; i < K; i++) A[i] = codeRow(chosen[i].index, K, M).slice();

  const Ainv = invertMatrix(A, K);

  const out: Uint8Array[] = new Array(K);
  for (let i = 0; i < K; i++) {
    const d = new Uint8Array(size);
    const row = Ainv[i];
    for (let j = 0; j < K; j++) mulScaleXor(d, chosen[j].symbol, row[j]);
    out[i] = d;
  }
  return out;
}

/**
 * GF(256) uzerinde Gauss-Jordan ile KxK matris tersi.
 * Girdi dizisi yerinde bozulur; cagiran kopya vermeli.
 */
export function invertMatrix(A: Uint8Array[], K: number): Uint8Array[] {
  const I: Uint8Array[] = new Array(K);
  for (let i = 0; i < K; i++) {
    const row = new Uint8Array(K);
    row[i] = 1;
    I[i] = row;
  }

  for (let col = 0; col < K; col++) {
    // Pivot ara
    let pivot = -1;
    for (let r = col; r < K; r++) {
      if (A[r][col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot < 0) throw new SingularMatrix(`sutun ${col} icin pivot yok`);

    if (pivot !== col) {
      const ta = A[pivot];
      A[pivot] = A[col];
      A[col] = ta;
      const ti = I[pivot];
      I[pivot] = I[col];
      I[col] = ti;
    }

    // Pivot satirini 1'e olcekle:  satir *= inv(pivotDeger)
    const pv = A[col][col];
    if (pv !== 1) {
      const s = gfInv(pv);
      scaleRow(A[col], s);
      scaleRow(I[col], s);
    }

    // Diger tum satirlardan bu sutunu ele
    for (let r = 0; r < K; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      mulScaleXor(A[r], A[col], f);
      mulScaleXor(I[r], I[col], f);
    }
  }

  return I;
}

// --- yerel yardimci ---

function scaleRow(row: Uint8Array, c: number): void {
  if (c === 1) return;
  const t = MUL_TABLE[c];
  for (let i = 0; i < row.length; i++) row[i] = t[row[i]];
}
