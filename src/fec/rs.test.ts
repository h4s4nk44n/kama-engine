/**
 * FEC cekirdegi testleri — node:test ile, harici cerceve yok.
 *   npm run test:fec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mul, inv, div, expOf, logOf, MUL_TABLE, mulScaleXor } from './gf256.ts';
import { generatorMatrix, codeRow } from './cauchy.ts';
import { encode, decode, invertMatrix, InsufficientSymbols } from './rs.ts';

// --- tekrarlanabilir PRNG (Math.random yok, testler deterministik) ---
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

// ============================================================
// 1. EXP[LOG[x]] === x
// ============================================================
test('gf256: EXP[LOG[x]] === x, tum x != 0 icin', () => {
  for (let x = 1; x < 256; x++) {
    assert.equal(expOf(logOf(x)), x, `x=${x}`);
  }
});

test('gf256: MUL_TABLE mul() ile birebir tutarli', () => {
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      assert.equal(MUL_TABLE[a][b], mul(a, b), `${a}*${b}`);
    }
  }
});

test('gf256: carpma degismeli ve dagilma ozelligi saglaniyor', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 5000; i++) {
    const a = Math.floor(rnd() * 256);
    const b = Math.floor(rnd() * 256);
    const c = Math.floor(rnd() * 256);
    assert.equal(mul(a, b), mul(b, a));
    // a*(b+c) === a*b + a*c   (GF(2^8)'de toplama = XOR)
    assert.equal(mul(a, b ^ c), mul(a, b) ^ mul(a, c));
  }
});

// ============================================================
// 2. mul(a, inv(a)) === 1
// ============================================================
test('gf256: mul(a, inv(a)) === 1, tum a != 0 icin', () => {
  for (let a = 1; a < 256; a++) {
    assert.equal(mul(a, inv(a)), 1, `a=${a}`);
  }
});

test('gf256: div(a,b) * b === a', () => {
  for (let a = 0; a < 256; a++) {
    for (let b = 1; b < 256; b++) {
      assert.equal(mul(div(a, b), b), a, `${a}/${b}`);
    }
  }
});

// ============================================================
// 3. inv(0) throw ediyor
// ============================================================
test('gf256: inv(0) ve div(x,0) throw ediyor', () => {
  assert.throws(() => inv(0), /inv\(0\)/);
  assert.throws(() => div(5, 0), /sifira bolme/);
  assert.throws(() => logOf(0), /log\(0\)/);
});

test('gf256: mulScaleXor, c=0 ve c=1 ozel yollari dogru', () => {
  const dst = Uint8Array.from([1, 2, 3, 4]);
  const src = Uint8Array.from([9, 8, 7, 6]);

  const keep = dst.slice();
  mulScaleXor(dst, src, 0);
  assert.deepEqual(dst, keep, 'c=0 dst degismemeli');

  mulScaleXor(dst, src, 1);
  assert.deepEqual(dst, Uint8Array.from([1 ^ 9, 2 ^ 8, 3 ^ 7, 4 ^ 6]));

  // genel c: eleman eleman mul() ile karsilastir
  const d2 = Uint8Array.from([10, 20, 30, 40]);
  const ref = Uint8Array.from(d2.map((v, i) => v ^ mul(37, src[i])));
  mulScaleXor(d2, src, 37);
  assert.deepEqual(d2, ref);
});

// ============================================================
// Cauchy matrisi
// ============================================================
test('cauchy: G[r][j] = inv((K+r) XOR j) ve sifir icermiyor', () => {
  const K = 6;
  const M = 4;
  const G = generatorMatrix(K, M);
  assert.equal(G.length, M);
  for (let r = 0; r < M; r++) {
    assert.equal(G[r].length, K);
    for (let j = 0; j < K; j++) {
      assert.equal(G[r][j], inv((K + r) ^ j), `G[${r}][${j}]`);
      assert.notEqual(G[r][j], 0, 'Cauchy girdisi hicbir zaman 0 olamaz');
    }
  }
});

test('cauchy: onbellek ayni referansi donduruyor', () => {
  assert.equal(generatorMatrix(16, 8), generatorMatrix(16, 8));
});

test('cauchy: sinir disi (K,M) reddediliyor', () => {
  assert.throws(() => generatorMatrix(0, 4), /gecersiz K/);
  assert.throws(() => generatorMatrix(81, 4), /gecersiz K/);
  assert.throws(() => generatorMatrix(16, 33), /gecersiz M/);
});

// ============================================================
// 4. MDS TAM TARAMA: C(N,K) altmatrisin TAMAMI tersinir
// ============================================================

/** k elemanli tum alt kumeleri uretir (leksikografik). */
function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Secilen satirlardan KxK matrisi kur ve tersinir mi diye bak. */
function submatrixInvertible(rows: number[], K: number, M: number): boolean {
  const A = rows.map((r) => codeRow(r, K, M).slice());
  try {
    invertMatrix(A, K);
    return true;
  } catch {
    return false;
  }
}

/** Ters gercekten dogru mu: A * Ainv === I */
function verifyInverse(rows: number[], K: number, M: number): boolean {
  const A = rows.map((r) => codeRow(r, K, M).slice());
  const Ainv = invertMatrix(
    rows.map((r) => codeRow(r, K, M).slice()),
    K,
  );
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      let acc = 0;
      for (let t = 0; t < K; t++) acc ^= mul(A[i][t], Ainv[t][j]);
      if (acc !== (i === j ? 1 : 0)) return false;
    }
  }
  return true;
}

const FULL_SCAN: Array<[number, number]> = [
  [2, 3],
  [4, 4],
  [6, 4],
  [6, 5],
];

for (const [K, M] of FULL_SCAN) {
  test(`MDS tam tarama (K=${K}, M=${M}): C(${K + M},${K}) altmatrisin tamami tersinir`, () => {
    const N = K + M;
    let count = 0;
    for (const rows of combinations(N, K)) {
      assert.ok(submatrixInvertible(rows, K, M), `tekil altmatris: [${rows.join(',')}]`);
      assert.ok(verifyInverse(rows, K, M), `A*Ainv != I: [${rows.join(',')}]`);
      count++;
    }
    // C(N,K) sayisini dogrula
    let expected = 1;
    for (let i = 0; i < K; i++) expected = (expected * (N - i)) / (i + 1);
    assert.equal(count, Math.round(expected), 'taranan altmatris sayisi');
  });
}

// ============================================================
// 5. MDS ORNEKLEME: buyuk (K,M) icin 300 rastgele altmatris
// ============================================================
const SAMPLED: Array<[number, number]> = [
  [16, 13],
  [32, 8],
  [80, 24],
];

for (const [K, M] of SAMPLED) {
  test(`MDS ornekleme (K=${K}, M=${M}): 300 rastgele altmatris tersinir`, () => {
    const N = K + M;
    const rnd = mulberry32(K * 1000 + M);
    for (let trial = 0; trial < 300; trial++) {
      // N icinden K satiri Fisher-Yates ile sec
      const pool = Array.from({ length: N }, (_, i) => i);
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
      }
      const rows = pool.slice(0, K).sort((a, b) => a - b);
      assert.ok(submatrixInvertible(rows, K, M), `tekil altmatris: [${rows.join(',')}]`);
    }
  });
}

// ============================================================
// 6. UCTAN UCA: her (K,M) icin 60 kosum, tam M silinti
// ============================================================
const E2E: Array<[number, number]> = [
  [2, 3],
  [4, 4],
  [6, 4],
  [6, 5],
  [16, 13],
  [32, 8],
  [80, 24],
];

function randomSymbols(K: number, size: number, rnd: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < K; i++) {
    const s = new Uint8Array(size);
    for (let b = 0; b < size; b++) s[b] = Math.floor(rnd() * 256);
    out.push(s);
  }
  return out;
}

for (const [K, M] of E2E) {
  test(`uctan uca (K=${K}, M=${M}): 60 kosum, tam ${M} silinti, birebir esit`, () => {
    const rnd = mulberry32(K * 7919 + M * 104729);
    const N = K + M;
    const size = 64;

    for (let run = 0; run < 60; run++) {
      const source = randomSymbols(K, size, rnd);
      const parity = encode(source, M);
      assert.equal(parity.length, M);

      const codeword = source.concat(parity);

      // Tam M adet silinti sec
      const pool = Array.from({ length: N }, (_, i) => i);
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
      }
      const erased = new Set(pool.slice(0, M));

      const present = [];
      for (let i = 0; i < N; i++) {
        if (!erased.has(i)) present.push({ index: i, symbol: codeword[i] });
      }
      assert.equal(present.length, K);

      const recovered = decode(present, K, M);
      assert.equal(recovered.length, K);
      for (let i = 0; i < K; i++) {
        assert.deepEqual(recovered[i], source[i], `run=${run} blok=${i} silinti=[${[...erased].join(',')}]`);
      }
    }
  });
}

test('uctan uca: kayipsiz durumda decode kimlik davraniyor', () => {
  const rnd = mulberry32(4242);
  const K = 12;
  const M = 6;
  const source = randomSymbols(K, 32, rnd);
  const parity = encode(source, M);
  const present = source.concat(parity).map((symbol, index) => ({ index, symbol }));
  const out = decode(present, K, M);
  for (let i = 0; i < K; i++) assert.deepEqual(out[i], source[i]);
});

test('uctan uca: M kadar silinti + fazladan gelen parity (secim en kucuk K indeks)', () => {
  const rnd = mulberry32(31337);
  const K = 8;
  const M = 6;
  const source = randomSymbols(K, 48, rnd);
  const codeword = source.concat(encode(source, M));

  // Ilk 3 source kayboldu; geri kalan her sey elde (K+M-3 sembol)
  const present = [];
  for (let i = 3; i < K + M; i++) present.push({ index: i, symbol: codeword[i] });

  const out = decode(present, K, M);
  for (let i = 0; i < K; i++) assert.deepEqual(out[i], source[i], `blok ${i}`);
});

// ============================================================
// 7. M+1 silinti -> InsufficientSymbols
// ============================================================
test('M+1 silinti InsufficientSymbols firlatiyor', () => {
  const rnd = mulberry32(555);
  for (const [K, M] of [
    [4, 4],
    [6, 5],
    [16, 13],
  ] as Array<[number, number]>) {
    const source = randomSymbols(K, 16, rnd);
    const codeword = source.concat(encode(source, M));
    // K-1 sembol birak (M+1 silinti)
    const present = codeword.slice(0, K - 1).map((symbol, index) => ({ index, symbol }));
    assert.throws(
      () => decode(present, K, M),
      (e: unknown) => e instanceof InsufficientSymbols && (e as InsufficientSymbols).need === K,
      `K=${K} M=${M}`,
    );
  }
});

// ============================================================
// 8. K=1, M=1 -> parity === source  (G[0][0] = inv(1) = 1)
// ============================================================
test('K=1, M=1: parity === source', () => {
  const G = generatorMatrix(1, 1);
  assert.equal(G[0][0], 1, 'G[0][0] = inv((1+0) XOR 0) = inv(1) = 1');

  const source = [Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])];
  const parity = encode(source, 1);
  assert.deepEqual(parity[0], source[0]);

  // source kayip, parity elde -> tam kurtarma
  const out = decode([{ index: 1, symbol: parity[0] }], 1, 1);
  assert.deepEqual(out[0], source[0]);
});

test('M=0: parity uretilmiyor, decode tam sete ihtiyac duyuyor', () => {
  const rnd = mulberry32(9);
  const K = 5;
  const source = randomSymbols(K, 24, rnd);
  assert.deepEqual(encode(source, 0), []);

  const full = source.map((symbol, index) => ({ index, symbol }));
  assert.deepEqual(decode(full, K, 0), source);
  assert.throws(() => decode(full.slice(1), K, 0), InsufficientSymbols);
});

test('encode: tutarsiz sembol boyu reddediliyor', () => {
  assert.throws(
    () => encode([new Uint8Array(10), new Uint8Array(11)], 2),
    /sembol boyu tutarsiz/,
  );
});
