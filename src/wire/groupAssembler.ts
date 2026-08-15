/**
 * Alici tarafi grup birlestirme ve kurtarma.
 *
 * Iki modda calisir; tek fark FEC:
 *   useFec=false -> parity datagramlari yok sayilir, K source'un tamami
 *                   gelmezse grup kaybi
 *   useFec=true  -> gelen sembol sayisi >= K ise RS decode ile kurtarma
 *
 * Karar:
 *   - Tum K source geldi          -> dogrudan teslim, decode YOK
 *   - Gelen sembol sayisi >= K    -> RS decode, kurtar, CRC dogrula, teslim
 *   - Gelen < K (zaman asimi)     -> grup kaybi, sayac artir, atla
 *
 * Temizlik: 600 ms sonra veya group_id 32 ilerleyince. En fazla 64 acik grup.
 */

import { getCodec, InsufficientSymbols, type PresentSymbol } from '../fec/index.ts';
import { parsePU, type ProtectedUnit } from './protectedUnit.ts';
import { blockIndex, seqDiff, type Datagram } from './datagram.ts';

export const GROUP_TIMEOUT_MS = 600;
export const GROUP_ID_LOOKAHEAD = 32;
export const MAX_OPEN_GROUPS = 64;

export interface AssemblerStats {
  /** grup basliklarindan turetilen beklenen source sembolu */
  expectedSource: number;
  /** beklenen parity sembolu (FEC kapali yolda her zaman 0) */
  expectedParity: number;
  /** kablo uzerinden gercekten gelen source sembolu */
  receivedSource: number;
  /** kablo uzerinden gercekten gelen parity sembolu */
  receivedParity: number;
  /** RS decode ile geri kazanilan source sembolu sayisi */
  recovered: number;
  /** decode denendi ve basarili oldu */
  groupsRecovered: number;
  /** hicbir kayip olmadan tamamlanan grup */
  groupsClean: number;
  /** K'ya ulasilamadigi icin dusen grup */
  groupsLost: number;
  /** CRC tutmayip iskarta edilen sembol */
  crcFailures: number;
  /** teslim edilen PU sayisi */
  pusDelivered: number;
  /** grup basliklarindan turetilen source bayt hacmi (kayiptan bagimsiz) */
  sourceBytes: number;
  /** parity bayt hacmi — overhead % bundan hesaplanir */
  parityBytes: number;
  /** hicbir paketi gelmeyen, yalniz group_id boslugundan anlasilan grup */
  groupsVanished: number;
  /** ARQ ile yeniden gonderilip gelen sembol (yalniz ARQ panelinde > 0) */
  receivedRetransmit: number;
  /** ARQ sayesinde kurtarilan grup — retransmit olmasa dusecekti */
  groupsSavedByArq: number;
}

export interface GroupAssemblerOptions {
  useFec: boolean;
  onPU: (pu: ProtectedUnit) => void;
  /** Grup tamamen dustugunde — alici chunk'lari iptal edebilsin diye. */
  onGroupLost?: (groupId: number, missing: number, K: number) => void;
}

interface OpenGroup {
  groupId: number;
  K: number;
  M: number;
  symbolSize: number;
  /** blockIndex -> sembol */
  symbols: Map<number, Uint8Array>;
  sourceSeen: number;
  firstSeenMs: number;
  settled: boolean;
  /**
   * K/M/symbolSize kesinlesti mi?
   * Source datagramlari bunlari TAHMIN olarak tasir (grup gonderici
   * tarafinda henuz kapanmamisti). Parity — ve kapanistan sonra uretilen
   * retransmit — gercek degerleri tasir ve otoritedir.
   */
  authoritative: boolean;
  /** hesaba katildi mi (kapanista bir kez) */
  accounted: boolean;
  /** ARQ ile gelen sembol sayisi — grubu ARQ mi kurtardi, onu anlamak icin */
  retransmitted: number;
  /**
   * Ustteki katmana ILETILMIS source blok indeksleri.
   * Source semboller geldigi anda iletilir; grup kapandiginda yalnizca
   * henuz iletilmemis olanlar (kurtarilanlar) gonderilir. Ayni PU iki kez
   * teslim edilmez.
   */
  delivered: Set<number>;
}

/** ARQ'nun eksik tespiti icin acik grubun salt-okunur goruntusu. */
export interface OpenGroupView {
  groupId: number;
  K: number;
  M: number;
  /** elde olan blok indeksleri (source: 0..K-1, parity: K..K+M-1) */
  have: number[];
  /** kac sembol daha gerekiyor */
  needed: number;
  firstSeenMs: number;
}

export class GroupAssembler {
  readonly useFec: boolean;
  private readonly onPU: GroupAssemblerOptions['onPU'];
  private readonly onGroupLost: GroupAssemblerOptions['onGroupLost'];

  private groups = new Map<number, OpenGroup>();
  /** Kapanmis grup id'leri — gec gelen paketleri sessizce yut. */
  private settled = new Set<number>();
  /** Bosluktan anlasilan, ama henuz kesin kayip sayilmayan grup id'leri. */
  private suspected = new Map<number, { atMs: number; K: number; M: number; symbolSize: number }>();
  private highestGroupId: number | null = null;

  readonly stats: AssemblerStats = {
    expectedSource: 0,
    expectedParity: 0,
    receivedSource: 0,
    receivedParity: 0,
    recovered: 0,
    groupsRecovered: 0,
    groupsClean: 0,
    groupsLost: 0,
    crcFailures: 0,
    pusDelivered: 0,
    sourceBytes: 0,
    parityBytes: 0,
    groupsVanished: 0,
    receivedRetransmit: 0,
    groupsSavedByArq: 0,
  };

  /**
   * Gelen ORIJINAL (retransmit olmayan) sembollerin donen ozeti.
   * Uc panelin ayni kayip desenini gordugu bununla dogrulanir: uc
   * assembler'in receivedHash degeri birbirine esit olmalidir.
   * Retransmit'ler hesaba katilmaz — onlar yalnizca ARQ panelinde vardir.
   */
  private rxHash = 0x811c9dc5;

  /** Tamamen kaybolan gruplari group_id boslugundan tahmin etmek icin. */
  private lastK = 0;
  private lastM = 0;
  private lastSymbolSize = 0;

  constructor(opts: GroupAssemblerOptions) {
    this.useFec = opts.useFec;
    this.onPU = opts.onPU;
    this.onGroupLost = opts.onGroupLost;
  }

  reset(): void {
    this.groups.clear();
    this.settled.clear();
    this.suspected.clear();
    this.highestGroupId = null;
    this.lastK = 0;
    this.lastM = 0;
    this.lastSymbolSize = 0;
    this.rxHash = 0x811c9dc5;
    for (const k of Object.keys(this.stats) as Array<keyof AssemblerStats>) {
      this.stats[k] = 0;
    }
  }

  push(dg: Datagram, nowMs: number): void {
    /**
     * FEC kapali panelde parity KURTARMA icin kullanilmaz. Yine de
     * basligi okunur: grubun var oldugunu ve K'sini ogrenmek icin.
     * Aksi hâlde source'u tamamen kaybolmus bir grup, sol panelde
     * yalnizca group_id boslugundan tahmin edilir ve iki panelin
     * "beklenen" sayaclari birbirinden kayar. Bu, sembolu kullanmaz —
     * sol panel hicbir sey kurtaramaz, sadece dogru sayar.
     */
    const parityIgnored = !this.useFec && dg.isParity;

    // Varis sayimi grup kapanmadan ONCE yapilir. Kayipsiz durumda grup
    // K source ile hemen kapanir ve parity paketleri ARDINDAN gelir;
    // sayimi kapanis kontrolunun arkasina koymak bu paketleri "kayip"
    // gosterip FEC panelinde sahte bir kayip orani uretiyordu.
    if (!parityIgnored) {
      if (dg.isParity) this.stats.receivedParity++;
      else this.stats.receivedSource++;
    }

    if (dg.isRetransmit) {
      this.stats.receivedRetransmit++;
    } else {
      // FNV-1a: (groupId, blockIndex) sirasiyla karistir
      const k = (dg.groupId << 8) ^ blockIndex(dg);
      this.rxHash = Math.imul(this.rxHash ^ (k & 0xff), 0x01000193) >>> 0;
      this.rxHash = Math.imul(this.rxHash ^ ((k >>> 8) & 0xff), 0x01000193) >>> 0;
      this.rxHash = Math.imul(this.rxHash ^ ((k >>> 16) & 0xff), 0x01000193) >>> 0;
    }

    if (this.settled.has(dg.groupId)) return;

    let g = this.groups.get(dg.groupId);
    if (!g) {
      g = {
        groupId: dg.groupId,
        K: dg.K,
        M: dg.M,
        symbolSize: dg.symbolSize,
        symbols: new Map(),
        sourceSeen: 0,
        firstSeenMs: nowMs,
        settled: false,
        retransmitted: 0,
        delivered: new Set(),
        authoritative: false,
        accounted: false,
      };
      this.groups.set(dg.groupId, g);
    }

    // Parity ve retransmit grup kapandiktan SONRA uretilir; K/M/symbol_size
    // degerleri kesindir. Source datagramlari yalnizca tahmin tasir.
    if (dg.isParity || dg.isRetransmit) {
      g.K = dg.K;
      g.M = dg.M;
      g.symbolSize = Math.max(g.symbolSize, dg.symbolSize);
      g.authoritative = true;
      this.lastK = dg.K;
      this.lastM = dg.M;
      this.lastSymbolSize = g.symbolSize;
    } else if (!g.authoritative) {
      // Henuz otorite yok: en buyuk gorulen boyu tut
      g.symbolSize = Math.max(g.symbolSize, dg.symbolSize);
    }

    if (!parityIgnored) {
      const bi = blockIndex(dg);
      if (!g.symbols.has(bi)) {
        // Sembol kopyalanir: DataChannel tamponu yeniden kullanilabilir
        const copy = dg.symbol.slice();
        g.symbols.set(bi, copy);
        if (dg.isRetransmit) g.retransmitted++;

        if (!dg.isParity) {
          g.sourceSeen++;
          /**
           * ANINDA ILETIM.
           *
           * Source sembolu grubun kapanmasini BEKLEMEZ. Beklemek, FEC
           * grubunu oynatmanin adim birimi hâline getiriyordu: grup ~3.5
           * kare surdugu icin kareler 4'erli patlamalar hâlinde ciziliyor,
           * aralarda ~200 ms bosluk kaliyordu — kayip olmasa bile.
           *
           * Parity yalnizca EKSIKLERI onarmak icindir; gelmis bir paketi
           * bekletmek icin degil.
           */
          g.delivered.add(bi);
          this.emitSymbol(copy);
        }
      }
    }

    this.trackGroupId(dg.groupId, nowMs);
    this.trySettle(g);
    this.enforceLimits(nowMs);
  }

  /** Periyodik cagrilir; zaman asimina ugrayan gruplari kapatir. */
  tick(nowMs: number): void {
    for (const g of [...this.groups.values()]) {
      if (nowMs - g.firstSeenMs >= GROUP_TIMEOUT_MS) this.finalize(g, nowMs);
    }
    this.reapSuspected(nowMs);
    this.enforceLimits(nowMs);
  }

  /** Beklenen sembol/bayt hacmini grup basligindan kaydeder. */
  private accountGroup(K: number, M: number, symbolSize: number): void {
    this.stats.expectedSource += K;
    this.stats.sourceBytes += K * symbolSize;
    if (this.useFec) {
      this.stats.expectedParity += M;
      this.stats.parityBytes += M * symbolSize;
    }
  }

  private trackGroupId(groupId: number, nowMs: number): void {
    // Kanal sirasiz ({ordered:false}); yeniden siralanmis bir grup ileride
    // gelebilir. Bu yuzden bosluktaki id'ler HEMEN kayip sayilmaz, once
    // "supheli" listesine alinir ve GROUP_TIMEOUT_MS beklenir.
    this.suspected.delete(groupId);

    if (this.highestGroupId === null || seqDiff(groupId, this.highestGroupId) > 0) {
      if (this.highestGroupId !== null && this.lastK > 0) {
        const gap = Math.min(seqDiff(groupId, this.highestGroupId) - 1, GROUP_ID_LOOKAHEAD);
        for (let i = 1; i <= gap; i++) {
          const missing = (this.highestGroupId + i) & 0xffff;
          if (this.groups.has(missing) || this.settled.has(missing) || this.suspected.has(missing)) continue;
          this.suspected.set(missing, { atMs: nowMs, K: this.lastK, M: this.lastM, symbolSize: this.lastSymbolSize });
        }
      }
      this.highestGroupId = groupId;
      // group_id GROUP_ID_LOOKAHEAD ilerleyince eski gruplari kapat
      for (const g of [...this.groups.values()]) {
        if (seqDiff(groupId, g.groupId) >= GROUP_ID_LOOKAHEAD) this.finalize(g, nowMs);
      }
    }
  }

  /** Zaman asimina ugrayan supheli id'ler kesin kayip sayilir. */
  private reapSuspected(nowMs: number): void {
    for (const [id, s] of [...this.suspected]) {
      if (nowMs - s.atMs < GROUP_TIMEOUT_MS) continue;
      this.suspected.delete(id);
      this.settled.add(id);
      this.accountGroup(s.K, s.M, s.symbolSize);
      this.stats.groupsLost++;
      this.stats.groupsVanished++;
      this.onGroupLost?.(id, s.K, s.K);
    }
  }

  private enforceLimits(nowMs: number): void {
    while (this.groups.size > MAX_OPEN_GROUPS) {
      // En eski grubu kapat (Map ekleme sirasini korur)
      const oldest = this.groups.values().next().value as OpenGroup | undefined;
      if (!oldest) break;
      this.finalize(oldest, nowMs);
    }
    // settled kumesi sinirsiz buyumesin
    if (this.settled.size > MAX_OPEN_GROUPS * 8) {
      const keep = [...this.settled].slice(-MAX_OPEN_GROUPS * 4);
      this.settled = new Set(keep);
    }
  }

  /**
   * ARQ icin acik gruplarin goruntusu — hangi semboller eksik?
   * Salt okunur; assembler'in ic durumu disari sizmaz.
   */
  openGroups(): OpenGroupView[] {
    const out: OpenGroupView[] = [];
    for (const g of this.groups.values()) {
      if (g.settled) continue;
      out.push({
        groupId: g.groupId,
        K: g.K,
        M: g.M,
        have: [...g.symbols.keys()],
        needed: Math.max(0, g.K - g.symbols.size),
        firstSeenMs: g.firstSeenMs,
      });
    }
    return out;
  }

  /** Uc panelin ayni orijinal paketleri aldigini dogrulamak icin. */
  receivedHash(): string {
    return this.rxHash.toString(16).padStart(8, '0');
  }

  /**
   * Grubu ARQ mi kurtardi? Retransmit gelmisse ve onlar olmadan
   * sembol sayisi K'nin altinda kalacaksa evet.
   */
  private noteArqCredit(g: OpenGroup): void {
    if (g.retransmitted > 0 && g.symbols.size - g.retransmitted < g.K) {
      this.stats.groupsSavedByArq++;
    }
  }

  /** Yeterli sembol geldiyse hemen kapat. */
  private trySettle(g: OpenGroup): void {
    if (g.settled) return;

    if (g.sourceSeen === g.K) {
      // Kayipsiz yol: decode yok, dogrudan teslim
      this.deliverSource(g);
      this.stats.groupsClean++;
      this.noteArqCredit(g);
      this.close(g);
      return;
    }

    if (this.useFec && g.symbols.size >= g.K) {
      this.recover(g);
      this.close(g);
    }
  }

  /** Zaman asimi / id ilerlemesi ile kesin karar. */
  private finalize(g: OpenGroup, _nowMs: number): void {
    if (g.settled) {
      this.close(g);
      return;
    }

    if (this.useFec && g.symbols.size >= g.K) {
      this.recover(g);
    } else if (!this.useFec && g.sourceSeen === g.K) {
      this.deliverSource(g);
      this.stats.groupsClean++;
      this.noteArqCredit(g);
    } else {
      this.stats.groupsLost++;
      this.onGroupLost?.(g.groupId, g.K - g.sourceSeen, g.K);
    }
    this.close(g);
  }

  private close(g: OpenGroup): void {
    // Beklenen sembol/bayt hesabi grup KAPANIRKEN bir kez yapilir.
    // Grup acilirken yapilamaz: o anda K/M yalnizca source basligindaki
    // tahmindir, gercegini parity getirir.
    if (!g.accounted) {
      g.accounted = true;
      this.accountGroup(g.K, g.M, g.symbolSize);
    }
    // Kaybolan gruplari group_id boslugundan tahmin etmek icin son bilinen
    // boyutlar burada da guncellenir: grup K source ile parity gelmeden
    // kapanabilir, o durumda otoriter paket hic islenmez.
    this.lastK = g.K;
    this.lastM = g.M;
    this.lastSymbolSize = g.symbolSize;
    g.settled = true;
    this.groups.delete(g.groupId);
    this.suspected.delete(g.groupId);
    this.settled.add(g.groupId);
  }

  private recover(g: OpenGroup): void {
    // RS tum sembollerin ayni boyda olmasini ister. Source semboller
    // kabloya kendi dogal boylarinda cikti (gonderim gruplamayi beklemez),
    // bu yuzden burada grup symbol_size'ina sifirla doldurulur — gonderici
    // parity'yi hesaplarken tam olarak bunu yapmisti.
    const size = g.symbolSize;
    const present: PresentSymbol[] = [];
    for (const [index, symbol] of g.symbols) {
      if (symbol.length === size) {
        present.push({ index, symbol });
      } else if (symbol.length < size) {
        const padded = new Uint8Array(size);
        padded.set(symbol);
        present.push({ index, symbol: padded });
      }
      // symbol.length > size olamaz: symbolSize gorulen en buyuk boydur
    }

    let source: Uint8Array[];
    try {
      source = getCodec().decode(present, g.K, g.M);
    } catch (err) {
      if (err instanceof InsufficientSymbols) {
        this.stats.groupsLost++;
        this.onGroupLost?.(g.groupId, g.K - g.sourceSeen, g.K);
        return;
      }
      throw err;
    }

    this.stats.groupsRecovered++;
    const recoveredCount = g.K - g.sourceSeen;
    this.stats.recovered += recoveredCount;
    this.noteArqCredit(g);

    // YALNIZ kurtarilanlari teslim et — gelmis olanlar zaten aninda
    // iletildi. CRC her PU'da dogrulanir; tutmazsa iskarta ve sayac.
    for (let i = 0; i < g.K; i++) {
      if (g.delivered.has(i)) continue;
      g.delivered.add(i);
      this.emitSymbol(source[i]);
    }
  }

  /** Kapanista henuz iletilmemis source sembolleri (varsa) gonderir. */
  private deliverSource(g: OpenGroup): void {
    for (let i = 0; i < g.K; i++) {
      if (g.delivered.has(i)) continue;
      const s = g.symbols.get(i);
      if (!s) continue;
      g.delivered.add(i);
      this.emitSymbol(s);
    }
  }

  private emitSymbol(symbol: Uint8Array): void {
    const pu = parsePU(symbol);
    if (!pu) {
      this.stats.crcFailures++;
      return;
    }
    this.stats.pusDelivered++;
    this.onPU(pu);
  }
}
