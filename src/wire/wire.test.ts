/**
 * Wire katmani testleri — PU/CRC, datagram, grup builder/assembler.
 *   npm run test:wire
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  crc16,
  buildPU,
  parsePU,
  roundUp16,
  puRawLength,
  PU_HEADER_SIZE,
  PU_LEN_BIAS,
  MAX_PAYLOAD_LEN,
  type ProtectedUnit,
} from './protectedUnit.ts';
import {
  encodeDatagram,
  decodeDatagram,
  blockIndex,
  seqDiff,
  DG_HEADER_SIZE,
  MAX_DATAGRAM,
  MAX_SYMBOL_SIZE,
  type Datagram,
} from './datagram.ts';
import { GroupBuilder, type EmittedDatagram, type GroupStats } from './groupBuilder.ts';
import { GroupAssembler } from './groupAssembler.ts';

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

function randomBytes(n: number, rnd: () => number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

// ============================================================
// CRC-16/CCITT-FALSE
// ============================================================
test('crc16: bilinen vektor "123456789" -> 0x29B1', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc16(data), 0x29b1);
});

test('crc16: bos girdi init degerini korur (0xFFFF)', () => {
  assert.equal(crc16(new Uint8Array(0)), 0xffff);
});

test('crc16: zincirleme = tek gecis', () => {
  const rnd = mulberry32(11);
  const data = randomBytes(300, rnd);
  const split = 137;
  const chained = crc16(data, split, data.length, crc16(data, 0, split));
  assert.equal(chained, crc16(data));
});

test('crc16: tek bit degisimi crc degistirir', () => {
  const rnd = mulberry32(12);
  const data = randomBytes(64, rnd);
  const base = crc16(data);
  for (let bit = 0; bit < 64 * 8; bit += 37) {
    const copy = data.slice();
    copy[bit >> 3] ^= 1 << (bit & 7);
    assert.notEqual(crc16(copy), base, `bit ${bit}`);
  }
});

// ============================================================
// Protected Unit
// ============================================================
test('PU: alan yerlesimi sartnameye uyuyor', () => {
  const payload = Uint8Array.from([0xaa, 0xbb, 0xcc]);
  const buf = buildPU({
    chunkId: 0x01020304,
    keyframe: true,
    fragIndex: 0x0102,
    fragCount: 0x0203,
    payload,
  });

  const dv = new DataView(buf.buffer);
  assert.equal(buf.length, PU_HEADER_SIZE + 3);
  assert.equal(dv.getUint16(0, false), 3 + PU_LEN_BIAS, 'pu_len = 12 + payload_len');
  assert.equal(dv.getUint32(2, false), 0x01020304, 'chunk_id BE');
  assert.equal(buf[6], 0x80, 'keyframe biti bit7');
  assert.equal(dv.getUint16(7, false), 0x0102, 'frag_index BE');
  assert.equal(dv.getUint16(9, false), 0x0203, 'frag_count BE');
  assert.deepEqual(buf.subarray(PU_HEADER_SIZE), payload);
});

test('PU: crc alani kendi hesabina girmiyor (bayt 0-10 + payload)', () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  const buf = buildPU({ chunkId: 7, keyframe: false, fragIndex: 0, fragCount: 1, payload });
  const dv = new DataView(buf.buffer);
  const stored = dv.getUint16(11, false);
  const expected = crc16(buf, PU_HEADER_SIZE, buf.length, crc16(buf, 0, 11));
  assert.equal(stored, expected);
});

test('PU: build -> parse gidis donus, rastgele 400 kosum', () => {
  const rnd = mulberry32(2024);
  for (let i = 0; i < 400; i++) {
    const len = Math.floor(rnd() * (MAX_PAYLOAD_LEN + 1));
    const pu: ProtectedUnit = {
      chunkId: Math.floor(rnd() * 0xffffffff) >>> 0,
      keyframe: rnd() < 0.3,
      fragCount: 0,
      fragIndex: 0,
      payload: randomBytes(len, rnd),
    };
    pu.fragCount = 1 + Math.floor(rnd() * 40);
    pu.fragIndex = Math.floor(rnd() * pu.fragCount);

    const symbolSize = roundUp16(puRawLength(len));
    const buf = buildPU(pu, symbolSize);
    assert.equal(buf.length, symbolSize, 'doldurma symbol_size kadar');

    const out = parsePU(buf);
    assert.ok(out, `kosum ${i} cozulemedi`);
    assert.equal(out.chunkId, pu.chunkId);
    assert.equal(out.keyframe, pu.keyframe);
    assert.equal(out.fragIndex, pu.fragIndex);
    assert.equal(out.fragCount, pu.fragCount);
    assert.deepEqual(out.payload, pu.payload);
  }
});

test('PU: bozulmus sembol CRC ile yakalaniyor', () => {
  const rnd = mulberry32(77);
  let caught = 0;
  const trials = 500;
  for (let i = 0; i < trials; i++) {
    const payload = randomBytes(64, rnd);
    const buf = buildPU({ chunkId: i, keyframe: false, fragIndex: 0, fragCount: 1, payload }, 96);
    // Rastgele bir bayti degistir (payload veya baslik)
    const pos = Math.floor(rnd() * puRawLength(64));
    const delta = 1 + Math.floor(rnd() * 255);
    buf[pos] = (buf[pos] + delta) & 0xff;
    if (parsePU(buf) === null) caught++;
  }
  assert.equal(caught, trials, 'her tek-bayt bozulmasi yakalanmali');
});

test('PU: dolgu bolgesindeki cop cozumu bozmuyor', () => {
  const payload = Uint8Array.from([9, 9, 9]);
  const buf = buildPU({ chunkId: 1, keyframe: false, fragIndex: 0, fragCount: 1, payload }, 64);
  // CRC yalniz rawLen'e kadar hesaplanir; dolgudaki cop onemsiz olmali
  for (let i = puRawLength(3); i < 64; i++) buf[i] = 0xa5;
  const out = parsePU(buf);
  assert.ok(out);
  assert.deepEqual(out.payload, payload);
});

test('PU: mantiksiz frag alanlari reddediliyor', () => {
  const buf = buildPU({ chunkId: 1, keyframe: false, fragIndex: 3, fragCount: 4, payload: new Uint8Array(4) });
  const dv = new DataView(buf.buffer);
  // frag_index >= frag_count olacak sekilde degistir + crc'yi yeniden yaz
  dv.setUint16(7, 9, false);
  dv.setUint16(11, 0, false);
  dv.setUint16(11, crc16(buf, PU_HEADER_SIZE, buf.length, crc16(buf, 0, 11)), false);
  assert.equal(parsePU(buf), null);
});

test('PU: sinir disi payload reddediliyor', () => {
  assert.throws(
    () => buildPU({ chunkId: 0, keyframe: false, fragIndex: 0, fragCount: 1, payload: new Uint8Array(MAX_PAYLOAD_LEN + 1) }),
    /payload/,
  );
});

// ============================================================
// Datagram
// ============================================================
test('datagram: alan yerlesimi ve gidis donus', () => {
  const symbol = new Uint8Array(64).fill(0x5a);
  const dg: Datagram = { groupId: 0xbeef, index: 7, isParity: true, K: 16, M: 13, symbolSize: 64, symbol };
  const buf = encodeDatagram(dg);

  assert.equal(buf.length, DG_HEADER_SIZE + 64);
  assert.equal(buf[0], 0x01, 'version');
  assert.equal(buf[1], 0x80, 'is_parity bit7');
  assert.equal((buf[2] << 8) | buf[3], 0xbeef, 'group_id BE');
  assert.equal(buf[4], 7, 'index');
  assert.equal(buf[5], 16, 'K');
  assert.equal(buf[6], 13, 'M');
  assert.equal((buf[7] << 8) | buf[8], 64, 'symbol_size BE');
  assert.equal(buf[9], 0, 'reserved');

  const out = decodeDatagram(buf);
  assert.ok(out);
  assert.equal(out.groupId, 0xbeef);
  assert.equal(out.index, 7);
  assert.equal(out.isParity, true);
  assert.equal(out.K, 16);
  assert.equal(out.M, 13);
  assert.deepEqual(out.symbol, symbol);
  assert.equal(blockIndex(out), 16 + 7);
});

test('datagram: en buyuk paket 1200 bayt sinirinin altinda', () => {
  const symbol = new Uint8Array(MAX_SYMBOL_SIZE);
  const buf = encodeDatagram({
    groupId: 0, index: 0, isParity: false, K: 80, M: 32, symbolSize: MAX_SYMBOL_SIZE, symbol,
  });
  assert.ok(buf.length <= MAX_DATAGRAM, `${buf.length} <= ${MAX_DATAGRAM}`);
  assert.equal(MAX_SYMBOL_SIZE, 1168);
  assert.equal(buf.length, 1178);
});

test('datagram: bozuk baslik null donduruyor', () => {
  const symbol = new Uint8Array(32);
  const good = encodeDatagram({ groupId: 1, index: 0, isParity: false, K: 4, M: 2, symbolSize: 32, symbol });

  const badVersion = good.slice(); badVersion[0] = 0x02;
  assert.equal(decodeDatagram(badVersion), null, 'yanlis surum');

  const badFlags = good.slice(); badFlags[1] = 0x01;
  assert.equal(decodeDatagram(badFlags), null, 'rezerve bit set');

  const badK = good.slice(); badK[5] = 0;
  assert.equal(decodeDatagram(badK), null, 'K=0');

  const badM = good.slice(); badM[6] = 33;
  assert.equal(decodeDatagram(badM), null, 'M>32');

  const badIndex = good.slice(); badIndex[4] = 4;
  assert.equal(decodeDatagram(badIndex), null, 'source index >= K');

  assert.equal(decodeDatagram(good.slice(0, 20)), null, 'kesik sembol');
  assert.equal(decodeDatagram(new Uint8Array(4)), null, 'kesik baslik');
});

test('datagram: seqDiff uint16 sarmasina dayanikli', () => {
  assert.equal(seqDiff(5, 3), 2);
  assert.equal(seqDiff(3, 5), -2);
  assert.equal(seqDiff(2, 65534), 4, 'sarma ileri');
  assert.equal(seqDiff(65534, 2), -4, 'sarma geri');
});

// ============================================================
// GroupBuilder + GroupAssembler, uctan uca kayipli
// ============================================================

interface Harness {
  builder: GroupBuilder;
  /** grup basina TUM datagramlar: once source (aninda cikanlar), sonra parity */
  emitted: EmittedDatagram[][];
  /** yalniz kapanista cikan parity datagramlari */
  parityOnly: EmittedDatagram[][];
  groupStats: GroupStats[];
}

function makeBuilder(params: Partial<ConstructorParameters<typeof GroupBuilder>[0]['params']>): Harness {
  const emitted: EmittedDatagram[][] = [];
  const parityOnly: EmittedDatagram[][] = [];
  const groupStats: GroupStats[] = [];
  let pendingSource: EmittedDatagram[] = [];

  const builder = new GroupBuilder({
    params,
    // Source datagrami grup kapanmadan cikar
    onSource: (e) => pendingSource.push(e),
    onGroup: (parity, stats) => {
      emitted.push([...pendingSource, ...parity]);
      pendingSource = [];
      parityOnly.push(parity);
      groupStats.push(stats);
    },
  });
  return { builder, emitted, parityOnly, groupStats };
}

/**
 * Test yardimcisi: source datagramlari aninda cikar, parity kapanista.
 * Testlerin cogu "grubun TUM datagramlari" uzerinden konustugu icin ikisini
 * gonderim sirasinda birlestirip tek bir geri cagriya verir.
 */
function groupedBuilder(opts: {
  params: Partial<ConstructorParameters<typeof GroupBuilder>[0]['params']>;
  onGroup: (all: EmittedDatagram[], stats: GroupStats) => void;
}): GroupBuilder {
  let pending: EmittedDatagram[] = [];
  return new GroupBuilder({
    params: opts.params,
    onSource: (e) => pending.push(e),
    onGroup: (parity, stats) => {
      const all = [...pending, ...parity];
      pending = [];
      opts.onGroup(all, stats);
    },
  });
}

function makePUs(count: number, rnd: () => number, keyframeAt = -1): ProtectedUnit[] {
  const out: ProtectedUnit[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      chunkId: i >> 2,
      keyframe: i === keyframeAt,
      fragIndex: i & 3,
      fragCount: 4,
      payload: randomBytes(200 + Math.floor(rnd() * 500), rnd),
    });
  }
  return out;
}

test('groupBuilder: K_target dolunca grup kapaniyor, M = ceil(K*r)', () => {
  const rnd = mulberry32(101);
  const h = makeBuilder({ kTarget: 8, ratio: 0.8, fecEnabled: true, windowMs: 5000 });
  for (const pu of makePUs(8, rnd)) h.builder.push(pu);

  assert.equal(h.emitted.length, 1, 'tam bir grup');
  const st = h.groupStats[0];
  assert.equal(st.K, 8);
  assert.equal(st.M, Math.ceil(8 * 0.8), 'M = ceil(K*r) = 7');
  assert.equal(st.reason, 'full');
  assert.equal(h.emitted[0].length, 8 + 7);
  assert.equal(h.parityOnly[0].length, 7, 'kapanista YALNIZ parity cikar');
  assert.equal(st.symbolSize % 16, 0, 'symbol_size 16 katı');
  h.builder.dispose();
});

test('GONDERIM AYRIK: source datagrami grup kapanmadan kabloya cikiyor', () => {
  const rnd = mulberry32(0x5e4d);
  const sourceSeen: EmittedDatagram[] = [];
  const parityBatches: EmittedDatagram[][] = [];

  const builder = new GroupBuilder({
    params: { kTarget: 16, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onSource: (e) => sourceSeen.push(e),
    onGroup: (parity) => parityBatches.push(parity),
  });

  // 15 fragman: grup HENUZ kapanmadi (kTarget 16)
  const pus = makePUs(15, rnd);
  for (let i = 0; i < 15; i++) {
    builder.push(pus[i]);
    assert.equal(sourceSeen.length, i + 1, `${i + 1}. source hemen cikmaliydi`);
    assert.equal(parityBatches.length, 0, 'grup kapanmadan parity cikmamali');
  }

  // 16. fragman grubu kapatir -> parity cikar
  builder.push(makePUs(16, rnd)[15]);
  assert.equal(sourceSeen.length, 16);
  assert.equal(parityBatches.length, 1);
  assert.ok(parityBatches[0].every((e) => e.datagram.isParity), 'kapanista yalniz parity');

  // Source datagramlari sirali blok indeksi tasir
  assert.deepEqual(
    sourceSeen.map((e) => e.datagram.index),
    Array.from({ length: 16 }, (_, i) => i),
  );
  builder.dispose();
});

test('GONDERIM AYRIK: source K/M tahmin tasir, parity gercegi tasir', () => {
  const rnd = mulberry32(0x5e4e);
  const sourceSeen: EmittedDatagram[] = [];
  let parity: EmittedDatagram[] = [];

  const builder = new GroupBuilder({
    // kTarget 16 ama pencere ile 5 fragmanda kapanacak
    params: { kTarget: 16, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onSource: (e) => sourceSeen.push(e),
    onGroup: (p) => (parity = p),
  });
  for (const pu of makePUs(5, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();

  // Source basliklari tahmini tasir: K = kTarget
  assert.ok(sourceSeen.every((e) => e.datagram.K === 16), 'source K tahmini kTarget olmali');
  // Parity gercegi tasir: K = 5
  assert.ok(parity.length > 0);
  assert.ok(parity.every((e) => e.datagram.K === 5), 'parity gercek K tasimali');
  assert.ok(parity.every((e) => e.datagram.M === parity.length));
});

test('groupBuilder: keyframe chunk tamamlaninca grup aninda kapaniyor', () => {
  const rnd = mulberry32(102);
  const h = makeBuilder({ kTarget: 32, ratio: 0.5, fecEnabled: true, windowMs: 5000 });
  // 4 fragmanlik keyframe chunk; son fragman (fragIndex=3) kapatmali
  for (let i = 0; i < 4; i++) {
    h.builder.push({ chunkId: 0, keyframe: true, fragIndex: i, fragCount: 4, payload: randomBytes(100, rnd) });
  }
  assert.equal(h.emitted.length, 1);
  assert.equal(h.groupStats[0].reason, 'keyframe');
  assert.equal(h.groupStats[0].K, 4);
  h.builder.dispose();
});

test('groupBuilder: FEC kapaliyken parity uretilmiyor (M=0)', () => {
  const rnd = mulberry32(103);
  const h = makeBuilder({ kTarget: 6, ratio: 0.8, fecEnabled: false, windowMs: 5000 });
  for (const pu of makePUs(6, rnd)) h.builder.push(pu);
  assert.equal(h.groupStats[0].M, 0);
  assert.equal(h.emitted[0].length, 6);
  assert.equal(h.groupStats[0].parityBytes, 0);
  h.builder.dispose();
});

test('groupBuilder: M ust sinirda 32e kirpiliyor', () => {
  const rnd = mulberry32(104);
  const h = makeBuilder({ kTarget: 60, ratio: 1.2, fecEnabled: true, windowMs: 5000 });
  for (const pu of makePUs(60, rnd)) h.builder.push(pu);
  assert.equal(h.groupStats[0].M, 32, 'ceil(60*1.2)=72 -> 32');
  h.builder.dispose();
});

test('groupBuilder: symbol_size en uzun PU + 16 yuvarlama', () => {
  const h = makeBuilder({ kTarget: 3, ratio: 0.4, fecEnabled: true, windowMs: 5000 });
  h.builder.push({ chunkId: 0, keyframe: false, fragIndex: 0, fragCount: 3, payload: new Uint8Array(10) });
  h.builder.push({ chunkId: 0, keyframe: false, fragIndex: 1, fragCount: 3, payload: new Uint8Array(100) });
  h.builder.push({ chunkId: 0, keyframe: false, fragIndex: 2, fragCount: 3, payload: new Uint8Array(50) });
  const groupSize = roundUp16(PU_HEADER_SIZE + 100);
  assert.equal(h.groupStats[0].symbolSize, groupSize);

  // Parity grup symbol_size'inda; source ise KENDI dogal boyunda cikar
  // (grup kapanmadan gonderildigi icin grup boyunu bilemez).
  for (const e of h.parityOnly[0]) {
    assert.equal(e.datagram.symbolSize, groupSize, 'parity grup boyunda');
  }
  const sourceSizes = h.emitted[0].filter((e) => !e.datagram.isParity).map((e) => e.datagram.symbolSize);
  assert.deepEqual(sourceSizes, [
    roundUp16(PU_HEADER_SIZE + 10),
    roundUp16(PU_HEADER_SIZE + 100),
    roundUp16(PU_HEADER_SIZE + 50),
  ]);
  // Dolgu israfi yok: kucuk fragman kucuk paket olarak gider
  assert.ok(sourceSizes[0] < groupSize, 'kucuk PU grup boyuna sisirilmemeli');
  h.builder.dispose();
});

/**
 * Uctan uca: builder -> kayip -> assembler.
 * Ayni kayip deseni hem FEC'siz hem FEC'li assembler'a uygulanir
 * (fiziksel olarak ayni paketler) — karsilastirma durust.
 */
function runLossScenario(opts: {
  puCount: number;
  kTarget: number;
  ratio: number;
  lossRate: number;
  seed: number;
}) {
  const rnd = mulberry32(opts.seed);
  const pus = makePUs(opts.puCount, mulberry32(opts.seed ^ 0x5bf03635));

  const plainOut: ProtectedUnit[] = [];
  const fecOut: ProtectedUnit[] = [];
  const plain = new GroupAssembler({ useFec: false, onPU: (p) => plainOut.push(p) });
  const fec = new GroupAssembler({ useFec: true, onPU: (p) => fecOut.push(p) });

  let sent = 0;
  let dropped = 0;

  const wire = (e: EmittedDatagram): void => {
    sent++;
    if (rnd() < opts.lossRate) {
      dropped++;
      return;
    }
    // Kabloyu gercekten dolas: baytlari tekrar coz
    const parsed = decodeDatagram(e.bytes);
    assert.ok(parsed, 'kablo uzerindeki datagram cozulebilmeli');
    plain.push(parsed, 0);
    fec.push(parsed, 0);
  };

  const builder = new GroupBuilder({
    params: { kTarget: opts.kTarget, ratio: opts.ratio, fecEnabled: true, windowMs: 5000 },
    onSource: wire,
    onGroup: (parity) => {
      for (const e of parity) wire(e);
    },
  });

  for (const pu of pus) builder.push(pu);
  builder.flush();
  builder.dispose();
  plain.tick(GROUP_TIMEOUT());
  fec.tick(GROUP_TIMEOUT());

  return { pus, plainOut, fecOut, plain, fec, sent, dropped };
}

function GROUP_TIMEOUT(): number {
  return 10_000;
}

function samePU(a: ProtectedUnit, b: ProtectedUnit): boolean {
  if (a.chunkId !== b.chunkId || a.fragIndex !== b.fragIndex) return false;
  if (a.fragCount !== b.fragCount || a.keyframe !== b.keyframe) return false;
  if (a.payload.length !== b.payload.length) return false;
  for (let i = 0; i < a.payload.length; i++) if (a.payload[i] !== b.payload[i]) return false;
  return true;
}

test('uctan uca: kayip yokken iki yol da tam teslim, decode calismiyor', () => {
  const r = runLossScenario({ puCount: 64, kTarget: 16, ratio: 0.8, lossRate: 0, seed: 5 });
  assert.equal(r.dropped, 0);
  assert.equal(r.plainOut.length, 64);
  assert.equal(r.fecOut.length, 64);
  assert.equal(r.fec.stats.groupsRecovered, 0, 'kayipsiz yolda RS decode calismamali');
  assert.equal(r.fec.stats.recovered, 0);
  for (let i = 0; i < 64; i++) {
    assert.ok(samePU(r.plainOut[i], r.pus[i]), `plain PU ${i}`);
    assert.ok(samePU(r.fecOut[i], r.pus[i]), `fec PU ${i}`);
  }
});

test('uctan uca: %30 kayipta FEC kurtariyor, FEC kapali kaybediyor', () => {
  const r = runLossScenario({ puCount: 320, kTarget: 16, ratio: 0.8, lossRate: 0.3, seed: 9 });

  assert.ok(r.dropped > 0, 'kayip enjekte edilmis olmali');
  assert.ok(r.fec.stats.recovered > 0, 'RS decode gercekten kurtarmali');
  assert.ok(
    r.fecOut.length > r.plainOut.length,
    `FEC daha cok PU teslim etmeli (fec=${r.fecOut.length}, plain=${r.plainOut.length})`,
  );
  assert.equal(r.fec.stats.crcFailures, 0, 'kurtarilan PU\'lar CRC gecmeli');

  // Teslim edilen her PU orijinaliyle birebir esit olmali
  const byKey = new Map(r.pus.map((p) => [`${p.chunkId}:${p.fragIndex}`, p]));
  for (const p of r.fecOut) {
    const orig = byKey.get(`${p.chunkId}:${p.fragIndex}`);
    assert.ok(orig && samePU(p, orig), 'kurtarilan PU orijinalle birebir esit degil');
  }
});

test('uctan uca: kayip arttikca FEC de teslim edemez hale geliyor (sistem siniri)', () => {
  const light = runLossScenario({ puCount: 320, kTarget: 16, ratio: 0.8, lossRate: 0.2, seed: 21 });
  const heavy = runLossScenario({ puCount: 320, kTarget: 16, ratio: 0.8, lossRate: 0.55, seed: 21 });
  assert.ok(
    heavy.fecOut.length < light.fecOut.length,
    `agir kayipta teslim dusmeli (${heavy.fecOut.length} < ${light.fecOut.length})`,
  );
  assert.ok(heavy.fec.stats.groupsLost > 0, 'agir kayipta grup kaybi gorulmeli');
});

test('uctan uca: kucuk K_target kurtarmayi zayiflatiyor', () => {
  // Ayni r ile K=4 -> M=4 (%50 kayip toleransi ama kucuk havuz),
  // K=32 -> M=26. Buyuk grup, ayni kayip oraninda daha iyi ortalama alir.
  const small = runLossScenario({ puCount: 640, kTarget: 4, ratio: 0.8, lossRate: 0.4, seed: 33 });
  const large = runLossScenario({ puCount: 640, kTarget: 32, ratio: 0.8, lossRate: 0.4, seed: 33 });
  assert.ok(
    large.fecOut.length > small.fecOut.length,
    `buyuk grup daha cok teslim etmeli (K=32:${large.fecOut.length} > K=4:${small.fecOut.length})`,
  );
});

test('groupAssembler: parity paketleri FEC kapali yolda tamamen yok sayiliyor', () => {
  const rnd = mulberry32(44);
  const seen: ProtectedUnit[] = [];
  const plain = new GroupAssembler({ useFec: false, onPU: (p) => seen.push(p) });

  const builder = groupedBuilder({
    params: { kTarget: 4, ratio: 1.0, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      for (const e of dgs) {
        // source 0'i dusur; parity'lerin hepsini gecir
        if (!e.datagram.isParity && e.datagram.index === 0) continue;
        plain.push(decodeDatagram(e.bytes)!, 0);
      }
    },
  });
  for (const pu of makePUs(4, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  plain.tick(10_000);

  // ANINDA ILETIM: gelmis olan 3 source PU teslim edilir; yalniz kaybolan
  // gelmez. Eskiden grup kapanmasi beklendigi icin gelmis paketler de
  // cope atiliyordu — bu, kayip olmasa bile ~200 ms'lik oynatma
  // duraklamalarina yol aciyordu.
  assert.equal(seen.length, 3, 'gelen source PU\'lar bekletilmeden teslim edilmeli');
  assert.ok(
    seen.every((p) => p.fragIndex !== 0),
    'kaybolan blok (index 0) teslim edilmemeli',
  );
  assert.equal(plain.stats.groupsLost, 1, 'grup yine de eksik sayilir');
  assert.equal(plain.stats.expectedSource, 4, 'FEC kapali yolda beklenen source = K');
  assert.equal(plain.stats.expectedParity, 0, 'FEC kapali yolda parity beklenmez');
  assert.equal(plain.stats.parityBytes, 0, 'FEC kapali panelde overhead 0 olmali');
  assert.equal(plain.stats.receivedParity, 0, 'parity "gelen" sayacina girmemeli');
  assert.equal(plain.stats.recovered, 0, 'FEC kapali yol hicbir sey kurtaramaz');
});

test('kriter 7: iki panel birebir ayni source kayip desenini goruyor', () => {
  const rnd = mulberry32(0xc0ffee);
  const plain = new GroupAssembler({ useFec: false, onPU: () => {} });
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });

  const builder = groupedBuilder({
    params: { kTarget: 16, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      for (const e of dgs) {
        // Ayni FIZIKSEL paket dusurulur; iki assembler ayni akisi gorur.
        // Bazen bir grubun TUM source'u kaybolur — sol panelin o grubu
        // yine de sayabildigini dogrulamak icin kayip yuksek.
        if (rnd() < 0.45) continue;
        const parsed = decodeDatagram(e.bytes)!;
        plain.push(parsed, 0);
        fec.push(parsed, 0);
      }
    },
  });
  for (const pu of makePUs(480, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  plain.tick(10_000);
  fec.tick(10_000);

  assert.equal(
    plain.stats.receivedSource,
    fec.stats.receivedSource,
    'gelen source sembolleri birebir ayni olmali',
  );
  assert.equal(
    plain.stats.expectedSource,
    fec.stats.expectedSource,
    'beklenen source sembolleri birebir ayni olmali',
  );
  assert.ok(fec.stats.recovered > 0, 'FEC yolu gercekten kurtarmali');
  assert.ok(
    fec.stats.pusDelivered > plain.stats.pusDelivered,
    'FEC yolu daha cok PU teslim etmeli',
  );
});

test('ANINDA ILETIM: source PU grubun kapanmasini beklemiyor', () => {
  const rnd = mulberry32(0xfeed);
  const seen: ProtectedUnit[] = [];
  const fec = new GroupAssembler({ useFec: true, onPU: (p) => seen.push(p) });

  const pus = makePUs(16, rnd);
  const batches: EmittedDatagram[][] = [];
  const builder = groupedBuilder({
    params: { kTarget: 16, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => batches.push(dgs),
  });
  for (const pu of pus) builder.push(pu);
  builder.dispose();

  const dgs = batches[0];
  // Source sembolleri TEK TEK ver ve her adimda teslimi kontrol et
  let sourceGiven = 0;
  for (const e of dgs) {
    if (e.datagram.isParity) continue;
    fec.push(decodeDatagram(e.bytes)!, 0);
    sourceGiven++;
    assert.equal(
      seen.length,
      sourceGiven,
      `${sourceGiven}. source sembolu aninda teslim edilmeliydi (grup henuz kapanmadi)`,
    );
  }
  // 16/16 geldi, hicbir PU iki kez teslim edilmedi
  assert.equal(seen.length, 16);
  assert.equal(fec.stats.pusDelivered, 16);
  assert.equal(fec.stats.recovered, 0, 'kayip yokken RS decode calismamali');
});

test('ANINDA ILETIM: kurtarilan PU\'lar bir kez teslim ediliyor (yineleme yok)', () => {
  const rnd = mulberry32(0xbeef1);
  const seen: ProtectedUnit[] = [];
  const fec = new GroupAssembler({ useFec: true, onPU: (p) => seen.push(p) });

  const builder = groupedBuilder({
    params: { kTarget: 12, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      // Ilk 4 source'u dusur, geri kalani + parity'yi gecir
      for (const e of dgs) {
        if (!e.datagram.isParity && e.datagram.index < 4) continue;
        fec.push(decodeDatagram(e.bytes)!, 0);
      }
    },
  });
  for (const pu of makePUs(12, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  fec.tick(10_000);

  assert.equal(fec.stats.recovered, 4, '4 sembol RS ile kurtarilmali');
  assert.equal(seen.length, 12, 'toplam 12 PU — ne eksik ne fazla');

  // Her (chunkId, fragIndex) tam olarak bir kez
  const keys = seen.map((p) => `${p.chunkId}:${p.fragIndex}`);
  assert.equal(new Set(keys).size, 12, 'ayni PU iki kez teslim edilmemeli');
});

test('groupAssembler: overhead basliklardan hesaplaniyor, kayiptan bagimsiz', () => {
  const rnd = mulberry32(66);
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });

  const builder = groupedBuilder({
    params: { kTarget: 10, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      // Paketlerin yarisini dusur; overhead yine de M/(K+M) cikmali
      for (let i = 0; i < dgs.length; i++) {
        if (i % 2 === 0) continue;
        fec.push(decodeDatagram(dgs[i].bytes)!, 0);
      }
    },
  });
  for (const pu of makePUs(10, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  // Beklenen sembol/bayt hesabi grup KAPANIRKEN yapilir (K'nin gercegini
  // parity getirdigi icin acilista yapilamaz) — once gruplari kapat.
  fec.tick(10_000);

  const s = fec.stats;
  const overhead = s.parityBytes / (s.sourceBytes + s.parityBytes);
  assert.equal(s.expectedSource, 10);
  assert.equal(s.expectedParity, 8, 'ceil(10*0.8) = 8');
  assert.ok(Math.abs(overhead - 8 / 18) < 1e-9, `overhead ${overhead}, beklenen ${8 / 18}`);
});

test('groupAssembler: tamamen kaybolan grup kayip oranina yansiyor', () => {
  const rnd = mulberry32(67);
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });
  let groupIndex = 0;

  const builder = groupedBuilder({
    params: { kTarget: 8, ratio: 0.5, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      const g = groupIndex++;
      // 2. grubun TAMAMINI dusur — alici bu grubun varligini yalniz
      // group_id boslugundan anlayabilir
      if (g === 1) return;
      for (const e of dgs) fec.push(decodeDatagram(e.bytes)!, g * 10);
    },
  });
  for (const pu of makePUs(24, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();

  // Bosluk hemen kayip sayilmaz; zaman asimi beklenir
  assert.equal(fec.stats.groupsVanished, 0, 'sirasiz kanal icin hemen karar verilmemeli');
  fec.tick(10_000);

  assert.equal(fec.stats.groupsVanished, 1, 'kaybolan grup zaman asimindan sonra sayilmali');
  assert.equal(fec.stats.expectedSource, 24, 'kaybolan grubun K\'si de beklenene eklenmeli');
  assert.equal(fec.stats.receivedSource, 16);
});

test('groupAssembler: yeniden siralanmis grup yanlislikla kayip sayilmiyor', () => {
  const rnd = mulberry32(68);
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });
  const batches: EmittedDatagram[][] = [];

  const builder = groupedBuilder({
    params: { kTarget: 8, ratio: 0.5, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => batches.push(dgs),
  });
  for (const pu of makePUs(24, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  assert.equal(batches.length, 3);

  // Grup 1'i grup 2'den SONRA teslim et (kanal sirasiz)
  for (const e of batches[0]) fec.push(decodeDatagram(e.bytes)!, 0);
  for (const e of batches[2]) fec.push(decodeDatagram(e.bytes)!, 1);
  for (const e of batches[1]) fec.push(decodeDatagram(e.bytes)!, 2);
  fec.tick(10_000);

  assert.equal(fec.stats.groupsVanished, 0, 'gec gelen grup kayip sayilmamali');
  assert.equal(fec.stats.groupsLost, 0);
  assert.equal(fec.stats.pusDelivered, 24);
});

test('groupAssembler: kayipsiz durumda olculen kayip %0 (parity source\'tan SONRA gelse de)', () => {
  const rnd = mulberry32(70);
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });

  const builder = groupedBuilder({
    params: { kTarget: 16, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
    onGroup: (dgs) => {
      // Gercek sira: once K source, sonra M parity. Grup K source ile
      // hemen kapanir; parity paketleri kapanmis gruba gelir ama yine de
      // "gelmis" sayilmalidir.
      for (const e of dgs) fec.push(decodeDatagram(e.bytes)!, 0);
    },
  });
  for (const pu of makePUs(48, rnd)) builder.push(pu);
  builder.flush();
  builder.dispose();
  fec.tick(10_000);

  const s = fec.stats;
  const expected = s.expectedSource + s.expectedParity;
  const received = s.receivedSource + s.receivedParity;
  assert.equal(received, expected, `kayipsiz akista gelen=${received} beklenen=${expected}`);
  assert.equal(s.groupsLost, 0);
  assert.equal(s.recovered, 0, 'kayip yokken RS decode calismamali');
  assert.equal(s.groupsClean, 3);
});

test('groupAssembler: acik grup sayisi sinirlanmis, bellek buyumuyor', () => {
  const rnd = mulberry32(55);
  const fec = new GroupAssembler({ useFec: true, onPU: () => {} });
  const symbol = new Uint8Array(32);
  // 500 farkli group_id'den birer paket — hicbiri tamamlanmaz
  for (let g = 0; g < 500; g++) {
    fec.push(
      { groupId: g & 0xffff, index: 0, isParity: false, K: 8, M: 4, symbolSize: 32, symbol },
      g,
    );
  }
  assert.ok(fec.stats.groupsLost > 400, 'eskiyen gruplar kapatilmali');
  void rnd;
});
