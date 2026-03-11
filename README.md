# API Capture & Compare

A two-phase CLI tool built with Node.js + Playwright to:
1. **Capture** all API calls fired by interacting with a page (e.g. clicking FILTER)
2. **Compare** those captured calls against a different base URL and report differences

---

## Prerequisites

- Node.js >= 18
- npm >= 9

---

## Setup

```bash
cd api-capture-compare
npm install
npx playwright install chromium
```

---

## Phase 1 — Capture API calls

```bash
npm run capture
```

What happens:
1. A Chrome window opens in **headed** (visible) mode
2. **First run**: the browser navigates to the login page — log in manually, then press **Enter** in the terminal. Your session is saved to `browser-state.json` and reused on future runs.
3. The browser navigates to `https://nitor-timesheet.nitorinfotech.net/timesheet/360`
4. All XHR/fetch calls are intercepted and logged in the terminal
5. Interact with the page (e.g. click the **FILTER** button)
6. Press **Enter** in the terminal when you are done
7. The captured calls are saved to `api-collection.json`

### Sample `api-collection.json`

```json
[
  {
    "id": 1,
    "method": "GET",
    "url": "https://nitor-timesheet.nitorinfotech.net/api/timesheet/filter?year=2024&month=3",
    "headers": { "Authorization": "Bearer eyJ..." },
    "postData": null,
    "response": {
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": { "data": [...] }
    }
  }
]
```

---

## Phase 2 — Compare against a new base URL

```bash
npm run compare -- --newBase https://your-new-base-url.com
```

What happens:
1. Reads `api-collection.json`
2. For every captured request, replaces the original base URL with `--newBase` and replays it (preserving method, headers, and body)
3. Deep-diffs the original response body against the new response body
4. Writes two output files:
   - `diff-report.json` — machine-readable full report
   - `diff-report.html` — human-readable report (open in browser)

### Options

| Flag | Description | Required |
|------|-------------|----------|
| `--newBase` | The new base URL to test against | Yes |
| `--collection` | Path to a custom collection file (default: `api-collection.json`) | No |

### Example

```bash
# Compare against a local dev server
npm run compare -- --newBase http://localhost:8080

# Compare against a staging environment
npm run compare -- --newBase https://staging.nitorinfotech.net

# Use a custom collection file
npm run compare -- --newBase https://staging.nitorinfotech.net --collection ./my-collection.json
```

---

## Output files

| File | Description |
|------|-------------|
| `browser-state.json` | Saved login session (cookies + localStorage) — **do not commit** |
| `api-collection.json` | Captured API calls from Phase 1 — **do not commit** |
| `diff-report.json` | Full diff results in JSON |
| `diff-report.html` | Visual diff report — open in your browser |

---

## Diff report columns

| Column | Description |
|--------|-------------|
| # | Request ID |
| Method | HTTP method (GET, POST, etc.) |
| Original URL | The URL from the captured collection |
| New URL | The replayed URL with the new base |
| Status | Original status → New status |
| Diff | `identical` or `N change(s)` |
| Details | Expandable diff showing added / deleted / edited fields |

---

## Project structure

```
api-capture-compare/
├── src/
│   ├── capture.ts          # Phase 1: intercept and save API calls
│   ├── compare.ts          # Phase 2: replay and diff
│   └── utils/
│       └── diff.ts         # Deep-diff helper
├── api-collection.json     # Generated — not committed
├── browser-state.json      # Generated — not committed
├── diff-report.json        # Generated output
├── diff-report.html        # Generated output
├── package.json
└── tsconfig.json
```
