import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { compareResponses, DiffSummary } from './utils/diff';
import { config } from './config';

interface CapturedRequest {
  id: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: string | null;
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  } | null;
}

interface ReportEntry {
  id: number;
  method: string;
  originalUrl: string;
  newUrl: string;
  originalStatus: number | null;
  newStatus: number | null;
  statusMatch: boolean;
  diff: DiffSummary;
  error?: string;
}

const COLLECTION_FILE = path.resolve(__dirname, '..', 'api-collection.json');
const REPORT_JSON = path.resolve(__dirname, '..', 'diff-report.json');
const REPORT_HTML = path.resolve(__dirname, '..', 'diff-report.html');

function swapBase(url: string, originalBase: string, newBase: string): string {
  return url.replace(originalBase.replace(/\/$/, ''), newBase.replace(/\/$/, ''));
}

function extractBase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

async function replayRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  postData: string | null,
): Promise<{ status: number; body: unknown }> {
  const filteredHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Skip headers that cause issues when replaying
    if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) continue;
    filteredHeaders[key] = value;
  }

  const init: RequestInit = {
    method,
    headers: filteredHeaders,
  };

  if (postData && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    init.body = postData;
  }

  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') ?? '';

  let body: unknown;
  if (contentType.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  return { status: res.status, body };
}

function renderHtml(report: ReportEntry[]): string {
  const rows = report
    .map((entry) => {
      const statusColor = entry.statusMatch ? '#2e7d32' : '#c62828';
      const diffColor = entry.diff.hasDiff ? '#e65100' : '#2e7d32';
      const diffBadge = entry.diff.hasDiff
        ? `<span style="color:${diffColor}">${entry.diff.totalChanges} change(s)</span>`
        : `<span style="color:${diffColor}">identical</span>`;

      const diffDetails = entry.diff.hasDiff
        ? `
          <details>
            <summary>View diff (${entry.diff.totalChanges} change(s))</summary>
            <pre style="background:#f5f5f5;padding:12px;overflow:auto;font-size:12px">${JSON.stringify(
              {
                added: entry.diff.added,
                deleted: entry.diff.deleted,
                edited: entry.diff.edited,
                arrayChanges: entry.diff.arrayChanges,
              },
              null,
              2,
            )}</pre>
          </details>`
        : '';

      const errorRow = entry.error
        ? `<tr><td colspan="7" style="color:red;font-size:12px">Error: ${entry.error}</td></tr>`
        : '';

      return `
        <tr>
          <td>${entry.id}</td>
          <td><code>${entry.method}</code></td>
          <td style="word-break:break-all;font-size:12px">${entry.originalUrl}</td>
          <td style="word-break:break-all;font-size:12px">${entry.newUrl}</td>
          <td style="color:${statusColor}">${entry.originalStatus ?? '—'} → ${entry.newStatus ?? '—'}</td>
          <td>${diffBadge}</td>
          <td>${diffDetails}</td>
        </tr>
        ${errorRow}`;
    })
    .join('');

  const identical = report.filter((r) => !r.diff.hasDiff && r.statusMatch).length;
  const withDiffs = report.filter((r) => r.diff.hasDiff || !r.statusMatch).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Diff Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 32px; color: #222; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .summary { margin-bottom: 20px; font-size: 14px; color: #555; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th { background: #1565c0; color: #fff; padding: 10px 12px; text-align: left; }
    td { padding: 8px 12px; border-bottom: 1px solid #ddd; vertical-align: top; }
    tr:hover td { background: #f9f9f9; }
    code { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
    details summary { cursor: pointer; color: #1565c0; font-size: 12px; }
  </style>
</head>
<body>
  <h1>API Diff Report</h1>
  <div class="summary">
    Total: <strong>${report.length}</strong> &nbsp;|&nbsp;
    Identical: <strong style="color:#2e7d32">${identical}</strong> &nbsp;|&nbsp;
    With differences: <strong style="color:#c62828">${withDiffs}</strong>
    &nbsp;&mdash;&nbsp; Generated: ${new Date().toISOString()}
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Method</th>
        <th>Original URL</th>
        <th>New URL</th>
        <th>Status</th>
        <th>Diff</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

async function run(): Promise<void> {
  const program = new Command();
  program
    .name('compare')
    .description('Replay captured API calls against a new base URL and diff the responses')
    .option('--newBase <url>', 'New base URL to test against (overrides NEW_BASE_URL in .env)')
    .option('--collection <file>', 'Path to api-collection.json', COLLECTION_FILE)
    .parse(process.argv);

  const opts = program.opts<{ newBase?: string; collection: string }>();

  const newBase = opts.newBase ?? config.newBaseUrl;
  if (!newBase) {
    console.error(chalk.red('[compare] No new base URL provided.'));
    console.error(chalk.yellow('[compare] Either pass --newBase <url> or set NEW_BASE_URL in .env'));
    process.exit(1);
  }

  if (!fs.existsSync(opts.collection)) {
    console.error(chalk.red(`[compare] Collection file not found: ${opts.collection}`));
    console.error(chalk.yellow('[compare] Run `npm run capture` first to generate it.'));
    process.exit(1);
  }

  const collection: CapturedRequest[] = JSON.parse(fs.readFileSync(opts.collection, 'utf-8'));
  console.log(chalk.blue(`[compare] Loaded ${collection.length} request(s) from collection.`));
  console.log(chalk.blue(`[compare] Original base URL: ${config.appBaseUrl}`));
  console.log(chalk.blue(`[compare] New base URL:      ${newBase}\n`));

  const report: ReportEntry[] = [];

  for (const entry of collection) {
    const originalBase = extractBase(entry.url);
    const newUrl = swapBase(entry.url, originalBase, newBase);

    console.log(chalk.gray(`[${entry.id}] ${entry.method} ${entry.url}`));

    let newStatus: number | null = null;
    let newBody: unknown = null;
    let error: string | undefined;

    try {
      const result = await replayRequest(entry.method, newUrl, entry.headers, entry.postData);
      newStatus = result.status;
      newBody = result.body;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`     Error: ${error}`));
    }

    const originalBody = entry.response?.body ?? null;
    const originalStatus = entry.response?.status ?? null;
    const diffResult = compareResponses(originalBody, newBody);
    const statusMatch = originalStatus === newStatus;

    if (diffResult.hasDiff || !statusMatch) {
      console.log(chalk.yellow(`     Status: ${originalStatus} → ${newStatus} | ${diffResult.totalChanges} diff(s)`));
    } else {
      console.log(chalk.green(`     Identical (status ${newStatus})`));
    }

    report.push({
      id: entry.id,
      method: entry.method,
      originalUrl: entry.url,
      newUrl,
      originalStatus,
      newStatus,
      statusMatch,
      diff: diffResult,
      error,
    });
  }

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_HTML, renderHtml(report));

  const withDiffs = report.filter((r) => r.diff.hasDiff || !r.statusMatch).length;
  console.log(`\n${chalk.green('[compare] Done!')}`);
  console.log(`  ${chalk.cyan('JSON report:')} ${REPORT_JSON}`);
  console.log(`  ${chalk.cyan('HTML report:')} ${REPORT_HTML}`);
  console.log(`  ${chalk.cyan('Total:')} ${report.length} | ${chalk.green('Identical:')} ${report.length - withDiffs} | ${chalk.red('Diffs:')} ${withDiffs}`);
}

run().catch((err) => {
  console.error(chalk.red('[compare] Fatal error:'), err);
  process.exit(1);
});
