import { chromium, BrowserContext, Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { config } from './config';
import { auditCompare, AuditComparison } from './utils/audit-diff';

const STATE_FILE    = path.resolve(__dirname, '..', 'browser-state.json');
const REPORT_JSON   = path.resolve(__dirname, '..', 'audit-report.json');
const REPORT_HTML   = path.resolve(__dirname, '..', 'audit-report.html');
const CALLS_JSON    = path.resolve(__dirname, '..', 'api-calls-log.json');
const CALLS_TXT     = path.resolve(__dirname, '..', 'api-calls-log.txt');

interface AuditEntry {
  id:          number;
  method:      string;
  originalUrl: string;
  newUrl:      string;
  comparison:  AuditComparison;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function saveState(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(chalk.gray(`\n[audit] Session saved to ${STATE_FILE}`));
}

function matchesAuditList(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => url.includes(p));
}

function swapBase(url: string, originalBase: string, newBase: string): string {
  return url.replace(
    originalBase.replace(/\/$/, ''),
    newBase.replace(/\/$/, ''),
  );
}

// Headers that must NOT be forwarded to the new host
const SKIP_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'origin',        // would point to old host — causes CORS rejection
  'referer',       // would point to old host page
]);

// Headers we log so you can confirm auth is forwarded
const AUTH_HEADER_PREFIXES = ['authorization', 'cookie', 'x-auth', 'x-token', 'x-api-key', 'x-access-token'];

function forwardableHeaders(headers: Record<string, string>): {
  filtered: Record<string, string>;
  authFound: string[];
} {
  const filtered: Record<string, string> = {};
  const authFound: string[] = [];

  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    filtered[k] = v;
    if (AUTH_HEADER_PREFIXES.some((prefix) => k.toLowerCase().startsWith(prefix))) {
      // show key name + masked value (first 12 chars)
      authFound.push(`${k}: ${v.slice(0, 12)}…`);
    }
  }
  return { filtered, authFound };
}

async function replayRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
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
    if (ct.includes('application/json')) return await response.json();
    return await response.text();
  } catch {
    return null;
  }
}

// ─── HTML report ─────────────────────────────────────────────────────────────

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

function writeCallsLog(entries: AuditEntry[], newBase: string, auditPatterns: string[]): void {
  const generated = new Date().toLocaleString();

  // ── JSON log ──
  const jsonLog = {
    generatedAt:     new Date().toISOString(),
    newApiBase:      newBase,
    auditedApis:     auditPatterns,
    uniqueEndpoints: entries.length,
    calls: entries.map((e) => ({
      id:           e.id,
      method:       e.method,
      legacyUrl:    e.originalUrl,
      newUrl:       e.newUrl,
      legacyStatus: e.comparison.originalStatus,
      newStatus:    e.comparison.newStatus,
      result:       pass(e) ? 'PASS' : 'FAIL',
    })),
  };
  fs.writeFileSync(CALLS_JSON, JSON.stringify(jsonLog, null, 2));

  // ── Plain text log ──
  const divider = '─'.repeat(80);
  const lines: string[] = [
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║              API CALLS LOG — Legacy vs New                                  ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '',
    `  Generated : ${generated}`,
    `  New server: ${newBase}`,
    `  APIs watched: ${auditPatterns.join(', ')}`,
    `  Total calls : ${entries.length}`,
    '',
    divider,
    '',
  ];

  for (const e of entries) {
    const result  = pass(e) ? '✓ PASS' : '✗ FAIL';
    const statusOld = e.comparison.originalStatus ?? '—';
    const statusNew = e.comparison.newStatus ?? '—';
    const countOld  = e.comparison.originalCount !== null ? String(e.comparison.originalCount) : '—';
    const countNew  = e.comparison.newCount !== null      ? String(e.comparison.newCount)      : '—';

    lines.push(`  #${e.id}  [${e.method}]  ${result}`);
    lines.push('');
    lines.push(`  LEGACY  (${statusOld})  ${e.originalUrl}`);
    lines.push(`  NEW     (${statusNew})  ${e.newUrl}`);
    lines.push('');
    lines.push(`  Records: ${countOld} (legacy)  →  ${countNew} (new)  ${e.comparison.countMatch === false ? '⚠ MISMATCH' : e.comparison.countMatch === true ? '✓ Match' : ''}`);

    if (!e.comparison.keysMatch) {
      if (e.comparison.missingKeys.length)
        lines.push(`  Missing fields in new: ${e.comparison.missingKeys.join(', ')}`);
      if (e.comparison.extraKeys.length)
        lines.push(`  Extra fields in new:   ${e.comparison.extraKeys.join(', ')}`);
    }

    if (e.comparison.error) {
      lines.push(`  ERROR: ${e.comparison.error}`);
    }

    lines.push('');
    lines.push(divider);
    lines.push('');
  }

  const passCount = entries.filter(pass).length;
  lines.push(`  SUMMARY:  ${passCount} PASS  /  ${entries.length - passCount} FAIL  /  ${entries.length} TOTAL`);
  lines.push('');

  fs.writeFileSync(CALLS_TXT, lines.join('\n'));
}

function pass(e: AuditEntry): boolean {
  const c = e.comparison;
  return c.statusMatch && c.keysMatch && c.countMatch !== false && !c.error;
}

function apiLabel(url: string): string {
  try {
    const u = new URL(url);
    // Turn /api/paycheck-details into "Paycheck Details"
    const parts = u.pathname.split('/').filter(Boolean);
    const last  = parts[parts.length - 1] ?? u.pathname;
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return url; }
}

function issueList(c: AuditComparison): string[] {
  const issues: string[] = [];
  if (!c.statusMatch)
    issues.push(`Old system responded <b>${c.originalStatus}</b>, new system responded <b>${c.newStatus}</b>`);
  if (c.countMatch === false)
    issues.push(`Record count changed: old system returned <b>${c.originalCount}</b> records, new system returned <b>${c.newCount}</b>`);
  if (c.missingKeys.length)
    issues.push(`New system is missing data fields: <b>${c.missingKeys.join(', ')}</b>`);
  if (c.extraKeys.length)
    issues.push(`New system has extra data fields: <b>${c.extraKeys.join(', ')}</b>`);
  if (c.error)
    issues.push(`Could not reach new system: ${c.error}`);
  return issues;
}

function renderHtml(entries: AuditEntry[], originalBase: string, newBase: string, auditPatterns: string[]): string {
  const passCount  = entries.filter(pass).length;
  const failCount  = entries.length - passCount;
  const allPass    = failCount === 0;
  const generated  = new Date().toLocaleString();
  const pct        = entries.length > 0 ? Math.round((passCount / entries.length) * 100) : 0;

  const overallBanner = allPass
    ? `<div style="background:#e8f5e9;border-left:5px solid #2e7d32;padding:16px 20px;border-radius:6px;margin-bottom:24px">
         <div style="font-size:20px;font-weight:700;color:#2e7d32">&#10003; All APIs are working correctly on the new system</div>
         <div style="color:#388e3c;margin-top:4px">Every checked API returned the same data as the old system. The migration looks good.</div>
       </div>`
    : `<div style="background:#fff8e1;border-left:5px solid #f9a825;padding:16px 20px;border-radius:6px;margin-bottom:24px">
         <div style="font-size:20px;font-weight:700;color:#e65100">&#9888; ${failCount} API${failCount > 1 ? 's need' : ' needs'} attention</div>
         <div style="color:#795548;margin-top:4px">${passCount} out of ${entries.length} APIs passed. Please review the failed items below before sign-off.</div>
       </div>`;

  const cards = entries.map((e) => {
    const c       = e.comparison;
    const isPassed = pass(e);
    const issues   = issueList(c);
    const label    = apiLabel(e.originalUrl);

    const recordLine = (c.originalCount !== null || c.newCount !== null)
      ? `<div style="display:flex;gap:32px;margin-top:10px">
           <div>
             <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px">Old System Records</div>
             <div style="font-size:22px;font-weight:700;color:#1565c0">${c.originalCount ?? '—'}</div>
           </div>
           <div style="align-self:center;font-size:22px;color:#bbb">→</div>
           <div>
             <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px">New System Records</div>
             <div style="font-size:22px;font-weight:700;color:${c.countMatch === false ? '#c62828' : '#2e7d32'}">${c.newCount ?? '—'}</div>
           </div>
           ${c.countMatch !== false
             ? `<div style="align-self:center;margin-left:8px;font-size:18px;color:#2e7d32">&#10003; Match</div>`
             : `<div style="align-self:center;margin-left:8px;font-size:14px;color:#c62828;font-weight:600">&#9650; Count differs</div>`}
         </div>`
      : `<div style="margin-top:10px;color:#aaa;font-size:13px">No record count available for this API</div>`;

    const issueBlock = issues.length
      ? `<div style="margin-top:14px;padding:12px 16px;background:#fff3e0;border-radius:6px;border-left:4px solid #ff9800">
           <div style="font-weight:600;color:#e65100;margin-bottom:6px">What needs to be checked:</div>
           <ul style="margin:0;padding-left:18px;color:#5d4037;font-size:13px;line-height:1.8">
             ${issues.map((i) => `<li>${i}</li>`).join('')}
           </ul>
         </div>`
      : `<div style="margin-top:14px;padding:10px 16px;background:#f1f8e9;border-radius:6px;color:#558b2f;font-size:13px">
           &#10003; Everything looks correct — same records, same data structure, same response.
         </div>`;

    const urlBlock = `<div style="margin-top:10px;font-size:11px;color:#aaa;word-break:break-all">
      <span style="font-weight:600">Checked:</span> ${e.originalUrl}<br>
      <span style="font-weight:600">Against:</span> ${e.newUrl}
    </div>`;

    return `
      <div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);
                  padding:22px 26px;margin-bottom:16px;
                  border-left:5px solid ${isPassed ? '#4caf50' : '#ef5350'}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:18px;font-weight:700;color:#222">${label}</div>
            <div style="font-size:12px;color:#999;margin-top:2px">${e.method} &nbsp;·&nbsp; API #${e.id}</div>
          </div>
          <div style="flex-shrink:0;margin-left:16px">
            ${isPassed
              ? `<span style="background:#e8f5e9;color:#2e7d32;padding:6px 18px;border-radius:20px;font-weight:700;font-size:14px">&#10003; PASS</span>`
              : `<span style="background:#ffebee;color:#c62828;padding:6px 18px;border-radius:20px;font-weight:700;font-size:14px">&#10007; FAIL</span>`}
          </div>
        </div>
        ${recordLine}
        ${issueBlock}
        ${urlBlock}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>API Migration Check Report</title>
  <style>
    * { box-sizing:border-box }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
           margin:0;padding:32px;background:#f0f2f5;color:#222;max-width:960px;margin:0 auto;padding:32px 24px }
    h1   { font-size:26px;margin:0 0 4px;color:#1a237e }
    .sub { color:#888;font-size:13px;margin-bottom:28px }
  </style>
</head>
<body>

  <h1>&#128203; API Migration Check Report</h1>
  <div class="sub">
    Generated on ${generated} &nbsp;·&nbsp;
    ${entries.length} APIs checked &nbsp;·&nbsp;
    ${pct}% passing
  </div>

  ${overallBanner}

  <div style="display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap">
    <div style="flex:1;min-width:130px;background:#fff;border-radius:10px;padding:18px 22px;
                box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center">
      <div style="font-size:36px;font-weight:800;color:#2e7d32">${passCount}</div>
      <div style="color:#666;font-size:13px;margin-top:4px">APIs Working &#10003;</div>
    </div>
    <div style="flex:1;min-width:130px;background:#fff;border-radius:10px;padding:18px 22px;
                box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center">
      <div style="font-size:36px;font-weight:800;color:#c62828">${failCount}</div>
      <div style="color:#666;font-size:13px;margin-top:4px">APIs Need Attention &#9888;</div>
    </div>
    <div style="flex:1;min-width:130px;background:#fff;border-radius:10px;padding:18px 22px;
                box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center">
      <div style="font-size:36px;font-weight:800;color:#1565c0">${entries.length}</div>
      <div style="color:#666;font-size:13px;margin-top:4px">Total APIs Checked</div>
    </div>
    <div style="flex:1;min-width:130px;background:#fff;border-radius:10px;padding:18px 22px;
                box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center">
      <div style="font-size:36px;font-weight:800;color:#6a1b9a">${pct}%</div>
      <div style="color:#666;font-size:13px;margin-top:4px">Pass Rate</div>
    </div>
  </div>

  <div style="background:#fff;border-radius:10px;padding:16px 22px;margin-bottom:28px;
              box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:12px;color:#666;line-height:1.8">
    <b style="color:#333">Migration details</b><br>
    Old system: <b style="color:#222">${originalBase}</b><br>
    New system: <b style="color:#222">${newBase}</b>
  </div>

  <div style="font-size:16px;font-weight:700;color:#333;margin-bottom:14px">Results per API</div>
  ${cards}

  <div style="text-align:center;color:#bbb;font-size:11px;margin-top:32px;padding-top:16px;border-top:1px solid #eee">
    Report generated automatically &nbsp;·&nbsp; ${generated}
  </div>

</body>
</html>`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const program = new Command();
  program
    .name('audit')
    .description('Intercept specific APIs, simultaneously replay against new base, compare keys + counts')
    .option('--url <url>',     'Full target URL (overrides TARGET_PATH in .env — use for dynamic keys)')
    .option('--apis <patterns>', 'Comma-separated API path patterns to watch (overrides AUDIT_APIS in .env)')
    .option('--newBase <url>', 'New base URL to replay against (overrides NEW_BASE_URL in .env)')
    .parse(process.argv);

  const opts = program.opts<{ url?: string; apis?: string; newBase?: string }>();

  // Resolve runtime overrides
  const targetUrl   = opts.url ?? config.targetUrl;
  const newBase     = opts.newBase ?? config.newApiBase ?? config.newBaseUrl;
  const auditApis   = opts.apis
    ? opts.apis.split(',').map((s) => s.trim()).filter(Boolean)
    : config.auditApis;

  if (!newBase) {
    console.error(chalk.red('[audit] No new base URL provided.'));
    console.error(chalk.yellow('[audit] Set NEW_BASE_URL in .env or pass --newBase <url>'));
    process.exit(1);
  }

  if (auditApis.length === 0) {
    console.error(chalk.red('[audit] No API patterns defined.'));
    console.error(chalk.yellow('[audit] Set AUDIT_APIS in .env (e.g. /api/paycheck,/api/employees) or pass --apis'));
    process.exit(1);
  }

  console.log(chalk.blue('\n[audit] Configuration'));
  console.log(`  Target URL:      ${targetUrl}`);
  console.log(`  New base URL:    ${newBase}`);
  console.log(`  Watching APIs:   ${auditApis.join('  |  ')}\n`);

  // ── browser setup ──
  const browser = await chromium.launch({ headless: false });
  let context: BrowserContext;
  const stateExists = fs.existsSync(STATE_FILE);

  if (stateExists) {
    console.log(chalk.gray('[audit] Loading saved session...'));
    context = await browser.newContext({ storageState: STATE_FILE });
  } else {
    console.log(chalk.yellow('[audit] No saved session. Browser will open login page.'));
    context = await browser.newContext();
  }

  const page = await context.newPage();

  if (!stateExists) {
    await page.goto(config.loginUrl, { waitUntil: 'load', timeout: 60000 });
    await waitForEnter('\n[audit] Log in manually, then press Enter... ');
    await saveState(context);
  }

  // ── intercept setup ──
  const entries: AuditEntry[] = [];
  let idCounter = 1;

  const pendingMap = new Map<
    string,
    { id: number; method: string; url: string; headers: Record<string, string>; postData: string | null }
  >();

  page.on('request', (request: Request) => {
    if (!matchesAuditList(request.url(), auditApis)) return;
    const id = idCounter++;
    pendingMap.set(`${request.url()}|${id}`, {
      id,
      method:   request.method(),
      url:      request.url(),
      headers:  request.headers(),
      postData: request.postData(),
    });
    console.log(chalk.gray(`  [→] ${request.method()} ${request.url()}`));
  });

  page.on('response', async (response: Response) => {
    const key = [...pendingMap.keys()].find((k) => k.startsWith(response.url() + '|'));
    if (!key) return;

    const req = pendingMap.get(key)!;
    pendingMap.delete(key);

    const originalStatus = response.status();
    const originalBody   = await parseResponseBody(response);
    console.log(chalk.cyan(`  [←] ${originalStatus} ${response.url()}`));

    // ── simultaneous replay ──
    const newUrl = swapBase(req.url, new URL(req.url).origin, newBase);
    let newStatus: number | null  = null;
    let newBody: unknown          = null;
    let replayError: string | undefined;

    try {
      const result = await replayRequest(req.method, newUrl, req.headers, req.postData);
      newStatus = result.status;
      newBody   = result.body;
      console.log(chalk.magenta(`  [↔] ${newStatus} ${newUrl}`));
      if (result.authFound.length > 0) {
        console.log(chalk.gray(`       auth forwarded → ${result.authFound.join('  ')}`));
      } else {
        console.log(chalk.yellow(`       no auth headers detected in this request`));
      }
    } catch (e) {
      replayError = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`  [↔] ERROR ${newUrl} — ${replayError}`));
    }

    // ── compare ──
    const comparison = auditCompare(originalStatus, originalBody, newStatus, newBody, replayError);
    entries.push({ id: req.id, method: req.method, originalUrl: req.url, newUrl, comparison });

    // ── live summary ──
    const statusMark = comparison.statusMatch   ? chalk.green('✓') : chalk.red('✗');
    const keysMark   = comparison.keysMatch      ? chalk.green('✓') : chalk.red('✗');
    const countMark  = comparison.countMatch === null
      ? chalk.gray('—')
      : comparison.countMatch ? chalk.green('✓') : chalk.red('✗');

    console.log(
      `        Status ${statusMark}  Keys ${keysMark}  Rows ${countMark}` +
      (comparison.missingKeys.length ? chalk.red(`  missing: ${comparison.missingKeys.join(', ')}`) : '') +
      (comparison.extraKeys.length   ? chalk.blue(`  extra: ${comparison.extraKeys.join(', ')}`)    : '') +
      (comparison.originalCount !== null ? chalk.gray(`  (${comparison.originalCount} → ${comparison.newCount})`) : ''),
    );
  });

  // ── navigate ──
  // TARGET_PATH in .env is a default. If it still contains placeholder text or
  // is the bare UI root, skip auto-navigation and let the user go there manually.
  const hasPlaceholder = targetUrl === config.uiUrl ||
    targetUrl === config.uiUrl + '/' ||
    targetUrl.includes('RANDOM_KEY') ||
    targetUrl.includes('YOUR_KEY') ||
    targetUrl.includes('placeholder');

  if (hasPlaceholder || !opts.url) {
    console.log(chalk.blue(`\n[audit] Opening app: ${config.uiUrl}`));
    console.log(chalk.yellow('[audit] Navigate manually to the page you want to test, then interact with it.'));
    await page.goto(config.uiUrl, { waitUntil: 'load', timeout: 60000 });
  } else {
    console.log(chalk.blue(`\n[audit] Navigating to ${targetUrl}`));
    try {
      await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });
    } catch {
      // 'load' timed out — page is still usable, continue
      console.log(chalk.yellow('[audit] Page took long to load — continuing anyway. Interact with the browser.'));
    }
  }

  console.log(chalk.yellow('\n[audit] Interact with the page (apply filters, open sections, etc.)'));
  await waitForEnter('[audit] Press Enter when done to save the report... ');

  await page.waitForTimeout(1000); // flush trailing responses
  await browser.close();

  if (entries.length === 0) {
    console.log(chalk.yellow('\n[audit] No matching API calls were captured.'));
    console.log(chalk.yellow(`[audit] Patterns watched: ${auditApis.join(', ')}`));
    process.exit(0);
  }

  // Deduplicate: same endpoint path called multiple times (e.g. pagination
  // page=1, page=2, page=3...) → keep only the FIRST occurrence per path.
  // All calls are still saved to the raw JSON; only the report is deduplicated.
  const dedupedEntries = deduplicateByPath(entries);

  console.log(chalk.gray(
    `\n[audit] ${entries.length} total call(s) captured → ` +
    `${dedupedEntries.length} unique endpoint(s) after deduplication`
  ));

  fs.writeFileSync(REPORT_JSON, JSON.stringify(entries, null, 2));
  fs.writeFileSync(REPORT_HTML, renderHtml(dedupedEntries, config.appBaseUrl, newBase, auditApis));
  writeCallsLog(dedupedEntries, newBase, auditApis);

  const pass = entries.filter(
    (e) => e.comparison.statusMatch && e.comparison.keysMatch && e.comparison.countMatch !== false
  ).length;

  console.log(`\n${chalk.green('[audit] Done!')}`);
  console.log(`  ${chalk.cyan('HTML report:')}  ${REPORT_HTML}`);
  console.log(`  ${chalk.cyan('JSON report:')}  ${REPORT_JSON}`);
  console.log(`  ${chalk.cyan('Calls log:')}    ${CALLS_TXT}`);
  console.log(`  ${chalk.green('Pass:')} ${pass}  ${chalk.red('Fail:')} ${entries.length - pass}  Total: ${entries.length}`);
}

run().catch((err) => {
  console.error(chalk.red('[audit] Fatal error:'), err);
  process.exit(1);
});
