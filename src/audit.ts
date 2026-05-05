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
  const outputFiles = [REPORT_HTML, REPORT_JSON, CALLS_JSON, CALLS_TXT];
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

  // Save individual response files for this run
  for (const e of rawEntries) {
    const safeName = `${String(e.id).padStart(3, '0')}_${e.method}_${
      (() => { try { return new URL(e.originalUrl).pathname; } catch { return e.originalUrl; } })()
        .replace(/\//g, '_').replace(/^_/, '').replace(/_$/, '') || 'response'
    }.json`;

    fs.writeFileSync(
      path.join(respDir, safeName),
      JSON.stringify({
        id:          e.id,
        method:      e.method,
        originalUrl: e.originalUrl,
        newUrl:      e.newUrl,
        original: {
          status: e.comparison.originalStatus,
          body:   e.originalBody,
        },
        new: {
          status: e.comparison.newStatus,
          body:   e.newBody,
        },
        result:      isPassed(e) ? 'PASS' : 'FAIL',
        captureCount: e.captureCount,
        captureIds:   e.captureIds,
      }, null, 2),
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

function matchesAuditList(url: string, patterns: string[]): boolean {
  return patterns.length > 0 && patterns.some((p) => url.includes(p));
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

function apiLabel(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last  = parts[parts.length - 1] ?? url;
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return url; }
}

function issueList(c: AuditComparison): string[] {
  const issues: string[] = [];
  if (!c.statusMatch)
    issues.push(`Status changed: old returned <strong>${c.originalStatus}</strong>, new returned <strong>${c.newStatus}</strong>`);
  if (c.countMatch === false) {
    const basis = c.countBasis ? ` (counted via ${c.countBasis})` : '';
    issues.push(`Count mismatch${basis}: old = <strong>${c.originalCount}</strong>, new = <strong>${c.newCount}</strong>`);
  }
  if (c.missingKeys.length)
    issues.push(`New system is <strong>missing</strong> fields: <code>${c.missingKeys.join(', ')}</code>`);
  if (c.extraKeys.length)
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
  const passCount = entries.filter(isPassed).length;
  const failCount = entries.length - passCount;
  const allPass   = failCount === 0;
  const pct       = entries.length > 0 ? Math.round((passCount / entries.length) * 100) : 0;
  const generated = new Date().toLocaleString();

  const overallBanner = allPass
    ? `<div class="banner pass-banner"><span class="banner-icon">✓</span>
       <div><strong>All APIs working correctly on the new system</strong><br>
       Every checked API returned the same structure as the old system.</div></div>`
    : `<div class="banner fail-banner"><span class="banner-icon">⚠</span>
       <div><strong>${failCount} unique endpoint${failCount > 1 ? 's need' : ' needs'} attention</strong><br>
       ${passCount} out of ${entries.length} unique endpoints passed.</div></div>`;

  const archiveNote = archiveDir
    ? `<div class="archive-note">Previous run archived → <code>${archiveDir}</code></div>`
    : '';

  const cards = entries.map((e) => {
    const c      = e.comparison;
    const passed = isPassed(e);
    const issues = issueList(c);
    const label  = apiLabel(e.originalUrl);

    const countBadge = c.countMatch === false
      ? `<span class="badge badge-warn">▲ Count differs</span>`
      : c.countMatch === true ? `<span class="badge badge-ok">✓ Match</span>` : '';

    const basisNote = c.countBasis
      ? `<div class="count-basis">Counted via: ${c.countBasis}</div>` : '';

    const recordLine = (c.originalCount !== null || c.newCount !== null)
      ? `<div class="record-row">
           <div class="record-box"><div class="record-label">Old</div><div class="record-num">${c.originalCount ?? '—'}</div></div>
           <div class="record-arrow">→</div>
           <div class="record-box"><div class="record-label">New</div><div class="record-num">${c.newCount ?? '—'}</div></div>
           ${countBadge}
         </div>${basisNote}`
      : `<p class="dim">No count available</p>`;

    const keySection = (lbl: string, keys: string[], cls: string) =>
      keys.length === 0 ? '' :
      `<div class="key-group">
         <div class="key-group-label ${cls}">${lbl} (${keys.length})</div>
         <div class="key-chips">${keys.map((k) => `<span class="chip ${cls}">${k}</span>`).join('')}</div>
       </div>`;

    const keyBlock = !c.keysMatch
      ? `<div class="key-diff">
           ${keySection('Missing in new system', c.missingKeys, 'missing')}
           ${keySection('Extra in new system',   c.extraKeys,   'extra')}
         </div>`
      : `<p class="dim key-ok">✓ All nested keys match</p>`;

    const issueBlock = issues.length
      ? `<div class="issues"><div class="issues-title">What needs attention:</div>
           <ul>${issues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`
      : `<p class="ok-msg">✓ Structure and count look correct.</p>`;

    const idsMeta = e.captureCount > 1
      ? ` · capture IDs ${e.captureIds.join(', ')}`
      : '';

    return `
    <div class="card ${passed ? 'card-pass' : 'card-fail'}">
      <div class="card-header">
        <div><div class="card-title">${label}</div>
             <div class="card-meta">${e.method} · captured <strong>${e.captureCount}×</strong> · comparison uses #${e.id}${idsMeta}</div></div>
        <div class="badge ${passed ? 'badge-pass' : 'badge-fail'}">${passed ? '✓ PASS' : '✗ FAIL'}</div>
      </div>
      <div class="card-body">
        ${recordLine}
        ${issueBlock}
        ${keyBlock}
        <div class="url-block">
          <div><span class="url-label">Old:</span> <span class="url-text">${e.originalUrl}</span></div>
          <div><span class="url-label">New:</span> <span class="url-text">${e.newUrl}</span></div>
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Audit Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;color:#222;padding:32px 16px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:24px;color:#1a237e;margin-bottom:4px}
.sub{color:#888;font-size:13px;margin-bottom:16px}
.archive-note{background:#f5f5f5;border-radius:6px;padding:8px 14px;font-size:12px;color:#999;margin-bottom:20px}
.archive-note code{font-size:11px;color:#777}
.banner{display:flex;align-items:flex-start;gap:16px;padding:20px 24px;border-radius:10px;margin-bottom:24px;font-size:15px}
.banner-icon{font-size:28px;line-height:1}
.pass-banner{background:#e8f5e9;border-left:5px solid #43a047}
.fail-banner{background:#fff3e0;border-left:5px solid #fb8c00}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.stat{background:#fff;border-radius:10px;padding:16px 20px;flex:1;min-width:110px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.stat-num{font-size:32px;font-weight:700;color:#1a237e}
.stat-num.green{color:#43a047}.stat-num.red{color:#e53935}
.stat-label{font-size:12px;color:#888;margin-top:4px}
.meta-box{background:#fff;border-radius:10px;padding:14px 20px;margin-bottom:24px;font-size:13px;color:#555;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card{background:#fff;border-radius:10px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
.card-pass{border-left:5px solid #43a047}.card-fail{border-left:5px solid #e53935}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;border-bottom:1px solid #f0f0f0}
.card-title{font-size:16px;font-weight:600;color:#1a237e}
.card-meta{font-size:12px;color:#888;margin-top:4px}
.card-body{padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600;white-space:nowrap}
.badge-pass{background:#e8f5e9;color:#2e7d32}.badge-fail{background:#ffebee;color:#c62828}
.badge-ok{background:#e8f5e9;color:#2e7d32;font-size:12px}.badge-warn{background:#fff3e0;color:#e65100;font-size:12px}
.record-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.record-box{background:#f5f5f5;border-radius:8px;padding:10px 16px;text-align:center;min-width:80px}
.record-label{font-size:11px;color:#888}.record-num{font-size:24px;font-weight:700;color:#1a237e}
.record-arrow{font-size:20px;color:#aaa}
.count-basis{font-size:11px;color:#aaa;margin-top:4px;font-style:italic}
.issues{background:#fff8e1;border-radius:8px;padding:14px 16px}
.issues-title{font-weight:600;font-size:13px;color:#e65100;margin-bottom:8px}
.issues ul{padding-left:18px}.issues li{font-size:14px;line-height:1.8;color:#444}
.ok-msg{color:#2e7d32;font-size:14px}
.key-diff{display:flex;flex-direction:column;gap:10px}
.key-group-label{font-size:12px;font-weight:700;margin-bottom:6px;padding:3px 8px;border-radius:4px;display:inline-block}
.missing{background:#ffebee;color:#c62828}.extra{background:#e3f2fd;color:#1565c0}
.key-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11px;padding:3px 8px;border-radius:4px;font-family:monospace}
.chip.missing{background:#ffebee;color:#c62828}.chip.extra{background:#e3f2fd;color:#1565c0}
.key-ok{color:#2e7d32;font-size:13px}
.url-block{font-size:12px;color:#888;border-top:1px solid #f0f0f0;padding-top:10px;word-break:break-all}
.url-block div{margin-bottom:3px}.url-label{font-weight:600;color:#aaa}.url-text{color:#999}
.dim{color:#aaa;font-size:13px}
footer{text-align:center;margin-top:32px;font-size:12px;color:#bbb}
</style>
</head>
<body>
<div class="wrap">
  <h1>📋 API Audit Report</h1>
  <div class="sub">Generated on ${generated} · ${totalCaptures} HTTP capture${totalCaptures === 1 ? '' : 's'} · ${entries.length} unique endpoint${entries.length === 1 ? '' : 's'} · ${pct}% passing</div>
  ${archiveNote}
  ${overallBanner}
  <div class="stats">
    <div class="stat"><div class="stat-num green">${passCount}</div><div class="stat-label">Endpoints OK ✓</div></div>
    <div class="stat"><div class="stat-num red">${failCount}</div><div class="stat-label">Need Attention ⚠</div></div>
    <div class="stat"><div class="stat-num">${entries.length}</div><div class="stat-label">Unique Endpoints</div></div>
    <div class="stat"><div class="stat-num">${totalCaptures}</div><div class="stat-label">Total HTTP Captures</div></div>
    <div class="stat"><div class="stat-num">${pct}%</div><div class="stat-label">Pass Rate</div></div>
  </div>
  <div class="meta-box">
    <strong>Old system:</strong> ${originalBase} &nbsp;·&nbsp;
    <strong>New system:</strong> ${newBase} &nbsp;·&nbsp;
    <strong>APIs watched:</strong> ${auditPatterns.join(', ')}
  </div>
  <div id="results">${cards}</div>
  <footer>Report generated automatically · ${generated}</footer>
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
      legacyUrl: e.originalUrl, newUrl: e.newUrl,
      legacyStatus: e.comparison.originalStatus,
      newStatus: e.comparison.newStatus,
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

  // ── clean up session file — no leftover files after run ──
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  const passCount = aggregated.filter(isPassed).length;
  console.log(`\n${chalk.green('[audit] ✅ Done!')}`);
  console.log(`  ${chalk.cyan('HTML report:')} ${REPORT_HTML}`);
  console.log(`  ${chalk.cyan('JSON report:')} ${REPORT_JSON}`);
  console.log(`  ${chalk.cyan('Calls log  :')} ${CALLS_TXT}`);
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
