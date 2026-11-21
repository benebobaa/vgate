import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ReviewArtifact {
  kind: 'screenshot' | 'video' | 'trace' | 'statechart' | 'benchmark' | 'verdict' | 'guard' | 'verifier' | 'coverage';
  label: string;
  path?: string;
  inlineMarkdown?: string;
}

export interface ReviewBundle {
  schema: 'vgate.review-bundle/1';
  generatedAt: string;
  artifacts: ReviewArtifact[];
  markdown: string;
}

const SECTION_ORDER: ReadonlyArray<{ kind: ReviewArtifact['kind']; heading: string }> = [
  { kind: 'verdict', heading: 'Verdicts' },
  { kind: 'guard', heading: 'Guard Reports' },
  { kind: 'verifier', heading: 'Verifier Receipts' },
  { kind: 'statechart', heading: 'Statecharts' },
  { kind: 'benchmark', heading: 'Benchmarks' },
  { kind: 'coverage', heading: 'Coverage' },
  { kind: 'screenshot', heading: 'Screenshots' },
  { kind: 'video', heading: 'Videos' },
  { kind: 'trace', heading: 'Traces' },
];

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (stat.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trySummarizeJson(filePath: string, kind: ReviewArtifact['kind']): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isRecord(raw)) return undefined;
    const parsed = isRecord(raw.payload) && isRecord(raw.signature) ? raw.payload : raw;

    if (kind === 'benchmark' && typeof parsed.verdict === 'string') {
      const summary = typeof parsed.summary === 'string' ? parsed.summary : `verdict: ${parsed.verdict}`;
      const speedup = typeof parsed.speedupPct === 'number' ? ` (${parsed.speedupPct}%)` : '';
      return `**Benchmark:** ${summary}${speedup}`;
    }

    if (kind === 'verdict' && (typeof parsed.verdict === 'string' || typeof parsed.ok === 'boolean')) {
      const status = typeof parsed.verdict === 'string' ? parsed.verdict : parsed.ok ? 'pass' : 'fail';
      return `**Verdict:** \`${status}\``;
    }

    if (kind === 'guard') {
      const findings = Array.isArray(parsed.findings) ? parsed.findings.length : undefined;
      if (findings !== undefined) {
        return `**Guard findings:** ${findings}`;
      }
    }

    if (kind === 'verifier') {
      if (typeof parsed.verdict === 'string') {
        return `**Verifier:** \`${parsed.verdict}\``;
      }
      if (typeof parsed.ok === 'boolean') {
        return `**Verifier:** \`${parsed.ok ? 'verified' : 'failed'}\``;
      }
    }

    if (kind === 'coverage') {
      const total = isRecord(parsed.total) ? parsed.total : parsed;
      const lines = isRecord(total.lines) && typeof total.lines.pct === 'number' ? total.lines.pct : undefined;
      if (lines !== undefined) {
        return `**Line coverage:** ${lines}%`;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function escapeMdText(value: string): string {
  return value
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|~]/g, (c) => `\\${c}`)
    .replace(/@/g, '@\u200b');
}

function classifyFile(filePath: string, reportsDir: string): ReviewArtifact | null {
  const rel = path.relative(reportsDir, filePath).replace(/\\/g, '/');
  const lowerRel = rel.toLowerCase();
  const base = path.basename(filePath);
  const lowerBase = base.toLowerCase();
  const ext = path.extname(lowerBase);

  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
    return { kind: 'screenshot', label: rel, path: filePath };
  }

  if (ext === '.webm' || ext === '.mp4') {
    return { kind: 'video', label: rel, path: filePath };
  }

  if (ext === '.trace' || (ext === '.zip' && lowerRel.includes('trace'))) {
    return { kind: 'trace', label: rel, path: filePath };
  }

  // Never inline untrusted raw .md files from evidence directly into PR comments; only fenced .mmd/.mermaid or JSON summaries.
  if (ext === '.mmd' || ext === '.mermaid') {
    const content = readFileSync(filePath, 'utf8').trim().replace(/```/g, '``\u200b`');
    return {
      kind: 'statechart',
      label: rel,
      path: filePath,
      inlineMarkdown: ['```mermaid', content, '```'].join('\n'),
    };
  }
  if (lowerBase.includes('statechart') && ext === '.md') {
    return { kind: 'statechart', label: rel, path: filePath };
  }

  if (lowerBase.includes('benchmark') && (ext === '.json' || ext === '.md')) {
    const inlineMarkdown = ext === '.json' ? trySummarizeJson(filePath, 'benchmark') : undefined;
    return { kind: 'benchmark', label: rel, path: filePath, ...(inlineMarkdown ? { inlineMarkdown } : {}) };
  }

  if (lowerBase.includes('verdict') && (ext === '.json' || ext === '.md')) {
    const inlineMarkdown = ext === '.json' ? trySummarizeJson(filePath, 'verdict') : undefined;
    return { kind: 'verdict', label: rel, path: filePath, ...(inlineMarkdown ? { inlineMarkdown } : {}) };
  }

  if (lowerBase.includes('guard') && (ext === '.json' || ext === '.md')) {
    const inlineMarkdown = ext === '.json' ? trySummarizeJson(filePath, 'guard') : undefined;
    return { kind: 'guard', label: rel, path: filePath, ...(inlineMarkdown ? { inlineMarkdown } : {}) };
  }

  if ((lowerBase.includes('verifier') || lowerBase.includes('receipt')) && (ext === '.json' || ext === '.md')) {
    const inlineMarkdown = ext === '.json' ? trySummarizeJson(filePath, 'verifier') : undefined;
    return { kind: 'verifier', label: rel, path: filePath, ...(inlineMarkdown ? { inlineMarkdown } : {}) };
  }

  if (
    (lowerRel.includes('coverage') || lowerBase.includes('lcov')) &&
    (ext === '.json' || ext === '.info' || ext === '.md' || ext === '.html')
  ) {
    const inlineMarkdown = ext === '.json' ? trySummarizeJson(filePath, 'coverage') : undefined;
    return { kind: 'coverage', label: rel, path: filePath, ...(inlineMarkdown ? { inlineMarkdown } : {}) };
  }

  return null;
}

function renderMarkdown(artifacts: ReviewArtifact[], generatedAt: string): string {
  const lines: string[] = ['# Verification Review Bundle', '', `_Generated: ${generatedAt}_`, ''];

  if (artifacts.length === 0) {
    lines.push('No verification artifacts discovered.');
    return lines.join('\n');
  }

  // Overview table
  lines.push('| Category | Count |', '| --- | ---: |');
  for (const section of SECTION_ORDER) {
    const count = artifacts.filter((a) => a.kind === section.kind).length;
    if (count > 0) {
      lines.push(`| ${section.heading} | ${count} |`);
    }
  }
  lines.push('');

  for (const section of SECTION_ORDER) {
    const items = artifacts.filter((a) => a.kind === section.kind);
    if (items.length === 0) continue;

    lines.push(`## ${section.heading}`, '');
    for (const item of items) {
      const safeLabel = escapeMdText(item.label);
      if (item.kind === 'screenshot') {
        lines.push(`- Screenshot: ${safeLabel}`);
      } else if (item.inlineMarkdown) {
        const heading = `### ${safeLabel}`;
        const body = item.inlineMarkdown.startsWith('```mermaid')
          ? item.inlineMarkdown
          : escapeMdText(item.inlineMarkdown);
        lines.push(heading, '', body, '');
      } else {
        lines.push(`- ${safeLabel}`);
      }
    }
    if (lines[lines.length - 1] !== '') lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Discovers verification artifacts (screenshots, videos, traces, statecharts, benchmarks,
 * coverage, verdicts, guard reports, verifier receipts) under `reportsDir` and builds a
 * scannable artifact-first Markdown review bundle.
 */
export function buildReviewBundle(reportsDir: string, extra?: ReviewArtifact[]): ReviewBundle {
  const generatedAt = new Date().toISOString();
  const discovered: ReviewArtifact[] = [];

  for (const filePath of walkFiles(reportsDir)) {
    const artifact = classifyFile(filePath, reportsDir);
    if (artifact) discovered.push(artifact);
  }

  const artifacts = [...discovered, ...(extra ?? [])];
  const markdown = renderMarkdown(artifacts, generatedAt);

  return {
    schema: 'vgate.review-bundle/1',
    generatedAt,
    artifacts,
    markdown,
  };
}
