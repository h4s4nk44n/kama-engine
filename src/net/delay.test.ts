/**
 * Yapay gecikme kuyrugu ve RTT olcumu testleri.
 *   node --test src/net/delay.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DelayQueue, RttMeter } from './delayQueue.ts';
import { encodePing, decodePing, packetKind, encodeDatagram, decodeDatagram, FLAG_RETRANSMIT } from '../wire/datagram.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u8 = (n: number) => Uint8Array.from([n]);

test('gecikme 0 ve kuyruk bos ise paket senkron gecer', () => {
  const q = new DelayQueue(() => 0);
  const out: number[] = [];
  q.send(u8(1), (d) => out.push(d[0]));
  assert.deepEqual(out, [1], 'gereksiz setTimeout gecikmesi eklenmemeli');
  q.dispose();
});

test('gecikme uygulaniyor ve paket hemen teslim edilmiyor', async () => {
  const q = new DelayQueue(() => 40);
  const out: number[] = [];
  q.send(u8(7), (d) => out.push(d[0]));
  assert.deepEqual(out, [], 'hemen teslim edilmemeli');
  await sleep(120);
  assert.deepEqual(out, [7]);
  q.dispose();
});

test('SIRA KORUNUMU: gecikme calisirken dusse bile FIFO bozulmuyor', async () => {
  let delay = 150;
  const q = new DelayQueue(() => delay);
  const out: number[] = [];
  const sink = (d: Uint8Array) => out.push(d[0]);

  q.send(u8(1), sink); // 150 ms gecikmeyle kuyruga girer
  delay = 0; // slider sifira cekildi
  q.send(u8(2), sink); // gecikmesiz ama SIRAYI bozmamali
  q.send(u8(3), sink);

  await sleep(300);
  assert.deepEqual(out, [1, 2, 3], 'paketler gonderim sirasinda teslim edilmeli');
  q.dispose();
});

test('SIRA KORUNUMU: gecikme calisirken artsa da FIFO korunuyor', async () => {
  let delay = 10;
  const q = new DelayQueue(() => delay);
  const out: number[] = [];
  const sink = (d: Uint8Array) => out.push(d[0]);

  q.send(u8(1), sink);
  delay = 120;
  q.send(u8(2), sink);
  delay = 10;
  q.send(u8(3), sink);

  await sleep(350);
  assert.deepEqual(out, [1, 2, 3]);
  q.dispose();
});

test('gecikme paket kuyruga GIRERKEN sabitleniyor', async () => {
  let delay = 200;
  const q = new DelayQueue(() => delay);
  const out: number[] = [];
  q.send(u8(9), (d) => out.push(d[0]));
  delay = 0; // kuyruktaki paketi etkilememeli

  await sleep(80);
  assert.deepEqual(out, [], 'kuyruktaki paketin gecikmesi sonradan degismemeli');
  await sleep(250);
  assert.deepEqual(out, [9]);
  q.dispose();
});

test('dispose bekleyen paketleri iptal ediyor (sizinti yok)', async () => {
  const q = new DelayQueue(() => 60);
  const out: number[] = [];
  for (let i = 0; i < 5; i++) q.send(u8(i), (d) => out.push(d[0]));
  assert.equal(q.stats.pending, 5);
  q.dispose();
  await sleep(150);
  assert.deepEqual(out, [], 'dispose sonrasi teslim olmamali');
  assert.equal(q.stats.pending, 0);
});

test('sayaclar: enqueued / delivered / peakPending', async () => {
  const q = new DelayQueue(() => 30);
  for (let i = 0; i < 4; i++) q.send(u8(i), () => {});
  assert.equal(q.stats.enqueued, 4);
  assert.equal(q.stats.peakPending, 4);
  await sleep(140);
  assert.equal(q.stats.delivered, 4);
  assert.equal(q.stats.pending, 0);
  q.dispose();
});

// --- RTT olcumu ---

test('RttMeter ping/pong turunu olcuyor', () => {
  let clock = 1000;
  const m = new RttMeter(0.25, () => clock);

  const n1 = m.startPing();
  clock += 80;
  m.onPong(n1);
  assert.equal(m.lastSampleMs, 80);
  assert.equal(m.measuredRttMs, 80, 'ilk ornek dogrudan alinir');

  const n2 = m.startPing();
  clock += 40;
  m.onPong(n2);
  // EWMA: 0.25*40 + 0.75*80 = 70
  assert.equal(m.measuredRttMs, 70);
});

test('RttMeter bilinmeyen nonce\'u yok sayiyor', () => {
  let clock = 0;
  const m = new RttMeter(0.25, () => clock);
  m.onPong(12345);
  assert.equal(m.samples, 0);
  assert.equal(m.measuredRttMs, 0);
});

test('RttMeter yanitsiz ping birikmesini sinirliyor', () => {
  const m = new RttMeter();
  for (let i = 0; i < 200; i++) m.startPing();
  // ic harita sinirli kalmali; son ping yine olculebilmeli
  const n = m.startPing();
  m.onPong(n);
  assert.equal(m.samples, 1);
});

// --- ping datagrami ---

test('ping/pong kodlama gidis donus', () => {
  const ping = encodePing({ isPong: false, nonce: 0xdeadbeef });
  assert.equal(packetKind(ping), 'ping');
  const p = decodePing(ping);
  assert.ok(p);
  assert.equal(p.isPong, false);
  assert.equal(p.nonce, 0xdeadbeef);

  const pong = encodePing({ isPong: true, nonce: 7 });
  const q = decodePing(pong);
  assert.ok(q);
  assert.equal(q.isPong, true);
  assert.equal(q.nonce, 7);
});

test('packetKind medya ve ping\'i ayirt ediyor', () => {
  const media = encodeDatagram({
    groupId: 1, index: 0, isParity: false, K: 4, M: 2, symbolSize: 32, symbol: new Uint8Array(32),
  });
  assert.equal(packetKind(media), 'media');
  assert.equal(packetKind(encodePing({ isPong: false, nonce: 1 })), 'ping');
  assert.equal(packetKind(Uint8Array.from([0x02, 0x00])), 'unknown', 'yanlis surum');
  assert.equal(packetKind(Uint8Array.from([0x01, 0x01])), 'unknown', 'rezerve bit set');
});

test('medya cozucusu ping paketini medya sanmiyor', () => {
  assert.equal(decodeDatagram(encodePing({ isPong: false, nonce: 3 })), null);
});

test('is_retransmit bayragi tasiniyor', () => {
  const dg = encodeDatagram({
    groupId: 5, index: 2, isParity: false, isRetransmit: true,
    K: 8, M: 4, symbolSize: 48, symbol: new Uint8Array(48).fill(3),
  });
  assert.equal(dg[1] & FLAG_RETRANSMIT, FLAG_RETRANSMIT);
  const out = decodeDatagram(dg);
  assert.ok(out);
  assert.equal(out.isRetransmit, true);
  assert.equal(out.isParity, false);

  const normal = decodeDatagram(
    encodeDatagram({ groupId: 5, index: 2, isParity: false, K: 8, M: 4, symbolSize: 48, symbol: new Uint8Array(48) }),
  );
  assert.equal(normal?.isRetransmit, false);
});

test('parity + retransmit bayraklari birlikte calisiyor', () => {
  const out = decodeDatagram(
    encodeDatagram({
      groupId: 9, index: 1, isParity: true, isRetransmit: true,
      K: 6, M: 3, symbolSize: 16, symbol: new Uint8Array(16),
    }),
  );
  assert.ok(out);
  assert.equal(out.isParity, true);
  assert.equal(out.isRetransmit, true);
});
