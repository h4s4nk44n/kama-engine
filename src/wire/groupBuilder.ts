/**
 * Gonderici tarafi FEC grup yonetimi.
 *
 * GONDERIM GRUPLAMADAN AYRIDIR.
 *
 * Source datagrami, fragman uretildigi ANDA kabloya verilir. Grup yalnizca
 * parity'nin hangi semboller uzerinden hesaplanacagini belirler; kapanista
 * SADECE parity datagramlari gonderilir.
 *
 * Neden: eskiden butun grup (source + parity) kapanista birden gonderiliyordu.
 * K_target=16 ve ~4.6 fragman/kare ile bu, ~3.5 karelik bir yigin demekti:
 * kayip sifir olsa bile kareler 4'erli patlamalar hâlinde cikiyor, aralarda
 * ~175 ms bosluk kaliyordu. K_target hem FEC blok boyu hem gonderim yigin
 * boyu olarak calisiyordu; ikisi ayrilinca K buyuk kalabilir ama oynatma
 * puruzsuzlesir.
 *
 * Grup su kosullardan biriyle kapanir:
 *   - K_target paket birikti
 *   - Keyframe chunk'i tamamlandi (aninda kapat)
 *   - window_ms doldu
 *
 * Kapanista: symbol_size = en uzun PU (16'ya yuvarlanmis), tum semboller o
 * boya doldurulur, M = max(1, ceil(K * r)) parity uretilir (ust sinir 32).
 *
 * K/M/symbol_size: source datagramlari bunlari TAHMIN olarak tasir (grup
 * daha kapanmadigi icin gercegi bilinmez). Parity datagramlari gercek
 * degerleri tasir ve alicida OTORITEDIR.
 */

import { getCodec } from '../fec/index.ts';
import { MAX_M } from '../fec/cauchy.ts';
import { buildPU, roundUp16, puRawLength, type ProtectedUnit } from './protectedUnit.ts';
import { encodeDatagram, MAX_SYMBOL_SIZE, type Datagram } from './datagram.ts';

export interface GroupParams {
  /** hedef source sembol sayisi (4..32 arayuzden) */
  kTarget: number;
  /** koruma orani r (0.2..1.2) */
  ratio: number;
  /** grup penceresi, ms */
  windowMs: number;
  /** false ise parity uretilmez (M=0) */
  fecEnabled: boolean;
}

export interface EmittedDatagram {
  datagram: Datagram;
  bytes: Uint8Array;
}

export interface GroupStats {
  groupId: number;
  K: number;
  M: number;
  symbolSize: number;
  sourceBytes: number;
  parityBytes: number;
  /** grubu kapatan sebep — hata ayiklama/metrik icin */
  reason: 'full' | 'keyframe' | 'window' | 'flush';
  /**
   * Grubun tum sembolleri: blok indeksi -> sembol
   * (source 0..K-1, parity K..K+M-1). ARQ gonderici onbellegi bunu saklar.
   */
  symbols: Map<number, Uint8Array>;
}

export interface GroupBuilderOptions {
  /**
   * Fragman uretildigi ANDA cagrilir — source datagrami beklemeden
   * kabloya cikar. Oynatmanin puruzsuzlugu buna bagli.
   */
  onSource: (datagram: EmittedDatagram) => void;
  /** Grup kapandiginda cagrilir — YALNIZ parity datagramlari. */
  onGroup: (parity: EmittedDatagram[], stats: GroupStats) => void;
  params?: Partial<GroupParams>;
}

const DEFAULTS: GroupParams = {
  kTarget: 16,
  ratio: 0.8,
  windowMs: 200,
  fecEnabled: true,
};

export class GroupBuilder {
  private params: GroupParams;
  private readonly onGroup: GroupBuilderOptions['onGroup'];

  /** Gruba giren semboller, KENDI dogal boylarinda (16'ya yuvarlanmis). */
  private pending: Uint8Array[] = [];
  private maxRawLen = 0;
  private groupId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onSource: GroupBuilderOptions['onSource'];

  constructor(opts: GroupBuilderOptions) {
    this.onSource = opts.onSource;
    this.onGroup = opts.onGroup;
    this.params = { ...DEFAULTS, ...opts.params };
    this.clampParams();
  }

  setParams(p: Partial<GroupParams>): void {
    this.params = { ...this.params, ...p };
    this.clampParams();
  }

  getParams(): GroupParams {
    return { ...this.params };
  }

  private clampParams(): void {
    const p = this.params;
    p.kTarget = Math.max(1, Math.min(80, Math.round(p.kTarget)));
    p.ratio = Math.max(0, Math.min(1.2, p.ratio));
    p.windowMs = Math.max(20, Math.min(2000, p.windowMs));
  }

  /**
   * Bir PU'yu gruba ekler. `isChunkTail` PU'nun chunk'in son fragmani
   * oldugunu soyler; keyframe chunk'i tamamlandiysa grup aninda kapanir.
   */
  push(pu: ProtectedUnit): void {
    const raw = puRawLength(pu.payload.length);
    if (raw > MAX_SYMBOL_SIZE) throw new RangeError(`groupBuilder: PU cok buyuk (${raw})`);

    // Sembolu kendi dogal boyunda kur ve HEMEN gonder.
    const index = this.pending.length;
    const ownSize = roundUp16(raw);
    const symbol = buildPU(pu, ownSize);
    this.pending.push(symbol);
    if (raw > this.maxRawLen) this.maxRawLen = raw;

    // K ve M henuz kesin degil (grup kapanmadi) — tahmin tasinir.
    // Parity datagramlari gercek degerleri getirir ve alicida otoritedir.
    const datagram: Datagram = {
      groupId: this.groupId,
      index,
      isParity: false,
      K: this.params.kTarget,
      M: this.predictedM(),
      symbolSize: ownSize,
      symbol,
    };
    this.onSource({ datagram, bytes: encodeDatagram(datagram) });

    const isChunkTail = pu.fragIndex === pu.fragCount - 1;

    if (this.pending.length >= this.params.kTarget) {
      this.close('full');
      return;
    }
    if (pu.keyframe && isChunkTail) {
      // Keyframe'i pencere doluncaya kadar bekletmek gecikmeyi ucurur.
      this.close('keyframe');
      return;
    }
    this.armTimer();
  }

  /** Bekleyen fragmanlari zorla kapatir (akis sonu / yeniden yapilandirma). */
  flush(): void {
    if (this.pending.length > 0) this.close('flush');
  }

  dispose(): void {
    this.disarmTimer();
    this.pending = [];
    this.maxRawLen = 0;
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending.length > 0) this.close('window');
    }, this.params.windowMs);
  }

  private disarmTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Source basliginda tasinacak M tahmini. */
  private predictedM(): number {
    if (!this.params.fecEnabled) return 0;
    return Math.min(MAX_M, Math.max(1, Math.ceil(this.params.kTarget * this.params.ratio)));
  }

  private close(reason: GroupStats['reason']): void {
    this.disarmTimer();

    const natural = this.pending;
    this.pending = [];
    const maxRaw = this.maxRawLen;
    this.maxRawLen = 0;
    if (natural.length === 0) return;

    const K = natural.length;
    const symbolSize = Math.min(MAX_SYMBOL_SIZE, roundUp16(maxRaw));

    // RS icin tum semboller ayni boyda olmali: dogal boydakileri
    // grup symbol_size'ina sifirla doldur. Icerik degismez, CRC yalniz
    // pu_len kadarini kapsar.
    const source: Uint8Array[] = new Array(K);
    for (let i = 0; i < K; i++) {
      const s = natural[i];
      if (s.length === symbolSize) {
        source[i] = s;
      } else {
        const padded = new Uint8Array(symbolSize);
        padded.set(s);
        source[i] = padded;
      }
    }

    // M = max(1, ceil(K * r)), ust sinir MAX_M. FEC kapaliysa M=0.
    const M = this.params.fecEnabled
      ? Math.min(MAX_M, Math.max(1, Math.ceil(K * this.params.ratio)))
      : 0;

    const parity = M > 0 ? getCodec().encode(source, M) : [];

    const groupId = this.groupId;
    this.groupId = (this.groupId + 1) & 0xffff;

    // YALNIZ parity gonderilir — source zaten push() aninda cikti.
    const out: EmittedDatagram[] = new Array(M);
    for (let r = 0; r < M; r++) {
      const datagram: Datagram = {
        groupId,
        index: r,
        isParity: true,
        K,
        M,
        symbolSize,
        symbol: parity[r],
      };
      out[r] = { datagram, bytes: encodeDatagram(datagram) };
    }

    const symbols = new Map<number, Uint8Array>();
    for (let i = 0; i < K; i++) symbols.set(i, source[i]);
    for (let r = 0; r < M; r++) symbols.set(K + r, parity[r]);

    this.onGroup(out, {
      groupId,
      K,
      M,
      symbolSize,
      sourceBytes: K * symbolSize,
      parityBytes: M * symbolSize,
      reason,
      symbols,
    });
  }
}
