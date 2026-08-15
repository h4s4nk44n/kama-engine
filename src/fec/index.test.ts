/**
 * FEC arayuzu testleri: soyutlama davranisi degistirmemeli ve
 * cekirdek gercekten degistirilebilir olmali.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCodec, setCodec, codecName, typeScriptRsCodec, type FecCodec } from './index.ts';
import { encode as rsEncode, decode as rsDecode } from './rs.ts';
import { GroupBuilder } from '../wire/groupBuilder.ts';
import { GroupAssembler } from '../wire/groupAssembler.ts';
import { decodeDatagram } from '../wire/datagram.ts';
import type { ProtectedUnit } from '../wire/protectedUnit.ts';

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

function bytes(n: number, rnd: () => number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

test('varsayilan codec TypeScriptRsCodec', () => {
  assert.equal(codecName(), 'TypeScriptRsCodec');
  assert.equal(getCodec(), typeScriptRsCodec);
});

test('arayuz rs.ts ile birebir ayni sonucu veriyor', () => {
  const rnd = mulberry32(4242);
  const K = 12;
  const M = 7;
  const source = Array.from({ length: K }, () => bytes(64, rnd));

  const viaInterface = getCodec().encode(source, M);
  const viaDirect = rsEncode(source, M);
  assert.deepEqual(viaInterface, viaDirect);

  const codeword = source.concat(viaInterface);
  const present = codeword.map((symbol, index) => ({ index, symbol })).filter((_, i) => i % 3 !== 0);

  assert.deepEqual(getCodec().decode(present, K, M), rsDecode(present, K, M));
});

test('setCodec cekirdegi gercekten degistiriyor (WASM icin hazir)', () => {
  const calls = { encode: 0, decode: 0 };

  // Sahte "yabanci" cekirdek: ayni matematigi kullanir ama cagrilari sayar.
  // Gercekte burada WASM export'lari olacak.
  const spyCodec: FecCodec = {
    name: 'SpyCodec',
    encode: (s, m) => {
      calls.encode++;
      return rsEncode(s, m);
    },
    decode: (p, k, m) => {
      calls.decode++;
      return rsDecode(p, k, m);
    },
  };

  try {
    setCodec(spyCodec);
    assert.equal(codecName(), 'SpyCodec');

    // Wire katmani da yeni cekirdegi kullanmali — rs.ts'e dogrudan
    // bagli kalan bir cagri yeri varsa bu test onu yakalar.
    const rnd = mulberry32(77);
    const seen: ProtectedUnit[] = [];
    const asm = new GroupAssembler({ useFec: true, onPU: (pu) => seen.push(pu) });

    // Ilk iki source'u dusur ki decode calissin.
    // Source datagramlari aninda cikar, parity kapanista.
    const feed = (e: { bytes: Uint8Array; datagram: { isParity: boolean; index: number } }): void => {
      if (!e.datagram.isParity && e.datagram.index < 2) return;
      asm.push(decodeDatagram(e.bytes)!, 0);
    };
    const builder = new GroupBuilder({
      params: { kTarget: 8, ratio: 0.8, fecEnabled: true, windowMs: 5000 },
      onSource: feed,
      onGroup: (parity) => {
        for (const e of parity) feed(e);
      },
    });

    for (let i = 0; i < 8; i++) {
      builder.push({
        chunkId: 0,
        keyframe: false,
        fragIndex: i,
        fragCount: 8,
        payload: bytes(200, rnd),
      });
    }
    builder.flush();
    builder.dispose();
    asm.tick(10_000);

    assert.ok(calls.encode > 0, 'groupBuilder arayuzden encode cagirmali');
    assert.ok(calls.decode > 0, 'groupAssembler arayuzden decode cagirmali');
    assert.equal(seen.length, 8, 'kurtarma yine tam olmali');
  } finally {
    setCodec(typeScriptRsCodec);
  }

  assert.equal(codecName(), 'TypeScriptRsCodec', 'test sonrasi varsayilana donmeli');
});
