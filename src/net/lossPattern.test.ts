/**
 * Ortak kayip deseni testleri — uc panelin ayni deseni gormesi buna bagli.
 *   node --test src/net/lossPattern.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LossPattern, GE_R, type LossModel } from './lossPattern.ts';

const MODELS: LossModel[] = ['iid', 'gilbert'];

for (const model of MODELS) {
  test(`${model}: ayni ordinal her sorulusta ayni cevap (memoize)`, () => {
    const lp = new LossPattern(1234);
    lp.setLoss(0.3, model);

    const first: boolean[] = [];
    for (let i = 0; i < 500; i++) first.push(lp.isLost(i));

    // Uc panel ayni ordinal'leri sorar — hepsi ayni cevabi almali
    for (let panel = 0; panel < 3; panel++) {
      for (let i = 0; i < 500; i++) {
        assert.equal(lp.isLost(i), first[i], `panel ${panel}, ordinal ${i}`);
      }
    }
  });

  test(`${model}: sorgu sirasi karisik olsa da karar degismiyor`, () => {
    const a = new LossPattern(99);
    const b = new LossPattern(99);
    a.setLoss(0.35, model);
    b.setLoss(0.35, model);

    const sirali: boolean[] = [];
    for (let i = 0; i < 300; i++) sirali.push(a.isLost(i));

    // b'ye once ileriyi sor, sonra geriye don
    b.isLost(299);
    const karisik: boolean[] = new Array(300);
    for (let i = 299; i >= 0; i--) karisik[i] = b.isLost(i);

    assert.deepEqual(karisik, sirali);
  });

  test(`${model}: ayni tohum ayni desen hash'i uretiyor`, () => {
    const a = new LossPattern(7);
    const b = new LossPattern(7);
    a.setLoss(0.4, model);
    b.setLoss(0.4, model);
    for (let i = 0; i < 1000; i++) {
      a.isLost(i);
      b.isLost(i);
    }
    assert.equal(a.patternHash(), b.patternHash());
  });

  test(`${model}: farkli tohum farkli desen`, () => {
    const a = new LossPattern(1);
    const b = new LossPattern(2);
    a.setLoss(0.3, model);
    b.setLoss(0.3, model);
    for (let i = 0; i < 1000; i++) {
      a.isLost(i);
      b.isLost(i);
    }
    assert.notEqual(a.patternHash(), b.patternHash());
  });

  test(`${model}: p=0 -> hic kayip yok`, () => {
    const lp = new LossPattern(5);
    lp.setLoss(0, model);
    for (let i = 0; i < 1000; i++) assert.equal(lp.isLost(i), false);
  });

  test(`${model}: gerceklesen kayip orani hedefe yakin`, () => {
    for (const p of [0.1, 0.3, 0.45]) {
      const lp = new LossPattern(0xabcdef);
      lp.setLoss(p, model);
      let lost = 0;
      const n = 60000;
      for (let i = 0; i < n; i++) if (lp.isLost(i)) lost++;
      const actual = lost / n;
      assert.ok(Math.abs(actual - p) < 0.02, `${model} p=${p}: gerceklesen ${actual.toFixed(4)}`);
    }
  });

  test(`${model}: reset deseni basa sariyor`, () => {
    const lp = new LossPattern(11);
    lp.setLoss(0.25, model);
    const first: boolean[] = [];
    for (let i = 0; i < 200; i++) first.push(lp.isLost(i));
    const h = lp.patternHash();

    lp.reset();
    lp.setLoss(0.25, model);
    const second: boolean[] = [];
    for (let i = 0; i < 200; i++) second.push(lp.isLost(i));

    assert.deepEqual(second, first);
    assert.equal(lp.patternHash(), h);
  });
}

test('gilbert: kayiplar kumeleniyor, ortalama burst ~1/r', () => {
  function meanBurst(model: LossModel): number {
    const lp = new LossPattern(2468);
    lp.setLoss(0.3, model);
    let bursts = 0;
    let lost = 0;
    let prev = false;
    for (let i = 0; i < 60000; i++) {
      const cur = lp.isLost(i);
      if (cur) {
        lost++;
        if (!prev) bursts++;
      }
      prev = cur;
    }
    return lost / bursts;
  }

  const ge = meanBurst('gilbert');
  const iid = meanBurst('iid');
  assert.ok(ge > iid, `GE burst (${ge.toFixed(2)}) i.i.d.den (${iid.toFixed(2)}) uzun olmali`);
  assert.ok(Math.abs(ge - 1 / GE_R) < 0.15, `GE ortalama burst ${ge.toFixed(2)}, beklenen ~${(1 / GE_R).toFixed(2)}`);
});

test('gilbert: tek durum makinesi — uc panel ayni burst\'leri yasiyor', () => {
  const lp = new LossPattern(4321);
  lp.setLoss(0.35, 'gilbert');

  // Panel 1 tum ordinal'leri gezer
  const panel1: boolean[] = [];
  for (let i = 0; i < 400; i++) panel1.push(lp.isLost(i));

  // Panel 2 ve 3 ayni ordinal'leri farkli zamanlarda sorar
  const panel2 = panel1.map((_, i) => lp.isLost(i));
  const panel3: boolean[] = [];
  for (let i = 0; i < 400; i += 7) for (let j = i; j < Math.min(i + 7, 400); j++) panel3[j] = lp.isLost(j);

  assert.deepEqual(panel2, panel1);
  assert.deepEqual(panel3, panel1);
});

test('ayri akislar birbirinin desenini kaydirmiyor (medya vs retransmit)', () => {
  // Retransmit paketleri AYRI bir ordinal uzayi kullanir; boylece ARQ
  // acikken bile ana desen degismez ve uc panel karsilastirilabilir kalir.
  const main = new LossPattern(0x6b616d61);
  const rtx = new LossPattern(0x6b616d61 ^ 0x5bf03635);
  main.setLoss(0.3, 'iid');
  rtx.setLoss(0.3, 'iid');

  const withoutRtx: boolean[] = [];
  for (let i = 0; i < 500; i++) withoutRtx.push(main.isLost(i));

  const main2 = new LossPattern(0x6b616d61);
  const rtx2 = new LossPattern(0x6b616d61 ^ 0x5bf03635);
  main2.setLoss(0.3, 'iid');
  rtx2.setLoss(0.3, 'iid');

  const withRtx: boolean[] = [];
  let rtxOrdinal = 0;
  for (let i = 0; i < 500; i++) {
    withRtx.push(main2.isLost(i));
    // araya retransmit trafigi karistir
    if (i % 3 === 0) rtx2.isLost(rtxOrdinal++);
  }

  assert.deepEqual(withRtx, withoutRtx, 'retransmit trafigi ana deseni kaydirmamali');
  assert.equal(main2.patternHash(), main.patternHash());
});
