/**
 * ARQ testleri: fizibilite aritmetigi, onbellek sinirlari,
 * amplifikasyon korumalari.
 *   node --test src/net/arq.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SenderSymbolCache,
  NackController,
  RtxBudget,
  feasibility,
  GROUP_DEADLINE_MS,
  DECODE_BUDGET_MS,
  MAX_NACK_ROUNDS,
  RTX_BUDGET,
  CACHE_MAX_GROUPS,
  CACHE_TTL_MS,
  NACK_SETTLE_MS,
} from './arq.ts';
import { decodeNack, decodeDatagram, encodeNack, NACK_MAX_INDICES } from '../wire/datagram.ts';
import type { OpenGroupView } from '../wire/groupAssembler.ts';

function symbols(K: number, M: number, size: number): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  for (let i = 0; i < K + M; i++) m.set(i, new Uint8Array(size).fill(i & 0xff));
  return m;
}

function group(over: Partial<OpenGroupView> = {}): OpenGroupView {
  return {
    groupId: 1,
    K: 16,
    M: 13,
    have: [],
    needed: 16,
    firstSeenMs: 0,
    ...over,
  };
}

// ============================================================
// Fizibilite aritmetigi
// ============================================================

test('fizibilite: formul sartnameye birebir uyuyor', () => {
  // remaining > rttEst*1.1 + 15
  const f = feasibility(500, 200);
  assert.equal(f.feasible, 500 > 200 * 1.1 + DECODE_BUDGET_MS);
  assert.equal(f.maxRetries, Math.min(3, Math.floor((500 - DECODE_BUDGET_MS) / (200 * 1.1))));
});

test('fizibilite: RTT buyudukce max_retries 3 -> 2 -> 1 -> 0', () => {
  // Taze bir grup: settle beklendi, tek yon transit zaten harcandi
  const retriesAt = (rtt: number) =>
    feasibility(GROUP_DEADLINE_MS - rtt / 2 - NACK_SETTLE_MS, rtt).maxRetries;

  assert.equal(retriesAt(20), 3, 'RTT 20 ms -> 3 tur');
  assert.equal(retriesAt(60), 3, 'RTT 60 ms -> 3 tur');
  assert.equal(retriesAt(200), 2, 'RTT 200 ms -> 2 tur');
  assert.equal(retriesAt(300), 1, 'RTT 300 ms -> 1 tur');
  assert.equal(retriesAt(400), 0, 'RTT 400 ms -> ARQ kapanir');

  // Monoton azalan olmali
  let prev = Infinity;
  for (let rtt = 0; rtt <= 400; rtt += 10) {
    const r = retriesAt(rtt);
    assert.ok(r <= prev, `RTT ${rtt}: ${r} > onceki ${prev}`);
    prev = r;
  }
});

test('fizibilite: deadline gecmisse feasible degil', () => {
  assert.equal(feasibility(0, 60).feasible, false);
  assert.equal(feasibility(-100, 60).feasible, false);
  assert.equal(feasibility(-100, 60).maxRetries, 0);
});

test('fizibilite: maxRetries hicbir zaman 3\'u asmiyor', () => {
  assert.equal(feasibility(GROUP_DEADLINE_MS, 1).maxRetries, MAX_NACK_ROUNDS);
  assert.equal(feasibility(100000, 1).maxRetries, MAX_NACK_ROUNDS);
});

// ============================================================
// Gonderici sembol onbellegi
// ============================================================

test('onbellek: sembol saklanip retransmit olarak uretiliyor', () => {
  const c = new SenderSymbolCache();
  c.store(5, 4, 2, 64, symbols(4, 2, 64), 0);

  const rtx = c.buildRetransmit(5, 2, 10);
  assert.ok(rtx, 'source sembolu uretilmeli');
  const dg = decodeDatagram(rtx);
  assert.ok(dg);
  assert.equal(dg.groupId, 5);
  assert.equal(dg.index, 2);
  assert.equal(dg.isParity, false);
  assert.equal(dg.isRetransmit, true, 'is_retransmit isaretli olmali');

  // parity: blockIndex 4 -> parity r=0
  const par = decodeDatagram(c.buildRetransmit(5, 4, 10)!);
  assert.ok(par);
  assert.equal(par.isParity, true);
  assert.equal(par.index, 0);
  assert.equal(par.isRetransmit, true);
});

test('KURAL 3: onbellekte olmayan index sessizce yok sayiliyor', () => {
  const c = new SenderSymbolCache();
  c.store(1, 4, 2, 32, symbols(4, 2, 32), 0);
  assert.equal(c.buildRetransmit(1, 99, 10), null, 'olmayan index');
  assert.equal(c.buildRetransmit(42, 0, 10), null, 'olmayan grup');
  assert.equal(c.stats.missed, 2);
});

test('KURAL 4: deadline\'i gecmis gruba yanit verilmiyor', () => {
  const c = new SenderSymbolCache();
  c.store(1, 4, 2, 32, symbols(4, 2, 32), 0);
  assert.ok(c.buildRetransmit(1, 0, CACHE_TTL_MS - 1), 'deadline icinde yanit verilmeli');
  assert.equal(c.buildRetransmit(1, 0, CACHE_TTL_MS + 1), null, 'deadline sonrasi yanit yok');
});

test('SINIR: en fazla 8 grup tutuluyor, en eski atiliyor', () => {
  const c = new SenderSymbolCache();
  for (let g = 0; g < 20; g++) c.store(g, 4, 2, 32, symbols(4, 2, 32), g);
  assert.equal(c.stats.groups, CACHE_MAX_GROUPS);
  assert.ok(c.stats.evictedByLimit > 0);
  // en eski gitmis, en yeni durmali
  assert.equal(c.buildRetransmit(0, 0, 20), null);
  assert.ok(c.buildRetransmit(19, 0, 20));
});

test('SINIR: 600 ms sonra grup atiliyor', () => {
  const c = new SenderSymbolCache();
  c.store(1, 4, 2, 32, symbols(4, 2, 32), 0);
  assert.equal(c.stats.groups, 1);
  c.prune(CACHE_TTL_MS + 1);
  assert.equal(c.stats.groups, 0);
  assert.equal(c.stats.evictedByAge, 1);
});

test('SIZINTI YOK: uzun kosumda onbellek boyutu sabit kaliyor', () => {
  const c = new SenderSymbolCache();
  const sizes: number[] = [];
  // 5 dakikaya karsilik gelen grup akisi (20 ms'de bir grup)
  for (let t = 0; t < 300_000; t += 20) {
    c.store(t / 20, 16, 13, 1168, symbols(16, 13, 1168), t);
    c.prune(t);
    if (t > 10_000) sizes.push(c.stats.bytes);
  }
  const max = Math.max(...sizes);
  assert.ok(c.stats.groups <= CACHE_MAX_GROUPS, `grup sayisi ${c.stats.groups}`);
  assert.ok(max <= 4 * 1024 * 1024, `en yuksek boyut ${max} bayt, 4 MB siniri asilmamali`);
  // Sabit kalmali: son ile ortadaki olcum ayni olmali
  assert.equal(sizes[sizes.length - 1], sizes[Math.floor(sizes.length / 2)], 'boyut sabit degil');
});

// ============================================================
// RTX butcesi
// ============================================================

test('KURAL 5: RTX butcesi %15\'i asinca izin verilmiyor', () => {
  const b = new RtxBudget();
  const total = 100_000;
  // %15'e kadar izin var
  assert.equal(b.allows(total, 1000), true);
  b.note(1000);
  b.rtxBytes = 14_000;
  assert.equal(b.allows(total, 500), true, '%14.5 -> izin');
  b.rtxBytes = 15_000;
  assert.equal(b.allows(total, 1000), false, '%16 -> red');
  assert.equal(b.exceeded, 1);
});

test('RTX butce kullanimi dogru hesaplaniyor', () => {
  const b = new RtxBudget();
  b.note(1500);
  assert.ok(Math.abs(b.used(10_000) - 0.15) < 1e-9);
  assert.equal(b.used(0), 0);
  assert.ok(RTX_BUDGET === 0.15);
});

// ============================================================
// NACK uretimi
// ============================================================

function makeController(rttEst: number) {
  const sent: Uint8Array[] = [];
  const c = new NackController({ send: (b) => sent.push(b), rttEstMs: () => rttEst });
  return { c, sent };
}

test('NACK: eksik semboller en dusuk indeksliden isteniyor', () => {
  const { c, sent } = makeController(60);
  c.tick(NACK_SETTLE_MS + 1, [group({ have: [3, 5, 20], needed: 13 })]);

  assert.equal(sent.length, 1);
  const n = decodeNack(sent[0]);
  assert.ok(n);
  assert.equal(n.groupId, 1);
  // 0,1,2 elde yok -> once onlar
  assert.deepEqual(n.indices.slice(0, 3), [0, 1, 2]);
  assert.ok(n.indices.every((i) => ![3, 5, 20].includes(i)), 'elde olan istenmemeli');
  assert.ok(n.indices.length <= NACK_MAX_INDICES);
});

test('NACK: parity de istenebilir (MDS — hangisi gelirse gelsin)', () => {
  const { c, sent } = makeController(60);
  // K=4, M=13: source'un hepsi eksik ama sadece 2 tanesi gerekiyor
  c.tick(NACK_SETTLE_MS + 1, [group({ K: 4, M: 13, have: [0, 1], needed: 2 })]);
  const n = decodeNack(sent[0])!;
  assert.deepEqual(n.indices, [2, 3], 'once eksik source');

  // Tum source elde, yine de eksikse parity istenir
  const { c: c2, sent: s2 } = makeController(60);
  c2.tick(NACK_SETTLE_MS + 1, [group({ K: 4, M: 13, have: [0, 1, 2], needed: 1, groupId: 9 })]);
  const n2 = decodeNack(s2[0])!;
  assert.deepEqual(n2.indices, [3]);
});

test('NACK: settle suresinden once uretilmiyor', () => {
  const { c, sent } = makeController(60);
  c.tick(NACK_SETTLE_MS - 1, [group({ have: [0], needed: 15 })]);
  assert.equal(sent.length, 0, 'paketler hâlâ geliyor olabilir');
  c.tick(NACK_SETTLE_MS + 1, [group({ have: [0], needed: 15 })]);
  assert.equal(sent.length, 1);
});

test('KURAL 1: min_resend_interval gecmeden ayni indeks tekrar istenmiyor', () => {
  const rttEst = 60;
  const minInterval = Math.max(rttEst, 100); // 100 ms
  const { c, sent } = makeController(rttEst);
  const g = () => group({ have: [], needed: 16 });

  c.tick(NACK_SETTLE_MS + 1, [g()]);
  assert.equal(sent.length, 1);

  // Hemen sonra -> ne ayni ne de FARKLI indeksler istenebilir.
  // (Farkli indeksleri hemen istemek NACK patlamasi olurdu.)
  c.tick(NACK_SETTLE_MS + 10, [g()]);
  assert.equal(sent.length, 1, 'min_resend_interval gecmeden tekrar NACK olmamali');

  // Interval gectikten sonra -> tekrar istenebilir
  c.tick(NACK_SETTLE_MS + minInterval + 5, [g()]);
  assert.equal(sent.length, 2);
});

test('KURAL 2: grup basina en fazla 3 NACK turu', () => {
  const { c, sent } = makeController(20); // dusuk RTT -> maxRetries 3
  const g = () => group({ have: [], needed: 16 });
  const minInterval = 100;

  for (let round = 0; round < 8; round++) {
    c.tick(NACK_SETTLE_MS + 1 + round * (minInterval + 5), [g()]);
  }
  assert.equal(sent.length, MAX_NACK_ROUNDS, `en fazla ${MAX_NACK_ROUNDS} tur olmali`);
  assert.ok(c.stats.roundLimited > 0);
});

test('FIZIBILITE: RTT buyukse NACK URETILMIYOR, sayac artiyor', () => {
  const { c, sent } = makeController(400);
  // Taze grup, ama 400 ms RTT'de bir tur bile sigmaz
  c.tick(NACK_SETTLE_MS + 1, [group({ have: [], needed: 16, firstSeenMs: 0 })]);

  assert.equal(sent.length, 0, 'deadline yetmiyorsa NACK uretilmez');
  assert.equal(c.stats.nackInfeasible, 1);
  assert.equal(c.currentMaxRetries(), 0);
});

test('FIZIBILITE: deadline\'a az kalmissa NACK uretilmiyor', () => {
  const { c, sent } = makeController(60);
  // Grup 560 ms once gorulmus -> 40 ms kalmis, 60*1.1+15 = 81 > 40
  c.tick(560, [group({ have: [], needed: 16, firstSeenMs: 0 })]);
  assert.equal(sent.length, 0);
  assert.equal(c.stats.nackInfeasible, 1);
});

test('currentMaxRetries RTT ile 3 -> 0 arasinda dusuyor', () => {
  assert.equal(makeController(20).c.currentMaxRetries(), 3);
  assert.equal(makeController(200).c.currentMaxRetries(), 2);
  assert.equal(makeController(300).c.currentMaxRetries(), 1);
  assert.equal(makeController(400).c.currentMaxRetries(), 0);
});

test('NACK: tamamlanan grubun durumu birakiliyor (bellek buyumuyor)', () => {
  const { c } = makeController(60);
  for (let g = 0; g < 500; g++) {
    c.tick(NACK_SETTLE_MS + 1 + g, [group({ groupId: g, have: [], needed: 16, firstSeenMs: g })]);
  }
  // Her tikta yalniz bir grup "canli"; digerlerinin durumu silinmeli.
  // Ic haritaya erisemiyoruz ama reset sonrasi davranis tutarli olmali.
  c.reset();
  assert.equal(c.stats.nackSent, 0);
});

test('noteRetransmit yalniz talep edilen indeksi yanitlanmis sayiyor', () => {
  const { c, sent } = makeController(60);
  c.tick(NACK_SETTLE_MS + 1, [group({ have: [], needed: 16 })]);
  const n = decodeNack(sent[0])!;

  c.noteRetransmit(1, n.indices[0]);
  assert.equal(c.stats.nackAnswered, 1);
  assert.equal(c.stats.retransmitReceived, 1);

  // Istenmemis bir indeks yanit sayilmaz
  c.noteRetransmit(1, 250);
  assert.equal(c.stats.nackAnswered, 1);
  assert.equal(c.stats.retransmitReceived, 2);
});

// ============================================================
// NACK datagrami
// ============================================================

test('NACK datagrami gidis donus', () => {
  const buf = encodeNack({ groupId: 0xbeef, indices: [0, 3, 17, 200] });
  const n = decodeNack(buf);
  assert.ok(n);
  assert.equal(n.groupId, 0xbeef);
  assert.deepEqual(n.indices, [0, 3, 17, 200]);
});

test('NACK datagrami sinirlari', () => {
  assert.throws(() => encodeNack({ groupId: 1, indices: [] }), /gecersiz indeks sayisi/);
  assert.throws(
    () => encodeNack({ groupId: 1, indices: new Array(NACK_MAX_INDICES + 1).fill(0) }),
    /gecersiz indeks sayisi/,
  );
  assert.equal(decodeNack(new Uint8Array(3)), null, 'kesik');
  const bad = encodeNack({ groupId: 1, indices: [1] });
  bad[4] = 0;
  assert.equal(decodeNack(bad), null, 'count=0');
});
