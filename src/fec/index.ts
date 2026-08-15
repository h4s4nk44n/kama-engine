/**
 * FEC cekirdegi icin degistirilebilir arayuz.
 *
 * Motorun geri kalani rs.ts'i DOGRUDAN import etmez; her sey buradan
 * gecer. Ileride C++/WASM cekirdek takildiginda tek yapilacak sey
 * setCodec() ile baska bir uygulama gecirmektir — cagri yerlerini tek
 * tek bulmak gerekmez.
 */

import { encode as rsEncode, decode as rsDecode, type PresentSymbol } from './rs.ts';

export { InsufficientSymbols, SingularMatrix, type PresentSymbol } from './rs.ts';

export interface FecCodec {
  readonly name: string;
  encode(source: Uint8Array[], M: number): Uint8Array[];
  decode(present: PresentSymbol[], K: number, M: number): Uint8Array[];
}

/** Saf TypeScript Reed-Solomon (Cauchy, yalniz silinti). */
export const typeScriptRsCodec: FecCodec = {
  name: 'TypeScriptRsCodec',
  encode: rsEncode,
  decode: rsDecode,
};

let active: FecCodec = typeScriptRsCodec;

/** Tum cagri yerleri codec'i BURADAN alir. */
export function getCodec(): FecCodec {
  return active;
}

/** Cekirdegi degistirir (or. WasmRsCodec). Ad arayuzde gorunur. */
export function setCodec(codec: FecCodec): void {
  active = codec;
}

export function codecName(): string {
  return active.name;
}
