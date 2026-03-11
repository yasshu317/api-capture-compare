import { chromium, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { config } from './config';

const STATE_FILE = path.resolve(__dirname, '..', 'browser-state.json');
const COLLECTION_FILE = path.resolve(__dirname, '..', 'api-collection.json');

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

function isApiCall(url: string): boolean {
  return (
    url.includes('/api/') ||
    url.includes('/graphql') ||
    url.includes('/rest/') ||
    (url.startsWith('http') &&
      !url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)(\?|$)/))
  );
}

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function saveState(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n[capture] Browser state saved to ${STATE_FILE}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ headless: false });

  let context: BrowserContext;
  const stateExists = fs.existsSync(STATE_FILE);

  if (stateExists) {
    console.log('[capture] Loading saved browser state (skip login)...');
    context = await browser.newContext({ storageState: STATE_FILE });
  } else {
    console.log('[capture] No saved state found. A browser window will open.');
    console.log('[capture] Please log in manually, then press Enter in this terminal.');
    context = await browser.newContext();
  }

  const page = await context.newPage();

  if (!stateExists) {
    await page.goto(config.loginUrl);
    await waitForEnter('\n[capture] Press Enter after you have logged in... ');
    await saveState(context);
  }

  console.log(`\n[capture] Navigating to ${config.targetUrl}`);
  await page.goto(config.targetUrl, { waitUntil: 'networkidle' });

  const captured: CapturedRequest[] = [];
  let idCounter = 1;
  const pendingRequests = new Map<
    string,
    { id: number; method: string; url: string; headers: Record<string, string>; postData: string | null }
  >();

  page.on('request', (request) => {
    if (!isApiCall(request.url())) return;

    const id = idCounter++;
    const entry = {
      id,
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    };
    pendingRequests.set(request.url() + '|' + id, entry);
    console.log(`  [→] ${request.method()} ${request.url()}`);
  });

  page.on('response', async (response) => {
    const key = [...pendingRequests.keys()].find((k) => k.startsWith(response.url() + '|'));
    if (!key) return;

    const req = pendingRequests.get(key)!;
    pendingRequests.delete(key);

    let body: unknown = null;
    try {
      const contentType = response.headers()['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch {
      body = null;
    }

    captured.push({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: req.headers,
      postData: req.postData,
      response: {
        status: response.status(),
        headers: response.headers(),
        body,
      },
    });

    console.log(`  [←] ${response.status()} ${response.url()}`);
  });

  console.log('\n[capture] Listening for API calls...');
  console.log('[capture] Now interact with the page (e.g. click FILTER).');
  await waitForEnter('[capture] Press Enter when done to save the collection... ');

  // Flush any pending responses
  await page.waitForTimeout(1000);

  if (captured.length === 0) {
    console.log('\n[capture] No API calls were captured. Exiting.');
  } else {
    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(captured, null, 2));
    console.log(`\n[capture] Captured ${captured.length} API call(s) → ${COLLECTION_FILE}`);
  }

  await browser.close();
}

run().catch((err) => {
  console.error('[capture] Fatal error:', err);
  process.exit(1);
});
