/**
 * Kayip enjektoru testleri. Kritik ozellik: source kayip deseni
 * parity sayisindan (yani FEC oranindan) BAGIMSIZ olmali.
 *   node --test src/net/loss.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LossInjector, GE_R, type LossModel } from './lossInjector.ts';

/** K source + M parity dizisini kosturur, source kararlarini dondurur. */
function sourcePattern(inj: LossInjector, groups: number, K: number, M: number): boolean[] {
  const out: boolean[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < K; i++) out.push(inj.shouldDrop(false));
    for (let r = 0; r < M; r++) inj.shouldDrop(true);
  }
  return out;
}

for (const model of ['iid', 'gilbert'] as LossModel[]) {
  test(`${model}: source kayip deseni parity sayisindan bagimsiz`, () => {
    const a = new LossInjector(1234);
    a.setLoss(0.3, model);
    const patternNoFec = sourcePattern(a, 40, 16, 0);

    for (const M of [1, 7, 13, 32]) {
      const b = new LossInjector(1234);
      b.setLoss(0.3, model);
      const pattern = sourcePattern(b, 40, 16, M);
      assert.deepEqual(pattern, patternNoFec, `M=${M} source desenini kaydirmamali`);
    }
  });

  test(`${model}: ayni tohum ayni deseni uretiyor`, () => {
    const a = new LossInjector(99);
    const b = new LossInjector(99);
    a.setLoss(0.42, model);
    b.setLoss(0.42, model);
    assert.deepEqual(sourcePattern(a, 30, 8, 4), sourcePattern(b, 30, 8, 4));
  });

  test(`${model}: reseed() deseni basa sariyor`, () => {
    const inj = new LossInjector(7);
    inj.setLoss(0.25, model);
    const first = sourcePattern(inj, 20, 12, 6);
    inj.reseed();
    inj.setLoss(0.25, model);
    assert.deepEqual(sourcePattern(inj, 20, 12, 6), first);
  });

  test(`${model}: p=0 -> hic kayip yok, p yuksek -> kayip var`, () => {
    const inj = new LossInjector(5);
    inj.setLoss(0, model);
    assert.equal(sourcePattern(inj, 50, 16, 8).filter(Boolean).length, 0);

    inj.setLoss(0.5, model);
    assert.ok(sourcePattern(inj, 50, 16, 8).filter(Boolean).length > 0);
  });

  test(`${model}: gerceklesen kayip orani hedefe yakin`, () => {
    for (const p of [0.1, 0.3, 0.45]) {
      const inj = new LossInjector(0xabcdef);
      inj.setLoss(p, model);
      const pattern = sourcePattern(inj, 4000, 16, 0);
      const actual = pattern.filter(Boolean).length / pattern.length;
      assert.ok(
        Math.abs(actual - p) < 0.03,
        `${model} p=${p}: gerceklesen ${actual.toFixed(4)} hedeften uzak`,
      );
    }
  });
}

test('gilbert: kayiplar kumeleniyor (i.i.d.den daha uzun burst)', () => {
  function meanBurst(model: LossModel): number {
    const inj = new LossInjector(2468);
    inj.setLoss(0.3, model);
    const pattern = sourcePattern(inj, 4000, 16, 0);
    let bursts = 0;
    let lost = 0;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i]) {
        lost++;
        if (i === 0 || !pattern[i - 1]) bursts++;
      }
    }
    return lost / bursts;
  }

  const ge = meanBurst('gilbert');
  const iid = meanBurst('iid');
  // r=0.632 sabit oldugu icin burst'ler cok uzun degil: teorik ortalama
  // 1/pBG = 1.58, i.i.d. p=0.3'te ise 1/(1-p) = 1.43.
  assert.ok(ge > iid, `GE burst (${ge.toFixed(2)}) i.i.d.den (${iid.toFixed(2)}) uzun olmali`);
  assert.ok(Math.abs(ge - 1 / GE_R) < 0.2, `GE ortalama burst ${ge.toFixed(2)}, beklenen ~${(1 / GE_R).toFixed(2)}`);
  assert.ok(Math.abs(iid - 1 / (1 - 0.3)) < 0.15, `i.i.d. ortalama burst ${iid.toFixed(2)}, beklenen ~1.43`);
});

test('sayaclar source ve parity icin ayri tutuluyor', () => {
  const inj = new LossInjector(31);
  inj.setLoss(0.3, 'iid');
  sourcePattern(inj, 100, 10, 5);
  assert.equal(inj.stats.sourceSent, 1000);
  assert.equal(inj.stats.paritySent, 500);
  assert.ok(inj.stats.sourceDropped > 0 && inj.stats.parityDropped > 0);
  assert.ok(inj.stats.sourceDropped < inj.stats.sourceSent);
});
