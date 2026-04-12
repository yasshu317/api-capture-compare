# API Capture & Compare

A single-command tool built with **Node.js + TypeScript + Playwright** that:

1. Opens your app in a browser
2. Auto-detects when you log in (saves your session)
3. Watches for specific API calls as you navigate
4. Simultaneously replays each call against your new API server
5. Compares response structure (nested keys) and record counts
6. Generates a QA-friendly HTML report — press Enter and it's done

No backend required. Works with any web application.

---

## How it works

```
npm run audit
      │
      ▼
Browser opens → login page
      │
      ▼  (auto-detected — no manual step)
You log in → session saved
      │
      ▼
Navigate your app — tool captures matching API calls
For each call → instantly replays against NEW_API_BASE
                compares nested keys + record counts
      │
      ▼
Press Enter in terminal
      │
      ├─→  audit-report.html       (open in browser — QA-friendly)
      ├─→  audit-report.json       (machine-readable full data)
      ├─→  api-calls-log.txt       (human-readable log)
      └─→  audit-runs/<timestamp>/ (previous run archived here)
               └─ responses/
                    ├─ 001_GET_api_v1_offices.json
                    └─ 002_GET_api_v1_tasks.json
```

---

## Prerequisites

- Node.js >= 18
- npm >= 9

---

## Installation

```bash
git clone https://github.com/yasshu317/api-capture-compare.git
cd api-capture-compare
npm install
npx playwright install chromium
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# The web app you log into (browser UI)
UI_URL=https://your-app.example.com
LOGIN_PATH=/login
TARGET_PATH=        # leave blank to navigate manually after login

# New API server to test against
NEW_API_BASE=https://your-new-api.example.com

# Which APIs to capture (comma-separated path fragments)
AUDIT_APIS=api/v1/patients,api/v1/offices,api/v1/tasks
```

`.env` is gitignored — your URLs and credentials are never committed.

---

## Usage

### Run the audit

```bash
npm run audit
```

**Step by step:**

| Step | What happens |
|---|---|
| 1 | Terminal shows config, browser opens |
| 2 | **First run:** login page appears — log in manually |
| 3 | Tool auto-detects login, saves session for next time |
| 4 | Navigate to the pages you want to test |
| 5 | API calls matching `AUDIT_APIS` appear in the terminal as they fire |
| 6 | Each call is instantly replayed against `NEW_API_BASE` |
| 7 | Come back to the terminal and **press Enter** |
| 8 | Report generated — open `audit-report.html` in your browser |

**Subsequent runs** (session already saved):

```
npm run audit  →  browser opens directly on your app, no login needed
```

**Pass a dynamic URL at runtime:**

```bash
npm run audit -- --url "https://your-app.example.com/page?APP_KEY=abc123"
```

**Override which APIs to watch:**

```bash
npm run audit -- --apis "api/v1/payments,api/v1/employees"
```

---

## Output files

| File | Description | Kept in git? |
|---|---|---|
| `audit-report.html` | QA-friendly visual report — open in browser | No |
| `audit-report.json` | Full raw data for all captured calls | No |
| `api-calls-log.txt` | Human-readable log of legacy vs new URLs | No |
| `api-calls-log.json` | Machine-readable calls log | No |
| `audit-runs/<timestamp>/` | **Previous run archive** — auto-created each run | No |
| `audit-runs/<timestamp>/responses/` | Individual response JSON per endpoint | No |
| `browser-state.json` | Saved login session (reused on next run) | No |

### Run archive

Every time you run the audit, the **previous** output files are automatically moved to:

```
audit-runs/
  2026-04-12_14-30-00/
    audit-report.html
    audit-report.json
    api-calls-log.txt
    api-calls-log.json
    responses/
      001_GET_api_v1_offices.json
      002_GET_api_v1_tasks.json
```

Each response file contains the full original and new response bodies side by side — useful for manual inspection or debugging.

---

## What gets compared

### Nested key comparison
Every dot-path key in the JSON response is extracted recursively (up to 10 levels deep):

```
data
data.items
data.items.id
data.items.name
data.items.address
data.items.address.city    ← nested keys detected automatically
meta.pagination.total
```

Missing keys (in old but not in new) are shown in **red**.  
Extra keys (in new but not in old) are shown in **blue**.

### Record count comparison
Priority order — always finds something to compare:

| Priority | Example | What is counted |
|---|---|---|
| 1 | `{ "total": 42 }` | `"total"` field |
| 2 | `{ "data": [...] }` | `"data"` array length |
| 3 | `[...5 items]` | Top-level array length |
| 4 | `{ "id": 1, "name": "..." }` | Number of top-level keys |

---

## Project structure

```
api-capture-compare/
├── src/
│   ├── audit.ts              # Main audit command
│   ├── capture.ts            # Legacy capture command
│   ├── compare.ts            # Legacy compare command
│   ├── config.ts             # .env loader
│   └── utils/
│       ├── audit-diff.ts     # Nested key + count comparison
│       └── diff.ts           # Deep diff (used by compare.ts)
├── audit-runs/               # Auto-created — archived runs (gitignored)
├── .env.example              # Config template
├── .gitignore
├── package.json
├── tsconfig.json
├── QA-GUIDE.html             # Non-technical guide for QA testers
└── README.md
```

---

## Tech stack

| Library | Purpose |
|---|---|
| [Playwright](https://playwright.dev/) | Browser automation + network interception |
| [commander](https://github.com/tj/commander.js) | CLI argument parsing |
| [chalk](https://github.com/chalk/chalk) | Colored terminal output |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` file loading |
| TypeScript + ts-node | Type-safe runtime |

---

## FAQ

**Do I need to log in every time?**  
No. After the first run your session is saved to `browser-state.json` and reused automatically.

**How do I reset the session?**  
Delete `browser-state.json` and run `npm run audit` again.

**My URL has a dynamic key (e.g. `?APP_KEY=abc`). How do I handle that?**  
Leave `TARGET_PATH` blank in `.env` and pass the full URL at runtime:
```bash
npm run audit -- --url "https://your-app.com/page?APP_KEY=abc123"
```

**Will pagination calls create duplicate entries in the report?**  
No. Calls to the same endpoint path (e.g. `/api/patients`) are deduplicated — only the first call per unique path appears in the report. All calls are still saved to `audit-report.json`.

**Where do I find previous run data?**  
In `audit-runs/<timestamp>/` — a new folder is created each time you run the audit.

**Can I compare without re-capturing?**  
Use the legacy `npm run compare` command with a saved `api-collection.json`.
