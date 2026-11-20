import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const METRICS_FILE = '.vgate/metrics.jsonl';

export interface KpiEvent {
  timestamp: string;
  kind: 'pr-merged' | 'pr-reverted' | 'incident-escaped' | 'rework' | 'agent-spend';
  pr?: string;
  service?: string;
  humanReviewMinutes?: number;
  tokens?: number;
  usd?: number;
  role?: string;
  harness?: string;
  model?: string;
  capability?: string;
  note?: string;
}

export interface KpiSummary {
  schema: 'vgate.metrics/1';
  windowDays: number;
  events: number;
  acceptedFixes: number;
  revertedPrs: number;
  escapedDefects: number;
  revertRate: number | null;
  escapedDefectRate: number | null;
  postReviewReworkRate: number | null;
  avgHumanReviewMinutes: number | null;
  totalTokens: number;
  totalUsd: number;
  usdPerAcceptedChange: number | null;
  tokensPerAcceptedChange: number | null;
  verificationTokenShare: number | null;
}

const VALID_KINDS = new Set<KpiEvent['kind']>([
  'pr-merged',
  'pr-reverted',
  'incident-escaped',
  'rework',
  'agent-spend',
]);

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isKpiEvent(value: unknown): value is KpiEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['timestamp'] === 'string' && VALID_KINDS.has(obj['kind'] as KpiEvent['kind']);
}

export function appendKpiEvent(projectRoot: string, event: KpiEvent): string {
  const filePath = join(projectRoot, METRICS_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  return filePath;
}

export function readKpiEvents(projectRoot: string, sinceDays?: number): KpiEvent[] {
  const filePath = join(projectRoot, METRICS_FILE);
  if (!existsSync(filePath)) return [];

  const cutoffMs = sinceDays !== undefined && Number.isFinite(sinceDays) ? Date.now() - sinceDays * 86_400_000 : null;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const events: KpiEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isKpiEvent(parsed)) continue;
      if (cutoffMs !== null) {
        const ts = Date.parse(parsed.timestamp);
        if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      }
      events.push(parsed);
    } catch {
      // Skip malformed JSONL lines so a single bad entry does not break metrics reading.
    }
  }

  return events;
}

function isVerificationEvent(event: KpiEvent): boolean {
  const role = event.role?.trim().toLowerCase();
  if (role === 'verifier' || role === 'panel') return true;
  const capability = event.capability?.trim().toLowerCase();
  if (capability && capability.includes('verif')) return true;
  return false;
}

export function summarizeKpis(events: KpiEvent[], windowDays = 30): KpiSummary {
  let acceptedFixes = 0;
  let revertedPrs = 0;
  let escapedDefects = 0;
  let reworkCount = 0;
  let reviewMinutesTotal = 0;
  let reviewMinutesCount = 0;
  let totalTokens = 0;
  let verificationTokens = 0;
  let totalUsd = 0;

  for (const event of events) {
    switch (event.kind) {
      case 'pr-merged':
        acceptedFixes++;
        break;
      case 'pr-reverted':
        revertedPrs++;
        break;
      case 'incident-escaped':
        escapedDefects++;
        break;
      case 'rework':
        reworkCount++;
        break;
      case 'agent-spend':
        break;
    }

    if (typeof event.humanReviewMinutes === 'number' && Number.isFinite(event.humanReviewMinutes)) {
      reviewMinutesTotal += event.humanReviewMinutes;
      reviewMinutesCount++;
    }

    if (typeof event.tokens === 'number' && Number.isFinite(event.tokens) && event.tokens > 0) {
      totalTokens += event.tokens;
      if (isVerificationEvent(event)) {
        verificationTokens += event.tokens;
      }
    }

    if (typeof event.usd === 'number' && Number.isFinite(event.usd) && event.usd > 0) {
      totalUsd += event.usd;
    }
  }

  const roundedUsd = round6(totalUsd);

  return {
    schema: 'vgate.metrics/1',
    windowDays,
    events: events.length,
    acceptedFixes,
    revertedPrs,
    escapedDefects,
    revertRate: acceptedFixes > 0 ? round6(revertedPrs / acceptedFixes) : null,
    escapedDefectRate: acceptedFixes > 0 ? round6(escapedDefects / acceptedFixes) : null,
    postReviewReworkRate: acceptedFixes > 0 ? round6(reworkCount / acceptedFixes) : null,
    avgHumanReviewMinutes: reviewMinutesCount > 0 ? round6(reviewMinutesTotal / reviewMinutesCount) : null,
    totalTokens,
    totalUsd: roundedUsd,
    usdPerAcceptedChange: acceptedFixes > 0 ? round6(roundedUsd / acceptedFixes) : null,
    tokensPerAcceptedChange: acceptedFixes > 0 ? round6(totalTokens / acceptedFixes) : null,
    verificationTokenShare: totalTokens > 0 ? round6(verificationTokens / totalTokens) : null,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(2)}`;
}

function formatNum(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
}

export function renderMetricsHtml(summary: KpiSummary, events: KpiEvent[]): string {
  const cards: Array<{ label: string; value: string; detail: string }> = [
    {
      label: 'Revert Rate',
      value: formatPct(summary.revertRate),
      detail: `${summary.revertedPrs} reverted / ${summary.acceptedFixes} merged`,
    },
    {
      label: 'Escaped Defect Rate',
      value: formatPct(summary.escapedDefectRate),
      detail: `${summary.escapedDefects} escaped / ${summary.acceptedFixes} merged`,
    },
    {
      label: 'Post-Review Rework Rate',
      value: formatPct(summary.postReviewReworkRate),
      detail: `Window: ${summary.windowDays}d`,
    },
    {
      label: 'Avg Human Review Time',
      value: formatNum(summary.avgHumanReviewMinutes, ' min'),
      detail: `${summary.events} total event(s)`,
    },
    {
      label: 'Cost / Accepted Change',
      value: formatUsd(summary.usdPerAcceptedChange),
      detail: `Total: ${formatUsd(summary.totalUsd)}`,
    },
    {
      label: 'Tokens / Accepted Change',
      value: formatNum(summary.tokensPerAcceptedChange),
      detail: `Total: ${formatNum(summary.totalTokens)}`,
    },
    {
      label: 'Verification Token Share',
      value: formatPct(summary.verificationTokenShare),
      detail: 'Verifier + panel token share',
    },
  ];

  const cardHtml = cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(c.value)}</div><div class="detail">${escapeHtml(c.detail)}</div></div>`,
    )
    .join('\n      ');

  const rowsHtml =
    events.length === 0
      ? '<tr><td colspan="7" class="empty">No KPI events recorded yet.</td></tr>'
      : events
          .slice()
          .reverse()
          .slice(0, 100)
          .map(
            (e) =>
              `<tr><td>${escapeHtml(e.timestamp)}</td><td><span class="badge">${escapeHtml(e.kind)}</span></td><td>${escapeHtml(e.pr ?? '')}</td><td>${escapeHtml(e.service ?? '')}</td><td>${escapeHtml(e.role ?? '')}</td><td>${escapeHtml(e.usd !== undefined ? `$${e.usd.toFixed(4)}` : e.tokens !== undefined ? `${e.tokens} tok` : '')}</td><td>${escapeHtml(e.note ?? '')}</td></tr>`,
          )
          .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>vgate 5-KPI Ledger (${escapeHtml(String(summary.windowDays))}d)</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
    h1 { margin: 0 0 6px; font-size: 1.5rem; }
    .sub { color: #94a3b8; margin: 0 0 20px; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px; }
    .label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .value { font-size: 1.6rem; font-weight: 700; margin: 6px 0 4px; color: #f8fafc; }
    .detail { font-size: 0.8rem; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #334155; text-align: left; font-size: 0.85rem; }
    th { background: #0b1220; color: #94a3b8; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #334155; color: #f8fafc; font-size: 0.75rem; }
    .empty { text-align: center; color: #94a3b8; padding: 24px; }
  </style>
</head>
<body>
  <h1>vgate 5-KPI Local Ledger</h1>
  <p class="sub">Schema ${escapeHtml(summary.schema)} &middot; Window: ${escapeHtml(String(summary.windowDays))} days &middot; Events: ${escapeHtml(String(summary.events))}</p>
  <div class="grid">
      ${cardHtml}
  </div>
  <table>
    <thead>
      <tr><th>Timestamp</th><th>Kind</th><th>PR</th><th>Service</th><th>Role</th><th>Spend</th><th>Note</th></tr>
    </thead>
    <tbody>
        ${rowsHtml}
    </tbody>
  </table>
</body>
</html>
`;
}

function promValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'NaN';
  return String(value);
}

/**
 * Renders KPI summary in Prometheus / OpenMetrics text exposition format.
 */
export function renderPrometheusMetrics(summary: KpiSummary): string {
  const lines: Array<[name: string, help: string, value: number | null]> = [
    ['vgate_kpi_window_days', 'Summary rolling window in days.', summary.windowDays],
    ['vgate_kpi_events_total', 'Number of KPI events in window.', summary.events],
    ['vgate_kpi_accepted_fixes_total', 'Number of merged PRs / accepted fixes.', summary.acceptedFixes],
    ['vgate_kpi_reverted_prs_total', 'Number of reverted PRs.', summary.revertedPrs],
    ['vgate_kpi_escaped_defects_total', 'Number of escaped incidents/defects.', summary.escapedDefects],
    ['vgate_kpi_revert_rate', 'Ratio of reverted PRs to accepted fixes.', summary.revertRate],
    ['vgate_kpi_escaped_defect_rate', 'Ratio of escaped defects to accepted fixes.', summary.escapedDefectRate],
    [
      'vgate_kpi_post_review_rework_rate',
      'Ratio of post-review rework events to accepted fixes.',
      summary.postReviewReworkRate,
    ],
    ['vgate_kpi_avg_human_review_minutes', 'Average human review minutes per PR.', summary.avgHumanReviewMinutes],
    ['vgate_kpi_total_tokens', 'Total LLM tokens recorded in window.', summary.totalTokens],
    ['vgate_kpi_total_usd', 'Total USD spend recorded in window.', summary.totalUsd],
    ['vgate_kpi_usd_per_accepted_change', 'Average USD spend per accepted change.', summary.usdPerAcceptedChange],
    ['vgate_kpi_tokens_per_accepted_change', 'Average tokens per accepted change.', summary.tokensPerAcceptedChange],
    [
      'vgate_kpi_verification_token_share',
      'Share of tokens spent on independent verification.',
      summary.verificationTokenShare,
    ],
  ];

  const blocks = lines.map(
    ([name, help, value]) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${promValue(value)}`,
  );
  return `${blocks.join('\n')}\n`;
}
