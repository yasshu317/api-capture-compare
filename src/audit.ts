/**
 * audit.ts  —  one-command API auditor
 *
 * Usage:
 *   npm run audit
 *   npm run audit -- --url "https://app.example.com/page?KEY=abc"
 *   npm run audit -- --apis "api/v1/payments,api/v1/users" --newBase "https://new.example.com"
 *
 * Flow:
 *   1. Browser opens → login page  (fresh every run, no stale session)
 *   2. Log in → auto-detected, tool continues automatically
 *   3. Navigate to any pages and interact with the app
 *   4. Press Enter in this terminal when done
 *   5. Report + response files generated; previous run archived automatically
 */

import { chromium, BrowserContext, Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { config } from './config';
import { auditCompare, AuditComparison } from './utils/audit-diff';

// ─── paths ────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const STATE_FILE  = path.join(ROOT, 'browser-state.json');
const REPORT_JSON = path.join(ROOT, 'audit-report.json');
const REPORT_HTML = path.join(ROOT, 'audit-report.html');
const REPORT_CSV  = path.join(ROOT, 'audit-report.csv');
const CALLS_JSON  = path.join(ROOT, 'api-calls-log.json');
const CALLS_TXT   = path.join(ROOT, 'api-calls-log.txt');
const RUNS_DIR    = path.join(ROOT, 'audit-runs');

// ─── types ────────────────────────────────────────────────────────────────────

interface RawEntry {
  id:           number;
  method:       string;
  originalUrl:  string;
  newUrl:       string;
  originalBody: unknown;
  newBody:      unknown;
  comparison:   AuditComparison;
}

/** First capture per endpoint drives legacy-vs-new comparison; captures thereafter increment counts only. */
interface AggregatedAuditRow extends RawEntry {
  captureCount: number;
  captureIds:   number[];
}

// ─── archive ──────────────────────────────────────────────────────────────────

/**
 * Move existing output files into audit-runs/<timestamp>/ before each run.
 * Reports are never deleted — only relocated so history stays under audit-runs/.
 * Saves individual response JSON files into audit-runs/<timestamp>/responses/.
 */
function archivePreviousRun(rawEntries: AggregatedAuditRow[]): string | null {
  const outputFiles = [REPORT_HTML, REPORT_JSON, REPORT_CSV, CALLS_JSON, CALLS_TXT];
  const hasExisting = outputFiles.some((f) => fs.existsSync(f));
  if (!hasExisting && rawEntries.length === 0) return null;

  const ts        = new Date().toISOString()
    .replace(/T/, '_')
    .replace(/:/g, '-')
    .replace(/\..+/, '');              // e.g. 2026-04-12_14-30-00
  const runDir     = path.join(RUNS_DIR, ts);
  const respDir    = path.join(runDir, 'responses');

  fs.mkdirSync(respDir, { recursive: true });

  // Move existing report files
  for (const file of outputFiles) {
    if (fs.existsSync(file)) {
      fs.renameSync(file, path.join(runDir, path.basename(file)));
    }
  }

  // Save individual response files for this run (compact JSON — large payloads are common)
  for (const e of rawEntries) {
    const safeName = responseArtifactFilename(e);
    const legacyChars = serializedPayloadChars(e.originalBody);
    const newChars    = serializedPayloadChars(e.newBody);

    fs.writeFileSync(
      path.join(respDir, safeName),
      JSON.stringify({
        id:          e.id,
        method:      e.method,
        originalUrl: e.originalUrl,
        newUrl:      e.newUrl,
        approxPayloadChars: { legacy: legacyChars, new: newChars },
        original: {
          status: e.comparison.originalStatus,
          body:   e.originalBody,
        },
        new: {
          status: e.comparison.newStatus,
          body:   e.newBody,
        },
        result:       isPassed(e) ? 'PASS' : 'FAIL',
        captureCount: e.captureCount,
        captureIds:   e.captureIds,
      }),
    );
  }

  return runDir;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

/** Match AUDIT_APIS against URL pathname only so query strings cannot trigger false positives (e.g. pattern `patients` matching plan_of_cares URLs whose query mentions `patients`). */
function matchesAuditList(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  try {
    const pathname = new URL(url).pathname;
    return patterns.some((p) => pathname.includes(p));
  } catch {
    return patterns.some((p) => url.includes(p));
  }
}

/** Path fragments from AUDIT_APIS that matched this URL path (for CSV / clarity). */
function matchedAuditFragments(url: string, patterns: string[]): string[] {
  try {
    const pathname = new URL(url).pathname;
    return patterns.filter((p) => pathname.includes(p));
  } catch {
    return patterns.filter((p) => url.includes(p));
  }
}

function swapBase(url: string, originalOrigin: string, newBase: string): string {
  return url.replace(
    originalOrigin.replace(/\/$/, ''),
    newBase.replace(/\/$/, ''),
  );
}

const SKIP_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding',
  'connection', 'origin', 'referer',
]);
const AUTH_PREFIXES = [
  'authorization', 'cookie', 'x-auth', 'x-token', 'x-api-key', 'x-access-token',
];

function forwardableHeaders(headers: Record<string, string>): {
  filtered: Record<string, string>;
  authFound: string[];
} {
  const filtered: Record<string, string> = {};
  const authFound: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    filtered[k] = v;
    if (AUTH_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) {
      authFound.push(`${k}: ${v.slice(0, 12)}…`);
    }
  }
  return { filtered, authFound };
}

async function replayRequest(
  method:   string,
  url:      string,
  headers:  Record<string, string>,
  postData: string | null,
): Promise<{ status: number; body: unknown; authFound: string[] }> {
  const { filtered, authFound } = forwardableHeaders(headers);
  const init: RequestInit = { method, headers: filtered };
  if (postData && !['GET', 'HEAD'].includes(method.toUpperCase())) init.body = postData;
  const res  = await fetch(url, init);
  const ct   = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body, authFound };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    const ct = response.headers()['content-type'] ?? '';
    return ct.includes('application/json') ? await response.json() : await response.text();
  } catch { return null; }
}

function endpointKey(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

/** Serialized size for footprint lines (not byte-accurate for UTF-16 but stable enough for reports). */
function serializedPayloadChars(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return body.length;
  try {
    return JSON.stringify(body).length;
  } catch {
    return String(body).length;
  }
}

function formatPayloadFootprint(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function urlPathAndQuery(url: string): { pathname: string; query: string } {
  try {
    const u = new URL(url);
    const q = u.search ? u.search.slice(1) : '';
    return { pathname: u.pathname || '/', query: q };
  } catch {
    return { pathname: url, query: '' };
  }
}

/** True when every capture replays to the same absolute URL as was observed (usually misconfigured NEW_API_BASE). */
function isReplaySameUrlAsCapture(entries: AggregatedAuditRow[]): boolean {
  return entries.length > 0 && entries.every((e) => e.originalUrl === e.newUrl);
}

function responseArtifactFilename(e: Pick<AggregatedAuditRow, 'id' | 'method' | 'originalUrl'>): string {
  const safePath =
    (() => {
      try { return new URL(e.originalUrl).pathname; } catch { return e.originalUrl; }
    })()
      .replace(/\//g, '_').replace(/^_/, '').replace(/_$/, '') || 'response';
  return `${String(e.id).padStart(3, '0')}_${e.method}_${safePath}.json`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function aggregateByEndpoint(entries: RawEntry[]): AggregatedAuditRow[] {
  const groups = new Map<string, AggregatedAuditRow>();
  for (const e of entries) {
    const key = `${e.method}::${endpointKey(e.originalUrl)}`;
    const row = groups.get(key);
    if (!row) {
      groups.set(key, {
        ...e,
        captureCount: 1,
        captureIds: [e.id],
      });
    } else {
      row.captureCount += 1;
      row.captureIds.push(e.id);
    }
  }
  return [...groups.values()];
}

function isPassed(e: Pick<RawEntry, 'comparison'>): boolean {
  const c = e.comparison;
  return c.statusMatch && c.keysMatch && c.countMatch !== false && !c.error;
}

// ─── HTML report ──────────────────────────────────────────────────────────────

function prettifyPathSegment(segment: string): string {
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Card title from URL path: strips a leading `/api/v{N}` segment, then joins the rest
 * so `…/patients/offline_dashboard` → "Patients · Offline Dashboard".
 */
function apiLabel(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    let tail = parts;
    if (parts.length >= 2 && parts[0].toLowerCase() === 'api' && /^v\d+$/i.test(parts[1])) {
      tail = parts.slice(2);
    }
    if (tail.length === 0) {
      const fallback = parts[parts.length - 1];
      return fallback ? prettifyPathSegment(fallback) : url;
    }
    return tail.map(prettifyPathSegment).join(' · ');
  } catch {
    return url;
  }
}

function issueList(c: AuditComparison, omitKeyFieldBullets = false): string[] {
  const issues: string[] = [];
  if (!c.statusMatch)
    issues.push(`Status changed: old returned <strong>${c.originalStatus}</strong>, new returned <strong>${c.newStatus}</strong>`);
  if (c.countMatch === false) {
    const basis = c.countBasis ? ` (counted via ${c.countBasis})` : '';
    issues.push(`Count mismatch${basis}: old = <strong>${c.originalCount}</strong>, new = <strong>${c.newCount}</strong>`);
  }
  if (!omitKeyFieldBullets && c.missingKeys.length)
    issues.push(`New system is <strong>missing</strong> fields: <code>${c.missingKeys.join(', ')}</code>`);
  if (!omitKeyFieldBullets && c.extraKeys.length)
    issues.push(`New system has <strong>extra</strong> fields: <code>${c.extraKeys.join(', ')}</code>`);
  if (c.error)
    issues.push(`Could not reach new system: <code>${c.error}</code>`);
  return issues;
}

function renderHtml(
  entries:         AggregatedAuditRow[],
  totalCaptures:   number,
  originalBase:    string,
  newBase:         string,
  auditPatterns:   string[],
  archiveDir:      string | null,
): string {
  const MAX_KEY_CHIPS = 28;
  const passCount     = entries.filter(isPassed).length;
  const failCount     = entries.length - passCount;
  const allPass       = failCount === 0;
  const pct           = entries.length > 0 ? Math.round((passCount / entries.length) * 100) : 0;
  const generated     = new Date().toLocaleString();
  const sameReplay    = isReplaySameUrlAsCapture(entries);
  const archiveFolderName = archiveDir ? path.basename(archiveDir) : '';
  const archiveShort      = archiveDir ? path.relative(ROOT, archiveDir) : '';

  const headlineBanner = allPass
    ? `<div class="banner pass-banner"><span class="banner-icon">✓</span><div><strong>All endpoints passed</strong><span class="banner-sub">Structure and counts align between captured responses and replay.</span></div></div>`
    : `<div class="banner fail-banner"><span class="banner-icon">!</span><div><strong>${failCount} endpoint${failCount === 1 ? '' : 's'} failed</strong><span class="banner-sub">${passCount} of ${entries.length} unique paths passed (${pct}% pass rate).</span></div></div>`;

  const archiveNote = archiveDir
    ? `<p class="run-archive-hint">Previous outputs archived under <code>${escapeHtml(archiveShort)}</code></p>`
    : '';

  const cards = entries.map((e) => {
    const c      = e.comparison;
    const passed = isPassed(e);
    const issues = issueList(c, !c.keysMatch);
    const label  = escapeHtml(apiLabel(e.originalUrl));
    const frags  = matchedAuditFragments(e.originalUrl, auditPatterns);
    const fragLine = frags.length
      ? `<div class="matched-frags">Matched ${frags.map((f) => `<span class="frag-chip">${escapeHtml(f)}</span>`).join(' ')}</div>`
      : '';

    const countBadge = c.countMatch === false
      ? `<span class="badge badge-warn">Count Δ</span>`
      : c.countMatch === true ? `<span class="badge badge-ok">Count ✓</span>` : '';

    const basisNote = c.countBasis
      ? `<p class="count-basis">Compared via ${escapeHtml(c.countBasis)}</p>` : '';

    const recordLine = (c.originalCount !== null || c.newCount !== null)
      ? `<div class="record-row">
           <div class="record-box"><div class="record-label">Old rows</div><div class="record-num">${c.originalCount ?? '—'}</div></div>
           <div class="record-arrow">→</div>
           <div class="record-box"><div class="record-label">New rows</div><div class="record-num">${c.newCount ?? '—'}</div></div>
           ${countBadge}
         </div>${basisNote}`
      : `<p class="dim subtle">No row count inferred</p>`;

    const mkChips = (keys: string[], cls: string) => {
      const slice = keys.slice(0, MAX_KEY_CHIPS);
      const more  = keys.length - slice.length;
      const chips = slice.map((k) => `<span class="chip ${cls}">${escapeHtml(k)}</span>`).join('');
      const moreLbl = more > 0 ? `<span class="chip-more">+${more} more</span>` : '';
      return chips + moreLbl;
    };

    const keyBlock = !c.keysMatch
      ? `<div class="key-diff">
           ${c.missingKeys.length ? `<div class="key-group"><span class="key-group-label missing">Missing in new (${c.missingKeys.length})</span><div class="key-chips">${mkChips(c.missingKeys, 'missing')}</div></div>` : ''}
           ${c.extraKeys.length ? `<div class="key-group"><span class="key-group-label extra">Extra in new (${c.extraKeys.length})</span><div class="key-chips">${mkChips(c.extraKeys, 'extra')}</div></div>` : ''}
         </div>`
      : '';

    const issueBlock = issues.length
      ? `<div class="issues"><p class="issues-title">Needs attention</p><ul>${issues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`
      : '';

    const idsSuffix = e.captureCount > 1
      ? ` · IDs ${e.captureIds.join(', ')}`
      : '';

    const { pathname: pathOnly, query: queryOnly } = urlPathAndQuery(e.originalUrl);
    const pathInner = `<span class="url-label">Path</span> <code>${escapeHtml(pathOnly)}</code>${
      queryOnly ? ` <span class="url-label">· Query</span> <code class="query">${escapeHtml(queryOnly)}</code>` : ''
    }`;

    const legChars = serializedPayloadChars(e.originalBody);
    const nwChars  = serializedPayloadChars(e.newBody);

    const artifactName = responseArtifactFilename(e);
    const dumpHint = archiveFolderName
      ? `<span class="dump-ref">${escapeHtml(`responses/${artifactName}`)}</span>`
      : '';

    const techInner = `
        <p class="path-line">${pathInner}</p>
        <p class="payload-line">Payload ≈ Old ${formatPayloadFootprint(legChars)} · New ${formatPayloadFootprint(nwChars)}${dumpHint ? ` · ${dumpHint}` : ''}</p>
        <div class="url-pair">
          <div><span class="url-label">Captured</span> <span class="mono">${escapeHtml(e.originalUrl)}</span></div>
          <div><span class="url-label">Replay</span> <span class="mono">${escapeHtml(e.newUrl)}</span></div>
        </div>`;

    const summaryOk =
      passed && issues.length === 0 && c.keysMatch
        ? '<p class="ok-inline">✓ Keys and inferred counts match.</p>'
        : '';

    return `
    <article class="card ${passed ? 'card-pass' : 'card-fail'}">
      <header class="card-header">
        <div class="card-head-main">
          <h2 class="card-title">${label}</h2>
          <p class="card-meta"><strong>${escapeHtml(e.method)}</strong> · ${e.captureCount} capture${e.captureCount === 1 ? '' : 's'} · sample #${e.id}${idsSuffix}</p>
          ${fragLine}
        </div>
        <span class="badge ${passed ? 'badge-pass' : 'badge-fail'}">${passed ? 'PASS' : 'FAIL'}</span>
      </header>
      <div class="card-body">
        ${recordLine}
        ${issueBlock}
        ${keyBlock}
        ${summaryOk}
        <details class="tech-details">
          <summary>URLs &amp; payload details</summary>
          <div class="tech-details-body">${techInner}</div>
        </details>
      </div>
    </article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API audit report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eceff4;color:#1e293b;line-height:1.45;padding:28px 16px 48px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:22px;font-weight:650;color:#0f172a;letter-spacing:-0.02em}
.run-archive-hint{font-size:12px;color:#64748b;margin:10px 0 6px}
.run-archive-hint code{font-size:11px;background:#fff;padding:2px 6px;border-radius:4px;color:#475569}
.sub{color:#64748b;font-size:13px;margin-top:6px}
.banner{display:flex;gap:14px;padding:16px 18px;border-radius:12px;margin:18px 0;font-size:14px;align-items:flex-start}
.banner-icon{font-size:22px;line-height:1.25;font-weight:700}
.banner strong{display:block;font-size:15px;margin-bottom:2px}
.banner-sub{display:block;opacity:.9;font-size:13px;font-weight:400;margin-top:2px}
.pass-banner{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}
.fail-banner{background:#fffbeb;border:1px solid #fcd34d;color:#92400e}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0}
.stat{background:#fff;border-radius:10px;padding:14px 12px;text-align:center;border:1px solid #e2e8f0}
.stat-num{font-size:26px;font-weight:700;color:#0f172a}
.stat-num.ok{color:#059669}.stat-num.bad{color:#dc2626}
.stat-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
.config-strip{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;margin-bottom:22px;font-size:13px;color:#475569;display:grid;gap:8px}
.config-strip dl{display:grid;grid-template-columns:140px 1fr;gap:6px 14px;align-items:start}
.config-strip dt{color:#94a3b8;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.config-strip dd{word-break:break-all}
.warn-chip{display:inline-block;margin-top:8px;background:#fef3c7;color:#92400e;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #fcd34d}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:14px;overflow:hidden}
.card-pass{border-left:4px solid #10b981}.card-fail{border-left:4px solid #ef4444}
.card-header{display:flex;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid #f1f5f9;align-items:flex-start}
.card-title{font-size:16px;font-weight:650;color:#0f172a}
.card-meta{font-size:12px;color:#64748b;margin-top:4px}
.card-meta strong{color:#334155}
.matched-frags{margin-top:8px;font-size:11px;color:#64748b}
.frag-chip{display:inline-block;background:#f1f5f9;color:#475569;padding:2px 7px;border-radius:999px;margin-right:4px;margin-bottom:3px;font-family:ui-monospace SFMono-Regular Menlo Monaco Consolas monospace;font-size:10px}
.card-body{padding:14px 18px 16px;display:flex;flex-direction:column;gap:12px}
.badge{padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.03em;flex-shrink:0}
.badge-pass{background:#d1fae5;color:#047857}.badge-fail{background:#fee2e2;color:#b91c1c}
.badge-ok{background:#ecfdf5;color:#065f46;font-size:11px}.badge-warn{background:#fffbeb;color:#b45309;font-size:11px}
.record-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.record-box{background:#f8fafc;border-radius:8px;padding:8px 14px;text-align:center;min-width:72px;border:1px solid #e2e8f0}
.record-label{font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}.record-num{font-size:20px;font-weight:700;color:#0f172a}
.record-arrow{color:#cbd5e1;font-size:18px}
.count-basis{font-size:11px;color:#94a3b8;margin-top:4px}
.subtle{font-size:12px}
.issues{background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px}
.issues-title{font-weight:650;font-size:12px;color:#b45309;margin-bottom:8px;text-transform:uppercase;letter-spacing:.03em}
.issues ul{padding-left:18px}.issues li{font-size:13px;color:#444;margin-bottom:4px}
.ok-inline{font-size:13px;color:#047857;font-weight:500}
.key-diff{display:flex;flex-direction:column;gap:12px}
.key-group{display:flex;flex-direction:column;gap:6px}
.key-group-label{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;display:inline-block;width:fit-content}
.key-chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-size:10px;padding:3px 7px;border-radius:5px;font-family:ui-monospace SFMono-Regular Menlo Monaco Consolas monospace}
.chip.missing{background:#fef2f2;color:#991b1b}.chip.extra{background:#eff6ff;color:#1d4ed8}
.chip-more{font-size:10px;color:#94a3b8;padding:3px 6px}
.tech-details{font-size:12px;border:1px dashed #cbd5e1;border-radius:10px;padding:0;background:#fafafa}
.tech-details summary{cursor:pointer;padding:10px 14px;font-weight:600;color:#475569;list-style-position:outside;margin-left:14px}
.tech-details-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:8px;color:#64748b}
.path-line code,.payload-line,.mono{font-family:ui-monospace SFMono-Regular Menlo Monaco Consolas monospace;font-size:11px;background:#fff;padding:2px 5px;border-radius:4px;border:1px solid #e2e8f0;word-break:break-all}
.url-label{font-weight:600;color:#94a3b8;margin-right:4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.query{font-size:10px}
.url-pair{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.dump-ref{font-family:ui-monospace SFMono-Regular Menlo Monaco Consolas monospace;font-size:10px;color:#64748b}
.dim{color:#94a3b8}
footer{text-align:center;margin-top:28px;font-size:11px;color:#cbd5e1}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.config-strip dl{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <h1>API audit report</h1>
  <p class="sub">${escapeHtml(generated)} · ${totalCaptures} capture${totalCaptures === 1 ? '' : 's'} across ${entries.length} unique path${entries.length === 1 ? '' : 's'} · ${pct}% pass rate</p>
  ${archiveNote}
  ${headlineBanner}
  <div class="stats">
    <div class="stat"><div class="stat-num ok">${passCount}</div><div class="stat-label">Passed</div></div>
    <div class="stat"><div class="stat-num bad">${failCount}</div><div class="stat-label">Failed</div></div>
    <div class="stat"><div class="stat-num">${entries.length}</div><div class="stat-label">Unique paths</div></div>
    <div class="stat"><div class="stat-num">${totalCaptures}</div><div class="stat-label">Total captures</div></div>
  </div>
  <section class="config-strip">
    <dl>
      <dt>Captured UI</dt><dd>${escapeHtml(originalBase)}</dd>
      <dt>Replay base</dt><dd>${escapeHtml(newBase)}</dd>
      <dt>Watchlist</dt><dd>${escapeHtml(auditPatterns.join(', '))}</dd>
    </dl>
    ${sameReplay ? '<p class="warn-chip">Replay URLs match captures — set <code>NEW_API_BASE</code> to another host to compare environments.</p>' : ''}
  </section>
  <div id="results">${cards}</div>
  <footer>Generated automatically</footer>
</div>
</body>
</html>`;
}

// ─── calls log ────────────────────────────────────────────────────────────────

function writeCallsLog(
  entries: AggregatedAuditRow[],
  totalCaptures: number,
  newBase: string,
  patterns: string[],
): void {
  const generated = new Date().toLocaleString();
  fs.writeFileSync(CALLS_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    newApiBase: newBase,
    auditedApis: patterns,
    totalCaptures,
    uniqueEndpoints: entries.length,
    calls: entries.map((e) => ({
      id: e.id,
      representativeId: e.id,
      method: e.method,
      captureCount: e.captureCount,
      captureIds: e.captureIds,
      matchedFragments: matchedAuditFragments(e.originalUrl, patterns),
      legacyUrl: e.originalUrl, newUrl: e.newUrl,
      legacyStatus: e.comparison.originalStatus,
      newStatus: e.comparison.newStatus,
      approxPayloadChars: {
        legacy: serializedPayloadChars(e.originalBody),
        new: serializedPayloadChars(e.newBody),
      },
      result: isPassed(e) ? 'PASS' : 'FAIL',
    })),
  }, null, 2));

  const div = '─'.repeat(80);
  const lines = [
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║                     API CALLS LOG — Legacy vs New                           ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '', ` Generated   : ${generated}`, ` New server  : ${newBase}`,
    ` APIs watched: ${patterns.join(', ')}`,
    ` Total HTTP captures : ${totalCaptures}`,
    ` Unique endpoints    : ${entries.length}`, '', div, '',
  ];

  for (const e of entries) {
    const c      = e.comparison;
    const result = isPassed(e) ? '✓ PASS' : '✗ FAIL';
    lines.push(
      ` #${e.id} [${e.method}] ${result} · captured ${e.captureCount}× (IDs ${e.captureIds.join(', ')})`,
      '',
    );
    lines.push(`  LEGACY (${c.originalStatus ?? '—'}) ${e.originalUrl}`);
    lines.push(`  NEW    (${c.newStatus ?? '—'}) ${e.newUrl}`, '');
    if (c.originalCount !== null || c.newCount !== null) {
      const state = c.countMatch === false ? '⚠ MISMATCH' : c.countMatch === true ? '✓ Match' : '';
      const basis = c.countBasis ? ` [via ${c.countBasis}]` : '';
      lines.push(`  Count${basis}: ${c.originalCount ?? '—'} (old) → ${c.newCount ?? '—'} (new) ${state}`);
    }
    if (c.missingKeys.length) lines.push(`  Missing fields in new : ${c.missingKeys.join(', ')}`);
    if (c.extraKeys.length)   lines.push(`  Extra fields in new   : ${c.extraKeys.join(', ')}`);
    if (c.error)              lines.push(`  ERROR: ${c.error}`);
    lines.push('', div, '');
  }
  const pc = entries.filter(isPassed).length;
  lines.push(
    ` SUMMARY: ${pc} PASS / ${entries.length - pc} FAIL · ${entries.length} unique endpoints · ${totalCaptures} total captures`,
    '',
  );
  fs.writeFileSync(CALLS_TXT, lines.join('\n'));
}

function csvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Spreadsheet-friendly summary (open in Excel / Sheets). UTF-8 BOM for Excel. */
function writeAuditCsv(
  entries: AggregatedAuditRow[],
  newBase: string,
  patterns: string[],
): void {
  const watchlist = patterns.join('; ');
  const header = [
    'Result',
    'Title',
    'Method',
    'Path',
    'MatchedFragments',
    'WatchlistPatterns',
    'CaptureCount',
    'CaptureIds',
    'RepresentativeId',
    'LegacyStatus',
    'NewStatus',
    'OldRowCount',
    'NewRowCount',
    'CountBasis',
    'ApproxLegacyChars',
    'ApproxNewChars',
    'LegacyUrl',
    'NewUrl',
  ];
  const lines = [
    header.join(','),
    ...entries.map((e) => {
      const c      = e.comparison;
      const pathname = endpointKey(e.originalUrl);
      const frags  = matchedAuditFragments(e.originalUrl, patterns);
      return [
        csvCell(isPassed(e) ? 'PASS' : 'FAIL'),
        csvCell(apiLabel(e.originalUrl)),
        csvCell(e.method),
        csvCell(pathname),
        csvCell(frags.join('; ')),
        csvCell(watchlist),
        csvCell(e.captureCount),
        csvCell(e.captureIds.join(' ')),
        csvCell(e.id),
        csvCell(c.originalStatus ?? ''),
        csvCell(c.newStatus ?? ''),
        csvCell(c.originalCount ?? ''),
        csvCell(c.newCount ?? ''),
        csvCell(c.countBasis ?? ''),
        csvCell(serializedPayloadChars(e.originalBody)),
        csvCell(serializedPayloadChars(e.newBody)),
        csvCell(e.originalUrl),
        csvCell(e.newUrl),
      ].join(',');
    }),
  ];
  fs.writeFileSync(REPORT_CSV, `\uFEFF${lines.join('\n')}\n`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const program = new Command();
  program
    .name('audit')
    .description('Intercept APIs, replay against new host, compare nested structure')
    .option('--url <url>',     'Full target URL (overrides TARGET_PATH in .env)')
    .option('--apis <list>',   'Comma-separated API patterns (overrides AUDIT_APIS in .env)')
    .option('--newBase <url>', 'New base URL (overrides NEW_API_BASE in .env)')
    .parse(process.argv);

  const opts      = program.opts<{ url?: string; apis?: string; newBase?: string }>();
  const newBase   = opts.newBase ?? config.newApiBase ?? config.newBaseUrl;
  const auditApis = opts.apis
    ? opts.apis.split(',').map((s) => s.trim()).filter(Boolean)
    : config.auditApis;

  if (!newBase) {
    console.error(chalk.red('\n[audit] No new base URL set.'));
    console.error(chalk.yellow('[audit] Add NEW_API_BASE=https://... to .env  or pass --newBase\n'));
    process.exit(1);
  }
  if (auditApis.length === 0) {
    console.error(chalk.red('\n[audit] No API patterns defined.'));
    console.error(chalk.yellow('[audit] Add AUDIT_APIS=api/v1/foo,api/v1/bar to .env  or pass --apis\n'));
    process.exit(1);
  }

  console.log(chalk.blue('\n[audit] ── Configuration ──────────────────────────────'));
  console.log(`  New base URL : ${newBase}`);
  console.log(`  Watching     : ${auditApis.join(' | ')}`);
  console.log(chalk.blue('[audit] ───────────────────────────────────────────────\n'));

  // ── clean up any previous session so every run starts fresh ──
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    console.log(chalk.gray('[audit] Previous session cleared — starting fresh.'));
  }

  // ── browser ──
  const browser = await chromium.launch({ headless: false });
  console.log(chalk.yellow('[audit] Browser will open the login page.'));
  console.log(chalk.yellow('[audit] Log in and the tool will continue automatically.\n'));
  const context: BrowserContext = await browser.newContext();

  const page = await context.newPage();

  // ── intercept ──
  const rawEntries: RawEntry[] = [];
  let   idCounter = 1;
  const pending   = new Map<string, {
    id: number; method: string; url: string;
    headers: Record<string, string>; postData: string | null;
  }>();

  page.on('request', (req: Request) => {
    if (!matchesAuditList(req.url(), auditApis)) return;
    const id = idCounter++;
    pending.set(`${req.url()}|${id}`, {
      id, method: req.method(), url: req.url(),
      headers: req.headers(), postData: req.postData(),
    });
    console.log(chalk.gray(`  [→] ${req.method()} ${req.url()}`));
  });

  page.on('response', async (res: Response) => {
    const key = [...pending.keys()].find((k) => k.startsWith(res.url() + '|'));
    if (!key) return;
    const req = pending.get(key)!;
    pending.delete(key);

    const originalStatus = res.status();
    const originalBody   = await parseResponseBody(res);
    console.log(chalk.cyan(`  [←] ${originalStatus} ${res.url()}`));

    const newUrl = swapBase(req.url, new URL(req.url).origin, newBase);
    let newStatus: number | null = null;
    let newBody:   unknown       = null;
    let replayError: string | undefined;

    try {
      const result = await replayRequest(req.method, newUrl, req.headers, req.postData);
      newStatus = result.status;
      newBody   = result.body;
      console.log(chalk.magenta(`  [↔] ${newStatus} ${newUrl}`));
      if (result.authFound.length)
        console.log(chalk.gray(`  auth → ${result.authFound.join(' ')}`));
    } catch (e) {
      replayError = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`  [↔] ERROR ${newUrl} — ${replayError}`));
    }

    const comparison = auditCompare(originalStatus, originalBody, newStatus, newBody, replayError);
    rawEntries.push({
      id: req.id, method: req.method,
      originalUrl: req.url, newUrl,
      originalBody, newBody,
      comparison,
    });

    // live summary
    const sm = comparison.statusMatch ? chalk.green('✓') : chalk.red('✗');
    const km = comparison.keysMatch   ? chalk.green('✓') : chalk.red('✗');
    const cm = comparison.countMatch === null
      ? chalk.gray('—')
      : comparison.countMatch ? chalk.green('✓') : chalk.red('✗');
    console.log(
      `  Status ${sm}  Keys ${km}  Rows ${cm}` +
      (comparison.missingKeys.length
        ? chalk.red(`  missing: ${comparison.missingKeys.slice(0, 5).join(', ')}${comparison.missingKeys.length > 5 ? '…' : ''}`)
        : '') +
      (comparison.extraKeys.length
        ? chalk.blue(`  extra: ${comparison.extraKeys.slice(0, 5).join(', ')}${comparison.extraKeys.length > 5 ? '…' : ''}`)
        : '') +
      (comparison.originalCount !== null
        ? chalk.gray(`  (${comparison.originalCount} → ${comparison.newCount} via ${comparison.countBasis})`)
        : ''),
    );
  });

  // ── navigate — always start at login ──
  await page.goto(config.loginUrl, { waitUntil: 'load', timeout: 60_000 });
  console.log(chalk.yellow('[audit] Waiting for you to log in...'));
  try {
    await page.waitForURL(
      (url) => !url.toString().includes(config.loginPath.replace(/^\//, '')),
      { timeout: 300_000 },
    );
    console.log(chalk.green('[audit] ✓ Logged in! Navigate to the pages you want to test.'));
  } catch {
    console.log(chalk.yellow('[audit] Could not auto-detect login — continuing anyway.'));
  }

  console.log(chalk.blue('\n[audit] ✅ Browser is ready.'));
  console.log(chalk.white('  → Navigate to the pages you want to test'));
  console.log(chalk.white('  → Interact with the app (apply filters, open pages, etc.)'));
  console.log(chalk.yellow('\n  When done, come back here and press Enter to generate the report.\n'));

  await waitForEnter(chalk.green('  ▶ Press Enter to stop and generate report... '));

  // flush trailing responses
  try { await page.waitForTimeout(1000); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* already closed */ }

  if (rawEntries.length === 0) {
    console.log(chalk.yellow('\n[audit] No matching API calls were captured.'));
    console.log(chalk.yellow(`[audit] Patterns watched: ${auditApis.join(', ')}`));
    process.exit(0);
  }

  const aggregated = aggregateByEndpoint(rawEntries);
  const totalCaptures = rawEntries.length;
  console.log(chalk.gray(
    `\n[audit] ${totalCaptures} HTTP capture(s) → ${aggregated.length} unique endpoint(s) (comparison uses first capture per path)`,
  ));

  // ── archive previous run + save responses ──
  const archiveDir = archivePreviousRun(aggregated);
  if (archiveDir) {
    console.log(chalk.gray(`[audit] Previous run archived → ${archiveDir}`));
  }

  // ── write new reports ──
  fs.writeFileSync(REPORT_JSON, JSON.stringify({
    summary: {
      generatedAt: new Date().toISOString(),
      totalCaptures,
      uniqueEndpoints: aggregated.length,
      endpointRollup: aggregated.map((row) => ({
        method: row.method,
        path: endpointKey(row.originalUrl),
        captureCount: row.captureCount,
        captureIds: row.captureIds,
        representativeCaptureId: row.id,
      })),
    },
    captures: rawEntries,
  }, null, 2));
  fs.writeFileSync(
    REPORT_HTML,
    renderHtml(aggregated, totalCaptures, config.uiUrl, newBase, auditApis, archiveDir),
  );
  writeCallsLog(aggregated, totalCaptures, newBase, auditApis);
  writeAuditCsv(aggregated, newBase, auditApis);

  // ── clean up session file — no leftover files after run ──
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  const passCount = aggregated.filter(isPassed).length;
  console.log(`\n${chalk.green('[audit] ✅ Done!')}`);
  console.log(`  ${chalk.cyan('HTML report:')} ${REPORT_HTML}`);
  console.log(`  ${chalk.cyan('JSON report:')} ${REPORT_JSON}`);
  console.log(`  ${chalk.cyan('Calls log  :')} ${CALLS_TXT}`);
  console.log(`  ${chalk.cyan('CSV summary:')} ${REPORT_CSV}`);
  if (archiveDir)
    console.log(`  ${chalk.cyan('Responses  :')} ${archiveDir}/responses/`);
  console.log(
    `\n  ${chalk.green('Pass:')} ${passCount}  ${chalk.red('Fail:')} ${aggregated.length - passCount}` +
      `  ${chalk.gray('Unique endpoints:')} ${aggregated.length}` +
      `  ${chalk.gray('Total captures:')} ${totalCaptures}`,
  );
}

run().catch((err) => {
  console.error(chalk.red('[audit] Fatal error:'), err);
  process.exit(1);
});
