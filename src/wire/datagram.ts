/**
 * Datagram — kablo uzerindeki tek paket. Sabit 10 baytlik baslik,
 * big-endian, mask/shift ile (bitfield yok).
 *
 *   0      version       uint8    = 0x01
 *   1      flags         uint8    bit7 = is_parity, bit6-0 rezerve (0)
 *   2-3    group_id      uint16 BE
 *   4      index         uint8    source: block_index (0..K-1)
 *                                 parity: r (0..M-1)
 *   5      K             uint8    1..80
 *   6      M             uint8    0..32
 *   7-8    symbol_size   uint16 BE
 *   9      reserved      uint8    = 0
 *   10-    symbol        symbol_size bayt
 *
 * K ve M her datagramda tasinir — alici ilk gelen paketten grubu
 * boyutlandirabilir, repair paketini beklemek zorunda kalmaz.
 */

import { MAX_PAYLOAD_LEN, PU_HEADER_SIZE, roundUp16 } from './protectedUnit.ts';

export const DG_HEADER_SIZE = 10;
export const DG_VERSION = 0x01;

/** flags bayti — bit3..bit0 rezerve, 0 olmali. */
export const FLAG_PARITY = 0x80;
export const FLAG_NACK = 0x40;
export const FLAG_RETRANSMIT = 0x20;
export const FLAG_PING = 0x10;
const FLAG_RESERVED_MASK = 0x0f;

export type PacketKind = 'media' | 'nack' | 'ping' | 'unknown';

/** Baytlara bakmadan once paketin turunu belirler. */
export function packetKind(buf: Uint8Array): PacketKind {
  if (buf.length < 2 || buf[0] !== DG_VERSION) return 'unknown';
  const flags = buf[1];
  if (flags & FLAG_RESERVED_MASK) return 'unknown';
  if (flags & FLAG_PING) return 'ping';
  if (flags & FLAG_NACK) return 'nack';
  return 'media';
}

export const MAX_DATAGRAM = 1200;
/** PU basligi + en buyuk payload, 16'ya yuvarlanmis. 10 + 1168 = 1178 <= 1200. */
export const MAX_SYMBOL_SIZE = roundUp16(PU_HEADER_SIZE + MAX_PAYLOAD_LEN); // 1168

export interface Datagram {
  groupId: number;
  /** source ise blok indeksi, parity ise r */
  index: number;
  isParity: boolean;
  /** ARQ ile yeniden gonderilmis mi — yalniz metriklerde ayrisir */
  isRetransmit?: boolean;
  K: number;
  M: number;
  symbolSize: number;
  symbol: Uint8Array;
}

export function encodeDatagram(dg: Datagram): Uint8Array {
  const size = dg.symbolSize;
  if (size > MAX_SYMBOL_SIZE) throw new RangeError(`datagram: symbol_size ${size} > ${MAX_SYMBOL_SIZE}`);
  if (dg.symbol.length !== size) {
    throw new RangeError(`datagram: sembol boyu ${dg.symbol.length} != symbol_size ${size}`);
  }
  if (dg.K < 1 || dg.K > 80) throw new RangeError(`datagram: K=${dg.K} sinir disi`);
  if (dg.M < 0 || dg.M > 32) throw new RangeError(`datagram: M=${dg.M} sinir disi`);
  if (dg.index > 255) throw new RangeError(`datagram: index=${dg.index} tek bayta sigmiyor`);

  const buf = new Uint8Array(DG_HEADER_SIZE + size);
  const dv = new DataView(buf.buffer);

  buf[0] = DG_VERSION;
  buf[1] = (dg.isParity ? FLAG_PARITY : 0) | (dg.isRetransmit ? FLAG_RETRANSMIT : 0);
  dv.setUint16(2, dg.groupId & 0xffff, false);
  buf[4] = dg.index & 0xff;
  buf[5] = dg.K & 0xff;
  buf[6] = dg.M & 0xff;
  dv.setUint16(7, size, false);
  buf[9] = 0;
  buf.set(dg.symbol, DG_HEADER_SIZE);

  return buf;
}

/** Bozuk/uyumsuz datagramlarda null doner. */
export function decodeDatagram(buf: Uint8Array): Datagram | null {
  if (buf.length < DG_HEADER_SIZE) return null;
  if (buf[0] !== DG_VERSION) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[1];
  if (flags & FLAG_RESERVED_MASK) return null; // rezerve bitler 0 olmali
  if (flags & (FLAG_NACK | FLAG_PING)) return null; // medya datagrami degil

  const isParity = (flags & FLAG_PARITY) !== 0;
  const isRetransmit = (flags & FLAG_RETRANSMIT) !== 0;

  const groupId = dv.getUint16(2, false);
  const index = buf[4];
  const K = buf[5];
  const M = buf[6];
  const symbolSize = dv.getUint16(7, false);

  if (K < 1 || K > 80) return null;
  if (M > 32) return null;
  if (symbolSize === 0 || symbolSize > MAX_SYMBOL_SIZE) return null;
  if (buf.length < DG_HEADER_SIZE + symbolSize) return null;
  if (isParity ? index >= M : index >= K) return null;

  return {
    groupId,
    index,
    isParity,
    isRetransmit,
    K,
    M,
    symbolSize,
    symbol: buf.subarray(DG_HEADER_SIZE, DG_HEADER_SIZE + symbolSize),
  };
}

// --- NACK (ARQ) ---
//
//   0      version   0x01
//   1      flags     bit6 = is_nack
//   2-3    group_id  uint16 BE
//   4      count     uint8   talep edilen sembol sayisi (1..16)
//   5      reserved  0
//   6-     indices   count × uint8   istenen blok indeksleri

export const NACK_HEADER_SIZE = 6;
export const NACK_MAX_INDICES = 16;

export interface NackPacket {
  groupId: number;
  /** blok indeksleri: source 0..K-1, parity K..K+M-1 */
  indices: number[];
}

export function encodeNack(n: NackPacket): Uint8Array {
  const count = n.indices.length;
  if (count < 1 || count > NACK_MAX_INDICES) {
    throw new RangeError(`nack: gecersiz indeks sayisi ${count} (1..${NACK_MAX_INDICES})`);
  }
  const buf = new Uint8Array(NACK_HEADER_SIZE + count);
  const dv = new DataView(buf.buffer);
  buf[0] = DG_VERSION;
  buf[1] = FLAG_NACK;
  dv.setUint16(2, n.groupId & 0xffff, false);
  buf[4] = count;
  buf[5] = 0;
  for (let i = 0; i < count; i++) {
    const idx = n.indices[i];
    if (idx < 0 || idx > 255) throw new RangeError(`nack: indeks ${idx} tek bayta sigmiyor`);
    buf[NACK_HEADER_SIZE + i] = idx;
  }
  return buf;
}

export function decodeNack(buf: Uint8Array): NackPacket | null {
  if (buf.length < NACK_HEADER_SIZE) return null;
  if (buf[0] !== DG_VERSION) return null;
  if ((buf[1] & FLAG_NACK) === 0) return null;
  if (buf[1] & FLAG_RESERVED_MASK) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = buf[4];
  if (count < 1 || count > NACK_MAX_INDICES) return null;
  if (buf.length < NACK_HEADER_SIZE + count) return null;

  const indices: number[] = new Array(count);
  for (let i = 0; i < count; i++) indices[i] = buf[NACK_HEADER_SIZE + i];

  return { groupId: dv.getUint16(2, false), indices };
}

// --- Ping / Pong (RTT olcumu) ---
//
//   0      version   0x01
//   1      flags     bit4 = is_ping
//   2      kind      0 = ping, 1 = pong
//   3      reserved  0
//   4-7    nonce     uint32 BE

export const PING_SIZE = 8;

export interface PingPacket {
  isPong: boolean;
  nonce: number;
}

export function encodePing(p: PingPacket): Uint8Array {
  const buf = new Uint8Array(PING_SIZE);
  const dv = new DataView(buf.buffer);
  buf[0] = DG_VERSION;
  buf[1] = FLAG_PING;
  buf[2] = p.isPong ? 1 : 0;
  buf[3] = 0;
  dv.setUint32(4, p.nonce >>> 0, false);
  return buf;
}

export function decodePing(buf: Uint8Array): PingPacket | null {
  if (buf.length < PING_SIZE) return null;
  if (buf[0] !== DG_VERSION) return null;
  if ((buf[1] & FLAG_PING) === 0) return null;
  if (buf[1] & FLAG_RESERVED_MASK) return null;
  if (buf[2] > 1) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { isPong: buf[2] === 1, nonce: dv.getUint32(4, false) };
}

/** RS kod bloğu icindeki mutlak indeks: source -> index, parity -> K + r */
export function blockIndex(dg: Datagram): number {
  return dg.isParity ? dg.K + dg.index : dg.index;
}

/** group_id uint16 sarmasina dayanikli fark:  a - b, isaretli. */
export function seqDiff(a: number, b: number): number {
  return (((a - b) & 0xffff) ^ 0x8000) - 0x8000;
}
