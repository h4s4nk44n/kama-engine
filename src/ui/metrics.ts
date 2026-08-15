/**
 * Canli sayaclar — panel basina metrik toplama ve overlay cizimi.
 *
 * Metrikler alici tarafinda, grup basliklarindan turetilir; boylece
 * gonderici uzaktaki cihazda olsa da dogru sayilir.
 */

import type { AssemblerStats } from '../wire/groupAssembler.ts';
import type { ReceiverStats } from '../media/receiver.ts';

/**
 * ARQ panelinin ek sayaclari. Panel 1 ve 2'de bulunmaz.
 * arq.ts bu bicimde bir nesne uretir.
 */
export interface ArqPanelStats {
  nackSent: number;
  nackAnswered: number;
  retransmitReceived: number;
  /** deadline yetmedigi icin uretilmeyen NACK */
  nackInfeasible: number;
  /** su anki RTT'de kac tur mumkun */
  maxRetries: number;
  /** giden retransmit bayti / toplam gonderilen bayt */
  rtxBudgetUsed: number;
  rtxBudgetExceeded: number;
  /** FEC'in kacirdigi ama ARQ'nun topladigi grup */
  groupsSavedByArq: number;
}

export interface PanelSnapshot {
  /** beklenen toplam paket (source + parity, basliklardan) */
  expected: number;
  /** gelen toplam paket */
  received: number;
  /** dusurulen paket */
  dropped: number;
  /** gerceklesen kayip % */
  lossPct: number;
  /** RS decode ile kurtarilan source sembolu */
  recovered: number;
  /** kurtarma orani: kurtarilan / kaybolan source */
  recoveryPct: number;
  groupsLost: number;
  groupsRecovered: number;
  crcFailures: number;
  freezes: number;
  freezeMs: number;
  framesDrawn: number;
  fps: number;
  /** parity_bytes / (source_bytes + parity_bytes) */
  overheadPct: number;
  waitingForKey: boolean;
  /** yalniz ARQ panelinde dolu */
  arq?: ArqPanelStats;
}

export function snapshot(a: AssemblerStats, r: ReceiverStats, arq?: ArqPanelStats): PanelSnapshot {
  const expected = a.expectedSource + a.expectedParity;
  const received = a.receivedSource + a.receivedParity;
  const dropped = Math.max(0, expected - received);
  const lostSource = Math.max(0, a.expectedSource - a.receivedSource);
  const totalBytes = a.sourceBytes + a.parityBytes;

  return {
    expected,
    received,
    dropped,
    lossPct: expected > 0 ? (dropped / expected) * 100 : 0,
    recovered: a.recovered,
    recoveryPct: lostSource > 0 ? (a.recovered / lostSource) * 100 : 0,
    groupsLost: a.groupsLost,
    groupsRecovered: a.groupsRecovered,
    crcFailures: a.crcFailures,
    freezes: r.freezes,
    freezeMs: r.freezeMs,
    framesDrawn: r.framesDrawn,
    fps: r.fps,
    overheadPct: totalBytes > 0 ? (a.parityBytes / totalBytes) * 100 : 0,
    waitingForKey: r.waitingForKey,
    arq,
  };
}

const ROWS: Array<{ key: string; label: string; fmt: (s: PanelSnapshot) => string; hot?: (s: PanelSnapshot) => boolean }> = [
  {
    key: 'packets',
    label: 'paket gön / düş',
    fmt: (s) => `${fmtInt(s.expected)} / ${fmtInt(s.dropped)}`,
  },
  {
    key: 'loss',
    label: 'gerçekleşen kayıp',
    fmt: (s) => `${s.lossPct.toFixed(1)} %`,
    hot: (s) => s.lossPct > 25,
  },
  {
    key: 'recovered',
    label: 'kurtarılan / oran',
    fmt: (s) => `${fmtInt(s.recovered)} · ${s.recoveryPct.toFixed(0)} %`,
  },
  {
    key: 'grouploss',
    label: 'grup kaybı',
    fmt: (s) => fmtInt(s.groupsLost),
    hot: (s) => s.groupsLost > 0,
  },
  {
    key: 'freeze',
    label: 'donma (>600ms)',
    fmt: (s) => `${fmtInt(s.freezes)} · ${(s.freezeMs / 1000).toFixed(1)} sn`,
    hot: (s) => s.freezes > 0,
  },
  {
    key: 'frames',
    label: 'frame / fps',
    fmt: (s) => `${fmtInt(s.framesDrawn)} · ${s.fps} fps`,
  },
  {
    key: 'overhead',
    label: 'overhead',
    fmt: (s) => `${s.overheadPct.toFixed(1)} %`,
  },
];

/** Yalniz ARQ panelinde gosterilen ek satirlar. */
const ARQ_ROWS: typeof ROWS = [
  {
    key: 'nack',
    label: 'NACK gön / yanıt',
    fmt: (s) => `${fmtInt(s.arq?.nackSent ?? 0)} / ${fmtInt(s.arq?.nackAnswered ?? 0)}`,
  },
  {
    key: 'rtx',
    label: 'retransmit alınan',
    fmt: (s) => fmtInt(s.arq?.retransmitReceived ?? 0),
  },
  {
    key: 'arqsaved',
    label: 'ARQ ile kurtarılan grup',
    fmt: (s) => fmtInt(s.arq?.groupsSavedByArq ?? 0),
  },
  {
    key: 'rtxbudget',
    label: 'RTX bütçe kullanımı',
    fmt: (s) => `${((s.arq?.rtxBudgetUsed ?? 0) * 100).toFixed(1)} %`,
    hot: (s) => (s.arq?.rtxBudgetExceeded ?? 0) > 0,
  },
];

export class MetricsOverlay {
  private readonly cells = new Map<string, HTMLElement>();
  private readonly rowEls = new Map<string, HTMLElement>();
  private readonly rows: typeof ROWS;

  constructor(root: HTMLElement, withArq = false) {
    this.rows = withArq ? [...ROWS, ...ARQ_ROWS] : ROWS;
    root.innerHTML = '';
    for (const row of this.rows) {
      const el = document.createElement('div');
      el.className = 'metric-row';

      const k = document.createElement('span');
      k.className = 'metric-key';
      k.textContent = row.label;

      const v = document.createElement('span');
      v.className = 'metric-val';
      v.textContent = '—';

      el.append(k, v);
      root.append(el);

      this.cells.set(row.key, v);
      this.rowEls.set(row.key, el);
    }
  }

  update(s: PanelSnapshot): void {
    for (const row of this.rows) {
      const cell = this.cells.get(row.key)!;
      const text = row.fmt(s);
      if (cell.textContent !== text) cell.textContent = text;
      const hot = row.hot?.(s) ?? false;
      this.rowEls.get(row.key)!.classList.toggle('hot', hot);
    }
  }
}

function fmtInt(n: number): string {
  return n.toLocaleString('tr-TR');
}

/** navigator.userAgent'tan "Chrome 131 · Android" gibi kisa bir satir. */
export function platformLine(): string {
  const ua = navigator.userAgent;

  let browser = 'Bilinmeyen tarayıcı';
  const chrome = /Chrome\/(\d+)/.exec(ua);
  const edge = /Edg\/(\d+)/.exec(ua);
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (edge) browser = `Edge ${edge[1]}`;
  else if (chrome) browser = `Chrome ${chrome[1]}`;
  else if (firefox) browser = `Firefox ${firefox[1]}`;

  let os = 'Bilinmeyen platform';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/(iPhone|iPad|iPod)/i.test(ua)) os = 'iOS';
  else if (/Windows NT 10/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return `${browser} · ${os}`;
}
