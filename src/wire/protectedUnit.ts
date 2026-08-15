/**
 * Protected Unit (PU) — her medya fragmani once bir PU'ya sarilir,
 * sonra gruptaki symbol_size'a sifirla doldurulur.
 *
 *   0-1    pu_len        uint16 BE   = 12 + payload_len
 *   2-5    chunk_id      uint32 BE   encoder chunk sayaci
 *   6      chunk_flags   uint8       bit7 = keyframe
 *   7-8    frag_index    uint16 BE
 *   9-10   frag_count    uint16 BE
 *   11-12  pu_crc        uint16 BE   CRC-16/CCITT-FALSE
 *   13-    payload
 *
 * NOT: sartname pu_len'i "= 12 + payload_len (byte 2'den sona)" diye
 * tarifliyor; bu iki ifade bir bayt kayiyor (byte 2..12 = 11 bayt).
 * Normatif olan formul alindi: pu_len = 12 + payload_len.
 * Cozumlemede payload_len = pu_len - 12 ile geri elde edilir.
 *
 * pu_crc: poly 0x1021, init 0xFFFF, yansima yok, xorout 0x0000.
 * Bayt 0-10 VE payload uzerinde hesaplanir; crc alaninin kendisi
 * (bayt 11-12) hesaba girmez.
 */

export const PU_HEADER_SIZE = 13;
/** pu_len alani = payload_len + PU_LEN_BIAS */
export const PU_LEN_BIAS = 12;

/** Datagram <= 1200 bayt kisiti icinden turetilen ust sinir. */
export const MAX_PAYLOAD_LEN = 1152;

export const FLAG_KEYFRAME = 0x80;

export interface ProtectedUnit {
  chunkId: number;
  keyframe: boolean;
  fragIndex: number;
  fragCount: number;
  payload: Uint8Array;
}

// --- CRC-16/CCITT-FALSE ---

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    t[i] = crc;
  }
  return t;
})();

/** Tabloyla CRC-16/CCITT-FALSE. crc parametresi zincirleme icin. */
export function crc16(data: Uint8Array, start = 0, end = data.length, crc = 0xffff): number {
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

/** PU icin CRC: bayt 0-10 + payload (crc alani atlanir). */
function computePuCrc(buf: Uint8Array, payloadEnd: number): number {
  const c = crc16(buf, 0, 11);
  return crc16(buf, PU_HEADER_SIZE, payloadEnd, c);
}

/**
 * PU'yu serilestirir. `symbolSize` verilirse sonuc o boya sifirla
 * doldurulur (FEC sembolu olarak dogrudan kullanilabilir).
 */
export function buildPU(pu: ProtectedUnit, symbolSize?: number): Uint8Array {
  const payloadLen = pu.payload.length;
  if (payloadLen > MAX_PAYLOAD_LEN) {
    throw new RangeError(`PU: payload ${payloadLen} > ${MAX_PAYLOAD_LEN}`);
  }
  const rawLen = PU_HEADER_SIZE + payloadLen;
  const outLen = symbolSize ?? rawLen;
  if (outLen < rawLen) throw new RangeError(`PU: symbolSize ${outLen} < gerekli ${rawLen}`);

  const buf = new Uint8Array(outLen);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  dv.setUint16(0, payloadLen + PU_LEN_BIAS, false);
  dv.setUint32(2, pu.chunkId >>> 0, false);
  buf[6] = pu.keyframe ? FLAG_KEYFRAME : 0;
  dv.setUint16(7, pu.fragIndex, false);
  dv.setUint16(9, pu.fragCount, false);
  // 11-12 crc — once payload yazilir, sonra hesaplanir
  buf.set(pu.payload, PU_HEADER_SIZE);

  dv.setUint16(11, computePuCrc(buf, rawLen), false);
  return buf;
}

export class CrcMismatch extends Error {
  constructor() {
    super('PU: crc uyusmadi');
    this.name = 'CrcMismatch';
  }
}

/**
 * Doldurulmus bir sembolden PU'yu cozer ve CRC'yi dogrular.
 * Bozuksa null doner (cagiran sayaci artirir, sembolu iskarta eder).
 */
export function parsePU(symbol: Uint8Array): ProtectedUnit | null {
  if (symbol.length < PU_HEADER_SIZE) return null;

  const dv = new DataView(symbol.buffer, symbol.byteOffset, symbol.byteLength);
  const puLen = dv.getUint16(0, false);
  const payloadLen = puLen - PU_LEN_BIAS;

  if (payloadLen < 0 || payloadLen > MAX_PAYLOAD_LEN) return null;
  const rawLen = PU_HEADER_SIZE + payloadLen;
  if (rawLen > symbol.length) return null;

  const stored = dv.getUint16(11, false);
  if (computePuCrc(symbol, rawLen) !== stored) return null;

  const fragIndex = dv.getUint16(7, false);
  const fragCount = dv.getUint16(9, false);
  // CRC gecse bile mantiksal tutarlilik aranir
  if (fragCount === 0 || fragIndex >= fragCount) return null;

  return {
    chunkId: dv.getUint32(2, false),
    keyframe: (symbol[6] & FLAG_KEYFRAME) !== 0,
    fragIndex,
    fragCount,
    // Kopya: sembol tamponu grup temizliginde yeniden kullanilabilir
    payload: symbol.slice(PU_HEADER_SIZE, rawLen),
  };
}

/** Bir PU'nun doldurma oncesi ham uzunlugu. */
export function puRawLength(payloadLen: number): number {
  return PU_HEADER_SIZE + payloadLen;
}

/** symbol_size = gruptaki en uzun PU'nun 16'ya yukari yuvarlanmisi. */
export function roundUp16(n: number): number {
  return (n + 15) & ~15;
}
