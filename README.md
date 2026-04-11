# API Capture & Compare

A two-phase CLI tool built with **Node.js + TypeScript + Playwright** that:

1. **Captures** all API/XHR/fetch calls made by a web page while you interact with it
2. **Compares** those captured calls against a different base URL (e.g. staging, local dev) and produces a visual diff report

No backend required. Works with any web application regardless of framework.

---

## How it works

```
Phase 1 — Capture                         Phase 2 — Compare
─────────────────────────────────          ─────────────────────────────────
npm run capture                            npm run compare -- --newBase <url>
       │                                          │
       ▼                                          ▼
Opens Chrome (headed)                   Reads api-collection.json
       │                                          │
       ▼                                          ▼
You log in + interact               Replays each request against new base URL
(e.g. click FILTER)                               │
       │                                          ▼
       ▼                                  Deep-diffs responses
Saves api-collection.json                         │
                                                  ▼
                                    diff-report.html + diff-report.json
```

---

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9

---

## Installation

```bash
git clone <your-repo-url>
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
# Base URL of the app you want to capture from
APP_BASE_URL=https://your-app.com

# Page to navigate to after login
TARGET_PATH=/your/target/page

# Login page path
LOGIN_PATH=/login

# (Optional) Set this if you always compare against the same URL
# NEW_BASE_URL=https://staging.your-app.com
```

> `.env` is gitignored — your URLs and credentials never get committed.

---

## Usage

### Phase 1 — Capture

```bash
npm run capture
```

**What happens step by step:**

| Step | What you see / do |
|------|-------------------|
| 1 | Chrome opens in headed (visible) mode |
| 2 | **First run only**: login page opens — log in manually |
| 3 | Press **Enter** in the terminal — session is saved to `browser-state.json` |
| 4 | Browser navigates to your `TARGET_PATH` |
| 5 | API calls are printed in the terminal as they fire |
| 6 | Interact with the page (click buttons, apply filters, etc.) |
| 7 | Press **Enter** in the terminal when done |
| 8 | `api-collection.json` is saved with all captured requests + responses |

> On subsequent runs, the saved session is reused automatically — no need to log in again.

---

### Phase 2 — Compare

```bash
# Pass the new base URL via flag
npm run compare -- --newBase https://staging.your-app.com

# Or set NEW_BASE_URL in .env and just run
npm run compare
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--newBase` | New base URL to replay requests against | `NEW_BASE_URL` from `.env` |
| `--collection` | Path to a custom collection file | `api-collection.json` |

**Examples:**

```bash
# Local dev server
npm run compare -- --newBase http://localhost:3000

# Staging environment
npm run compare -- --newBase https://staging.your-app.com

# Custom collection file
npm run compare -- --newBase https://staging.your-app.com --collection ./my-collection.json
```

After it runs, open the HTML report in your browser:

```bash
open diff-report.html
```

---

## Output

| File | Description | Committed? |
|------|-------------|------------|
| `api-collection.json` | Captured requests + responses from Phase 1 | No |
| `browser-state.json` | Saved login session (cookies + localStorage) | No |
| `diff-report.json` | Full diff results — machine readable | No |
| `diff-report.html` | Visual diff report — open in browser | No |

### HTML Report columns

| Column | Description |
|--------|-------------|
| # | Request ID |
| Method | HTTP method (GET, POST, etc.) |
| Original URL | URL from the captured collection |
| New URL | Replayed URL with the new base |
| Status | Original status → New status |
| Diff | `identical` or `N change(s)` |
| Details | Expandable view of added / deleted / edited fields |

---

## Project structure

```
api-capture-compare/
├── src/
│   ├── capture.ts        # Phase 1: Playwright interception + session management
│   ├── compare.ts        # Phase 2: request replay + diff report generation
│   ├── config.ts         # Loads .env, exposes typed config object
│   └── utils/
│       └── diff.ts       # Deep-diff helper (wraps deep-diff library)
├── .env.example          # Config template — copy to .env and fill in
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tech stack

| Library | Purpose |
|---------|---------|
| [Playwright](https://playwright.dev) | Browser automation + network interception |
| [deep-diff](https://github.com/flitbit/diff) | Recursive JSON comparison |
| [commander](https://github.com/tj/commander.js) | CLI argument parsing |
| [chalk](https://github.com/chalk/chalk) | Colored terminal output |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` file loading |
| TypeScript + ts-node | Type-safe runtime |

---

## FAQ

**Q: Do I need to log in every time?**
No. After the first run, your session is saved to `browser-state.json` and reused automatically.

**Q: How do I reset the session?**
Delete `browser-state.json` and run `npm run capture` again.

**Q: Can I capture calls from multiple pages?**
Yes — after the browser opens, navigate to as many pages as you like before pressing Enter.

**Q: What request types are captured?**
All XHR and fetch calls. Static assets (JS, CSS, images, fonts) are automatically filtered out.

**Q: Can I compare without re-capturing?**
Yes — `api-collection.json` persists between runs. You can run Phase 2 multiple times against different base URLs using the same collection.

---

## License

MIT
