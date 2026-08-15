/**
 * ARQ — deadline fizibilitesine bagli, secici retransmit.
 *
 * FEC'in kacirdigini toplar. Kor retransmit yapan bir sistemden ayiran
 * sey su: RTT buyudukce KENDINI KAPATIR. Bir grubun deadline'ina kalan
 * sure bir gidis-donusu kaldirmiyorsa NACK hic uretilmez.
 *
 *   remaining   = groupDeadline - now
 *   rttEst      = artificialRttMs + measuredRttMs
 *   feasible    = remaining > rttEst * 1.1 + DECODE_BUDGET_MS
 *   maxRetries  = feasible ? min(3, floor((remaining - DECODE_BUDGET_MS) / (rttEst * 1.1))) : 0
 *
 * groupDeadline hakkinda: 600 ms'lik butce grubun YAKALANMA aninda baslar,
 * alicinin onu ilk gordugu anda degil. Paket alicaya ulasana kadar tek yon
 * gecikme kadari zaten harcanmistir:
 *
 *   groupDeadline = ilkVaris + 600ms - rttEst/2
 *
 * Bu duzeltme olmadan 400 ms RTT'de bile bir tur "sigiyor" gorunur ve ARQ
 * kendini kapatmaz; oysa gelen sembol zaten oynatma penceresini kacirmis
 * olur. Duzeltmeyle max_retries RTT ile 3 -> 2 -> 1 -> 0 diye duser.
 *
 * Amplifikasyon korumasi (ikisi de zorunlu):
 *   - ayni (group_id, index) icin min_resend_interval gecmeden tekrar NACK yok
 *   - giden retransmit bayti / toplam gonderilen bayt <= 0.15
 * Bunlar olmadan ARQ kotu agda kendi kendini besler.
 */

import {
  encodeDatagram,
  encodeNack,
  NACK_MAX_INDICES,
  type Datagram,
} from '../wire/datagram.ts';
import type { OpenGroupView } from '../wire/groupAssembler.ts';

/** Grup deadline'i — GroupAssembler'in zaman asimi ile ayni. */
export const GROUP_DEADLINE_MS = 600;
/** Kurtarma + decode icin ayrilan pay. */
export const DECODE_BUDGET_MS = 15;
/** Grup basina en fazla NACK turu. */
export const MAX_NACK_ROUNDS = 3;
/** Giden retransmit orani ust siniri. */
export const RTX_BUDGET = 0.15;
/**
 * Grup ilk gorulduğunde hemen NACK uretmeyiz: ayni gruba ait paketler
 * gecikme kuyrugunda birbirine yakin ama esit olmayan anlarda gelir.
 */
export const NACK_SETTLE_MS = 40;

// ============================================================
// Gonderici tarafi: sembol onbellegi
// ============================================================

export const CACHE_MAX_GROUPS = 8;
export const CACHE_TTL_MS = 600;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface CachedGroup {
  groupId: number;
  /** blok indeksi -> sembol (source: 0..K-1, parity: K..K+M-1) */
  symbols: Map<number, Uint8Array>;
  K: number;
  M: number;
  symbolSize: number;
  closedAt: number;
  bytes: number;
}

export interface CacheStats {
  groups: number;
  bytes: number;
  /** sinir asildigi icin atilan grup */
  evictedByLimit: number;
  /** deadline gectigi icin atilan grup */
  evictedByAge: number;
  /** onbellekte olmayan index istendi */
  missed: number;
  served: number;
}

/**
 * Kapanan her FEC grubunun tum sembolleri burada tutulur.
 * SINIRLAR ZORUNLU — sinirsiz onbellek bellek sizintisidir.
 */
export class SenderSymbolCache {
  readonly stats: CacheStats = {
    groups: 0,
    bytes: 0,
    evictedByLimit: 0,
    evictedByAge: 0,
    missed: 0,
    served: 0,
  };

  /** Ekleme sirasini korur — en eski ilk sirada. */
  private groups = new Map<number, CachedGroup>();
  private totalBytes = 0;

  store(
    groupId: number,
    K: number,
    M: number,
    symbolSize: number,
    symbols: Map<number, Uint8Array>,
    nowMs: number,
  ): void {
    let bytes = 0;
    for (const s of symbols.values()) bytes += s.length;

    this.groups.set(groupId, { groupId, symbols, K, M, symbolSize, closedAt: nowMs, bytes });
    this.totalBytes += bytes;
    this.enforceLimits(nowMs);
    this.syncStats();
  }

  /**
   * Istenen sembolu retransmit datagrami olarak uretir.
   * Kural 3: onbellekte olmayan index sessizce yok sayilir (null).
   * Kural 4: deadline'i gecmis gruba yanit verilmez (null).
   */
  buildRetransmit(groupId: number, blockIndex: number, nowMs: number): Uint8Array | null {
    const g = this.groups.get(groupId);
    if (!g) {
      this.stats.missed++;
      return null;
    }
    if (nowMs - g.closedAt > CACHE_TTL_MS) {
      this.stats.missed++;
      return null;
    }
    const symbol = g.symbols.get(blockIndex);
    if (!symbol) {
      this.stats.missed++;
      return null;
    }

    const isParity = blockIndex >= g.K;
    const dg: Datagram = {
      groupId,
      index: isParity ? blockIndex - g.K : blockIndex,
      isParity,
      isRetransmit: true,
      K: g.K,
      M: g.M,
      symbolSize: g.symbolSize,
      symbol,
    };
    this.stats.served++;
    return encodeDatagram(dg);
  }

  /** Periyodik cagrilir: yaslanan gruplari atar. */
  prune(nowMs: number): void {
    for (const [id, g] of [...this.groups]) {
      if (nowMs - g.closedAt > CACHE_TTL_MS) {
        this.groups.delete(id);
        this.totalBytes -= g.bytes;
        this.stats.evictedByAge++;
      }
    }
    this.syncStats();
  }

  private enforceLimits(nowMs: number): void {
    // 1) Yasi gecenler
    for (const [id, g] of [...this.groups]) {
      if (nowMs - g.closedAt > CACHE_TTL_MS) {
        this.groups.delete(id);
        this.totalBytes -= g.bytes;
        this.stats.evictedByAge++;
      }
    }
    // 2) Grup sayisi ve toplam bayt
    while (this.groups.size > CACHE_MAX_GROUPS || this.totalBytes > CACHE_MAX_BYTES) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      const g = this.groups.get(oldest)!;
      this.groups.delete(oldest);
      this.totalBytes -= g.bytes;
      this.stats.evictedByLimit++;
    }
  }

  private syncStats(): void {
    this.stats.groups = this.groups.size;
    this.stats.bytes = this.totalBytes;
  }

  reset(): void {
    this.groups.clear();
    this.totalBytes = 0;
    this.stats.groups = 0;
    this.stats.bytes = 0;
    this.stats.evictedByLimit = 0;
    this.stats.evictedByAge = 0;
    this.stats.missed = 0;
    this.stats.served = 0;
  }
}

// ============================================================
// Gonderici tarafi: RTX butcesi
// ============================================================

export class RtxBudget {
  rtxBytes = 0;
  exceeded = 0;

  /** @param totalBytesSent toplam giden bayt (retransmit dahil) */
  allows(totalBytesSent: number, nextBytes: number): boolean {
    const total = totalBytesSent + nextBytes;
    if (total <= 0) return true;
    const ratio = (this.rtxBytes + nextBytes) / total;
    if (ratio > RTX_BUDGET) {
      this.exceeded++;
      return false;
    }
    return true;
  }

  note(bytes: number): void {
    this.rtxBytes += bytes;
  }

  used(totalBytesSent: number): number {
    return totalBytesSent > 0 ? this.rtxBytes / totalBytesSent : 0;
  }

  reset(): void {
    this.rtxBytes = 0;
    this.exceeded = 0;
  }
}

// ============================================================
// Alici tarafi: eksik tespiti, fizibilite, NACK uretimi
// ============================================================

export interface Feasibility {
  feasible: boolean;
  maxRetries: number;
  remainingMs: number;
  rttEstMs: number;
}

/** Sartnamedeki fizibilite aritmetigi — tek yerde. */
export function feasibility(remainingMs: number, rttEstMs: number): Feasibility {
  const budget = rttEstMs * 1.1;
  const feasible = remainingMs > budget + DECODE_BUDGET_MS;
  const maxRetries = feasible
    ? Math.min(MAX_NACK_ROUNDS, Math.floor((remainingMs - DECODE_BUDGET_MS) / budget))
    : 0;
  return { feasible, maxRetries: Math.max(0, maxRetries), remainingMs, rttEstMs };
}

export interface NackControllerOptions {
  /** NACK datagramini kabloya verir */
  send: (bytes: Uint8Array) => void;
  /** artificialRttMs + measuredRttMs */
  rttEstMs: () => number;
}

interface GroupNackState {
  rounds: number;
  /** blockIndex -> son istenme ani */
  requestedAt: Map<number, number>;
  pending: Set<number>;
  /** son NACK turunun ani — turlar arasi bekleme icin */
  lastRoundAt: number;
}

export interface NackStats {
  nackSent: number;
  nackAnswered: number;
  /** talep edilen sembol sayisi (paket degil) */
  symbolsRequested: number;
  retransmitReceived: number;
  /** deadline yetmedigi icin URETILMEYEN NACK */
  nackInfeasible: number;
  /** tur siniri doldugu icin uretilmeyen */
  roundLimited: number;
}

export class NackController {
  readonly stats: NackStats = {
    nackSent: 0,
    nackAnswered: 0,
    symbolsRequested: 0,
    retransmitReceived: 0,
    nackInfeasible: 0,
    roundLimited: 0,
  };

  private state = new Map<number, GroupNackState>();
  private readonly send: NackControllerOptions['send'];
  private readonly rttEstMs: NackControllerOptions['rttEstMs'];

  constructor(opts: NackControllerOptions) {
    this.send = opts.send;
    this.rttEstMs = opts.rttEstMs;
  }

  /** min_resend_interval = max(rttEst, 100 ms) */
  private minResendIntervalMs(): number {
    return Math.max(this.rttEstMs(), 100);
  }

  /**
   * Su anki RTT'de taze bir grup icin kac tur mumkun?
   * Arayuzde buyuk punto gosterilir; RTT sliderinda 3 -> 2 -> 1 -> 0.
   */
  currentMaxRetries(): number {
    const rttEst = this.rttEstMs();
    // Taze bir grup: settle beklendi, tek yon transit zaten harcandi
    const remaining = GROUP_DEADLINE_MS - rttEst / 2 - NACK_SETTLE_MS;
    return feasibility(remaining, rttEst).maxRetries;
  }

  /** Her tikta acik gruplara bakar ve gerekirse NACK uretir. */
  tick(nowMs: number, openGroups: OpenGroupView[]): void {
    const rttEst = this.rttEstMs();
    const minInterval = this.minResendIntervalMs();
    const alive = new Set<number>();

    for (const g of openGroups) {
      alive.add(g.groupId);
      if (g.needed <= 0) continue;

      const age = nowMs - g.firstSeenMs;
      if (age < NACK_SETTLE_MS) continue; // paketler hâlâ geliyor olabilir

      // Transit sirasinda harcanan tek yon gecikme butceden dusulur
      const remaining = g.firstSeenMs + GROUP_DEADLINE_MS - rttEst / 2 - nowMs;
      const f = feasibility(remaining, rttEst);

      let st = this.state.get(g.groupId);
      if (!st) {
        st = { rounds: 0, requestedAt: new Map(), pending: new Set(), lastRoundAt: -Infinity };
        this.state.set(g.groupId, st);
      }

      if (!f.feasible) {
        // Deadline yetmiyor: NACK URETILMEZ, grup dogrudan kayip sayilir.
        // ARQ'nun kendini kapatmasi tam olarak burasidir.
        if (st.rounds === 0 && !st.pending.size) {
          this.stats.nackInfeasible++;
          st.rounds = MAX_NACK_ROUNDS; // bir daha bakma
        }
        continue;
      }

      if (st.rounds >= Math.min(MAX_NACK_ROUNDS, f.maxRetries)) {
        this.stats.roundLimited++;
        continue;
      }

      // Kural 1 (tur duzeyi): onceki turun yanit sansi olmadan yeni tur yok.
      // Yalniz indeks bazinda beklemek yetmez — farkli indeksleri hemen
      // isteyerek NACK patlamasi uretilebilirdi.
      if (nowMs - st.lastRoundAt < minInterval) continue;

      // Istenecek semboller: eksiklerden EN DUSUK indeksliden basla.
      // MDS oldugu icin hangisi gelirse gelsin K tane olmasi yeterli;
      // parity de istenebilir.
      const have = new Set(g.have);
      const wanted: number[] = [];
      const total = g.K + g.M;
      for (let i = 0; i < total && wanted.length < Math.min(g.needed, NACK_MAX_INDICES); i++) {
        if (have.has(i)) continue;
        // Kural 1: min_resend_interval gecmeden ayni indeksi tekrar isteme
        const last = st.requestedAt.get(i);
        if (last !== undefined && nowMs - last < minInterval) continue;
        wanted.push(i);
      }

      if (wanted.length === 0) continue;

      for (const i of wanted) {
        st.requestedAt.set(i, nowMs);
        st.pending.add(i);
      }
      st.rounds++;
      st.lastRoundAt = nowMs;
      this.stats.nackSent++;
      this.stats.symbolsRequested += wanted.length;
      this.send(encodeNack({ groupId: g.groupId, indices: wanted }));
    }

    // Kapanmis gruplarin durumunu birak
    for (const id of [...this.state.keys()]) {
      if (!alive.has(id)) this.state.delete(id);
    }
  }

  /** Retransmit geldiginde cagrilir — talebin karsilandigini isaretler. */
  noteRetransmit(groupId: number, blockIndex: number): void {
    this.stats.retransmitReceived++;
    const st = this.state.get(groupId);
    if (st?.pending.delete(blockIndex)) this.stats.nackAnswered++;
  }

  reset(): void {
    this.state.clear();
    this.stats.nackSent = 0;
    this.stats.nackAnswered = 0;
    this.stats.symbolsRequested = 0;
    this.stats.retransmitReceived = 0;
    this.stats.nackInfeasible = 0;
    this.stats.roundLimited = 0;
  }
}
