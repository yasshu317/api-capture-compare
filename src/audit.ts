/**
 * audit.ts  —  simplified one-command API auditor
 *
 * Usage:
 *   npm run audit
 *   npm run audit -- --url "https://app.example.com/page?KEY=abc"
 *   npm run audit -- --apis "api/v1/payments,api/v1/users" --newBase "https://new.example.com"
 *
 * Flow:
 *   1. Browser opens → login page (or saved session skips login entirely)
 *   2. Log in → browser automatically detects you are past the login page
 *   3. Navigate to any pages you want to audit
 *   4. Press Ctrl+C in the terminal  OR  close the browser window
 *   5. Report is generated automatically
 */

import { chromium, BrowserContext, Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { config } from './config';
import { auditCompare, AuditComparison } from './utils/audit-diff';

const STATE_FILE  = path.resolve(__dirname, '..', 'browser-state.json');
const REPORT_JSON = path.resolve(__dirname, '..', 'audit-report.json');
const REPORT_HTML = path.resolve(__dirname, '..', 'audit-report.html');
const CALLS_JSON  = path.resolve(__dirname, '..', 'api-calls-log.json');
const CALLS_TXT   = path.resolve(__dirname, '..', 'api-calls-log.txt');

interface AuditEntry {
  id:          number;
  method:      string;
  originalUrl: string;
  newUrl:      string;
  comparison:  AuditComparison;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

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
  if (postData && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    init.body = postData;
  }
  const res  = await fetch(url, init);
  const ct   = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body, authFound };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    const ct = response.headers()['content-type'] ?? '';
    return ct.includes('application/json') ? await response.json() : await response.text();
  } catch {
    return null;
  }
}

// ─── deduplication ────────────────────────────────────────────────────────────

function endpointKey(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function deduplicateByPath(entries: AuditEntry[]): AuditEntry[] {
  const seen = new Map<string, AuditEntry>();
  for (const e of entries) {
    const key = `${e.method}::${endpointKey(e.originalUrl)}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

// ─── pass / fail ──────────────────────────────────────────────────────────────

function isPassed(e: AuditEntry): boolean {
  const c = e.comparison;
  return c.statusMatch && c.keysMatch && c.countMatch !== false && !c.error;
}

// ─── reports ──────────────────────────────────────────────────────────────────

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
    issues.push(`Status changed: old system returned <strong>${c.originalStatus}</strong>, new system returned <strong>${c.newStatus}</strong>`);
  if (c.countMatch === false)
    issues.push(`Record count changed: old system returned <strong>${c.originalCount}</strong> records, new system returned <strong>${c.newCount}</strong>`);
  if (c.missingKeys.length)
    issues.push(`New system is <strong>missing</strong> these fields: <code>${c.missingKeys.join(', ')}</code>`);
  if (c.extraKeys.length)
    issues.push(`New system has <strong>extra</strong> fields not in old system: <code>${c.extraKeys.join(', ')}</code>`);
  if (c.error)
    issues.push(`Could not reach new system: <code>${c.error}</code>`);
  return issues;
}

function renderHtml(
  entries:       AuditEntry[],
  originalBase:  string,
  newBase:       string,
  auditPatterns: string[],
): string {
  const passCount  = entries.filter(isPassed).length;
  const failCount  = entries.length - passCount;
  const allPass    = failCount === 0;
  const pct        = entries.length > 0 ? Math.round((passCount / entries.length) * 100) : 0;
  const generated  = new Date().toLocaleString();

  const overallBanner = allPass
    ? `<div class="banner pass-banner">
        <span class="banner-icon">✓</span>
        <div><strong>All APIs are working correctly on the new system</strong><br>
        Every checked API returned the same structure as the old system.</div>
       </div>`
    : `<div class="banner fail-banner">
        <span class="banner-icon">⚠</span>
        <div><strong>${failCount} API${failCount > 1 ? 's need' : ' needs'} attention</strong><br>
        ${passCount} out of ${entries.length} APIs passed. Please review the failed items below.</div>
       </div>`;

  const cards = entries.map((e) => {
    const c        = e.comparison;
    const passed   = isPassed(e);
    const issues   = issueList(c);
    const label    = apiLabel(e.originalUrl);

    const countBadge = c.countMatch === false
      ? `<span class="badge badge-warn">▲ Count differs</span>`
      : c.countMatch === true
        ? `<span class="badge badge-ok">✓ Match</span>`
        : '';

    const recordLine = (c.originalCount !== null || c.newCount !== null)
      ? `<div class="record-row">
           <div class="record-box"><div class="record-label">Old Records</div><div class="record-num">${c.originalCount ?? '—'}</div></div>
           <div class="record-arrow">→</div>
           <div class="record-box"><div class="record-label">New Records</div><div class="record-num">${c.newCount ?? '—'}</div></div>
           ${countBadge}
         </div>`
      : `<p class="dim">No record count available</p>`;

    const keySection = (label: string, keys: string[], cls: string) =>
      keys.length === 0 ? '' :
      `<div class="key-group">
         <div class="key-group-label ${cls}">${label} (${keys.length})</div>
         <div class="key-chips">
           ${keys.map((k) => `<span class="chip ${cls}">${k}</span>`).join('')}
         </div>
       </div>`;

    const keyBlock = (!c.keysMatch)
      ? `<div class="key-diff">
           ${keySection('Missing in new system', c.missingKeys, 'missing')}
           ${keySection('Extra in new system',   c.extraKeys,   'extra')}
         </div>`
      : `<p class="dim key-ok">✓ All nested keys match between old and new system</p>`;

    const issueBlock = issues.length
      ? `<div class="issues"><div class="issues-title">What needs attention:</div>
           <ul>${issues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`
      : `<p class="ok-msg">✓ Structure and record count look correct.</p>`;

    return `
    <div class="card ${passed ? 'card-pass' : 'card-fail'}">
      <div class="card-header">
        <div>
          <div class="card-title">${label}</div>
          <div class="card-meta">${e.method} · API #${e.id}</div>
        </div>
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
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Audit Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;color:#222;padding:32px 16px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:24px;color:#1a237e;margin-bottom:4px}
.sub{color:#888;font-size:13px;margin-bottom:24px}

/* banner */
.banner{display:flex;align-items:flex-start;gap:16px;padding:20px 24px;border-radius:10px;margin-bottom:24px;font-size:15px}
.banner-icon{font-size:28px;line-height:1}
.pass-banner{background:#e8f5e9;border-left:5px solid #43a047}
.fail-banner{background:#fff3e0;border-left:5px solid #fb8c00}

/* stats */
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.stat{background:#fff;border-radius:10px;padding:16px 20px;flex:1;min-width:120px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.stat-num{font-size:32px;font-weight:700;color:#1a237e}
.stat-label{font-size:12px;color:#888;margin-top:4px}
.stat-num.green{color:#43a047}
.stat-num.red{color:#e53935}

/* meta */
.meta-box{background:#fff;border-radius:10px;padding:16px 20px;margin-bottom:24px;font-size:13px;color:#555;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.meta-box strong{color:#333}

/* cards */
.card{background:#fff;border-radius:10px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
.card-pass{border-left:5px solid #43a047}
.card-fail{border-left:5px solid #e53935}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;border-bottom:1px solid #f0f0f0}
.card-title{font-size:16px;font-weight:600;color:#1a237e}
.card-meta{font-size:12px;color:#888;margin-top:4px}
.card-body{padding:16px 20px;display:flex;flex-direction:column;gap:12px}

/* badges */
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600;white-space:nowrap}
.badge-pass{background:#e8f5e9;color:#2e7d32}
.badge-fail{background:#ffebee;color:#c62828}
.badge-ok{background:#e8f5e9;color:#2e7d32;font-size:12px}
.badge-warn{background:#fff3e0;color:#e65100;font-size:12px}

/* record row */
.record-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.record-box{background:#f5f5f5;border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
.record-label{font-size:11px;color:#888}
.record-num{font-size:24px;font-weight:700;color:#1a237e}
.record-arrow{font-size:20px;color:#aaa}

/* issues */
.issues{background:#fff8e1;border-radius:8px;padding:14px 16px}
.issues-title{font-weight:600;font-size:13px;color:#e65100;margin-bottom:8px}
.issues ul{padding-left:18px}
.issues li{font-size:14px;line-height:1.8;color:#444}
.ok-msg{color:#2e7d32;font-size:14px}

/* key diff */
.key-diff{display:flex;flex-direction:column;gap:10px}
.key-group-label{font-size:12px;font-weight:700;margin-bottom:6px;padding:3px 8px;border-radius:4px;display:inline-block}
.missing{background:#ffebee;color:#c62828}
.extra{background:#e3f2fd;color:#1565c0}
.key-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11px;padding:3px 8px;border-radius:4px;font-family:monospace}
.chip.missing{background:#ffebee;color:#c62828}
.chip.extra{background:#e3f2fd;color:#1565c0}
.key-ok{color:#2e7d32;font-size:13px}

/* url block */
.url-block{font-size:12px;color:#888;border-top:1px solid #f0f0f0;padding-top:10px;word-break:break-all}
.url-block div{margin-bottom:3px}
.url-label{font-weight:600;color:#aaa}
.url-text{color:#999}
.dim{color:#aaa;font-size:13px}

footer{text-align:center;margin-top:32px;font-size:12px;color:#bbb}
</style>
</head>
<body>
<div class="wrap">
  <h1>📋 API Audit Report</h1>
  <div class="sub">Generated on ${generated} · ${entries.length} APIs checked · ${pct}% passing</div>

  ${overallBanner}

  <div class="stats">
    <div class="stat"><div class="stat-num green">${passCount}</div><div class="stat-label">APIs Working ✓</div></div>
    <div class="stat"><div class="stat-num red">${failCount}</div><div class="stat-label">Need Attention ⚠</div></div>
    <div class="stat"><div class="stat-num">${entries.length}</div><div class="stat-label">Total Checked</div></div>
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

function writeCallsLog(entries: AuditEntry[], newBase: string, patterns: string[]): void {
  const generated = new Date().toLocaleString();
  const jsonLog = {
    generatedAt: new Date().toISOString(),
    newApiBase: newBase,
    auditedApis: patterns,
    uniqueEndpoints: entries.length,
    calls: entries.map((e) => ({
      id: e.id,
      method: e.method,
      legacyUrl: e.originalUrl,
      newUrl: e.newUrl,
      legacyStatus: e.comparison.originalStatus,
      newStatus: e.comparison.newStatus,
      result: isPassed(e) ? 'PASS' : 'FAIL',
    })),
  };
  fs.writeFileSync(CALLS_JSON, JSON.stringify(jsonLog, null, 2));

  const divider = '─'.repeat(80);
  const lines = [
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║                     API CALLS LOG — Legacy vs New                           ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '', ` Generated : ${generated}`, ` New server: ${newBase}`,
    ` APIs watched: ${patterns.join(', ')}`, ` Total calls : ${entries.length}`, '', divider, '',
  ];

  for (const e of entries) {
    const result   = isPassed(e) ? '✓ PASS' : '✗ FAIL';
    const c        = e.comparison;
    lines.push(` #${e.id} [${e.method}] ${result}`);
    lines.push('');
    lines.push(`  LEGACY (${c.originalStatus ?? '—'}) ${e.originalUrl}`);
    lines.push(`  NEW    (${c.newStatus ?? '—'}) ${e.newUrl}`);
    lines.push('');
    if (c.originalCount !== null || c.newCount !== null) {
      const countState = c.countMatch === false ? '⚠ MISMATCH' : c.countMatch === true ? '✓ Match' : '';
      lines.push(`  Records: ${c.originalCount ?? '—'} (old) → ${c.newCount ?? '—'} (new) ${countState}`);
    }
    if (c.missingKeys.length) lines.push(`  Missing fields in new: ${c.missingKeys.join(', ')}`);
    if (c.extraKeys.length)   lines.push(`  Extra fields in new:   ${c.extraKeys.join(', ')}`);
    if (c.error)              lines.push(`  ERROR: ${c.error}`);
    lines.push('', divider, '');
  }

  const passCount = entries.filter(isPassed).length;
  lines.push(` SUMMARY: ${passCount} PASS / ${entries.length - passCount} FAIL / ${entries.length} TOTAL`, '');
  fs.writeFileSync(CALLS_TXT, lines.join('\n'));
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const program = new Command();
  program
    .name('audit')
    .description('Intercept APIs, replay against new host, compare nested structure')
    .option('--url <url>',     'Full target URL to navigate to (overrides TARGET_PATH in .env)')
    .option('--apis <list>',   'Comma-separated API path patterns (overrides AUDIT_APIS in .env)')
    .option('--newBase <url>', 'New base URL to replay against (overrides NEW_API_BASE in .env)')
    .parse(process.argv);

  const opts     = program.opts<{ url?: string; apis?: string; newBase?: string }>();
  const newBase  = opts.newBase  ?? config.newApiBase ?? config.newBaseUrl;
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

  console.log(chalk.blue('\n[audit] ── Configuration ────────────────────────────'));
  console.log(`  New base URL : ${newBase}`);
  console.log(`  Watching     : ${auditApis.join(' | ')}`);
  console.log(chalk.blue('[audit] ─────────────────────────────────────────────\n'));

  // ── browser ──
  const browser  = await chromium.launch({ headless: false });
  const stateExists = fs.existsSync(STATE_FILE);
  let context: BrowserContext;

  if (stateExists) {
    console.log(chalk.gray('[audit] Loading saved session (no login needed)...'));
    context = await browser.newContext({ storageState: STATE_FILE });
  } else {
    console.log(chalk.yellow('[audit] No saved session — browser will open the login page.'));
    console.log(chalk.yellow('[audit] Log in, then navigate to the pages you want to audit.\n'));
    context = await browser.newContext();
  }

  const page = await context.newPage();

  // ── intercept ──
  const entries:    AuditEntry[] = [];
  let   idCounter = 1;
  const pending   = new Map<string, { id: number; method: string; url: string; headers: Record<string, string>; postData: string | null }>();

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
      if (result.authFound.length) {
        console.log(chalk.gray(`  auth forwarded → ${result.authFound.join(' ')}`));
      }
    } catch (e) {
      replayError = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`  [↔] ERROR ${newUrl} — ${replayError}`));
    }

    const comparison = auditCompare(originalStatus, originalBody, newStatus, newBody, replayError);
    entries.push({ id: req.id, method: req.method, originalUrl: req.url, newUrl, comparison });

    // live summary line
    const sm = comparison.statusMatch  ? chalk.green('✓') : chalk.red('✗');
    const km = comparison.keysMatch    ? chalk.green('✓') : chalk.red('✗');
    const cm = comparison.countMatch === null
      ? chalk.gray('—')
      : comparison.countMatch ? chalk.green('✓') : chalk.red('✗');

    console.log(
      `  Status ${sm}  Keys ${km}  Rows ${cm}` +
      (comparison.missingKeys.length ? chalk.red(`  missing: ${comparison.missingKeys.slice(0, 5).join(', ')}${comparison.missingKeys.length > 5 ? '…' : ''}`) : '') +
      (comparison.extraKeys.length   ? chalk.blue(`  extra: ${comparison.extraKeys.slice(0, 5).join(', ')}${comparison.extraKeys.length > 5 ? '…' : ''}`)   : '') +
      (comparison.originalCount !== null ? chalk.gray(`  (${comparison.originalCount} → ${comparison.newCount})`) : ''),
    );
  });

  // ── navigate ──
  if (!stateExists) {
    await page.goto(config.loginUrl, { waitUntil: 'load', timeout: 60_000 });
    // Wait until user navigates away from the login page
    console.log(chalk.yellow('[audit] Waiting for login...'));
    try {
      await page.waitForURL(
        (url) => !url.toString().includes(config.loginPath.replace(/^\//, '')),
        { timeout: 300_000 },
      );
      // Save session once logged in
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(chalk.green('[audit] ✓ Logged in! Session saved.'));
    } catch {
      console.log(chalk.yellow('[audit] Could not auto-detect login — continuing anyway.'));
    }
  } else {
    // Restore session — navigate to app home or provided URL
    const startUrl = opts.url ?? config.uiUrl;
    try {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 60_000 });
    } catch {
      console.log(chalk.yellow('[audit] Page slow to load — continuing anyway.'));
    }
  }

  console.log(chalk.blue('\n[audit] Browser is open. Navigate and interact with your app.'));
  console.log(chalk.yellow('[audit] When done: press Ctrl+C here  OR  close the browser window.\n'));

  // ── finish on Ctrl+C or browser close ──
  async function finish(): Promise<void> {
    console.log(chalk.gray('\n[audit] Stopping...'));
    try { await page.waitForTimeout(800); } catch { /* browser may already be closed */ }

    if (entries.length === 0) {
      console.log(chalk.yellow('[audit] No matching API calls were captured.'));
      console.log(chalk.yellow(`[audit] Patterns watched: ${auditApis.join(', ')}`));
      process.exit(0);
    }

    const deduped = deduplicateByPath(entries);
    console.log(chalk.gray(
      `[audit] ${entries.length} call(s) → ${deduped.length} unique endpoint(s) after deduplication`,
    ));

    fs.writeFileSync(REPORT_JSON, JSON.stringify(entries, null, 2));
    fs.writeFileSync(REPORT_HTML, renderHtml(deduped, config.uiUrl, newBase, auditApis));
    writeCallsLog(deduped, newBase, auditApis);

    const passCount = deduped.filter(isPassed).length;
    console.log(`\n${chalk.green('[audit] Done!')}`);
    console.log(`  ${chalk.cyan('HTML report :')} ${REPORT_HTML}`);
    console.log(`  ${chalk.cyan('JSON report :')} ${REPORT_JSON}`);
    console.log(`  ${chalk.cyan('Calls log   :')} ${CALLS_TXT}`);
    console.log(`  ${chalk.green('Pass:')} ${passCount}  ${chalk.red('Fail:')} ${deduped.length - passCount}  Total: ${deduped.length}`);
    process.exit(0);
  }

  // Browser closed by user
  browser.on('disconnected', () => { finish(); });

  // Ctrl+C
  process.on('SIGINT', async () => {
    try { await browser.close(); } catch { /* already closed */ }
    await finish();
  });

  // Keep process alive while browser is open
  await new Promise<void>((resolve) => browser.on('disconnected', resolve));
}

run().catch((err) => {
  console.error(chalk.red('[audit] Fatal error:'), err);
  process.exit(1);
});
