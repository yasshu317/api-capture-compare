import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function require_env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(
    `Missing required environment variable: ${names[0]}\nCheck your .env file (see .env.example).`
  );
}

function optional_env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

function parse_audit_apis(): string[] {
  const raw = process.env['AUDIT_APIS'] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // The web app (UI) URL — used only for login and page navigation
  // Accepts either UI_URL (new) or APP_BASE_URL (old) variable name
  uiUrl:       require_env('UI_URL', 'APP_BASE_URL').replace(/\/$/, ''),

  // Path to the login page (relative to UI_URL)
  loginPath:   optional_env('LOGIN_PATH', '/login') as string,

  // Path to navigate to after login (relative to UI_URL)
  // For dynamic keys pass --url at runtime instead
  targetPath:  optional_env('TARGET_PATH', '/') as string,

  // The NEW API server host to replay captured calls against
  // This replaces the host of every captured API call
  // e.g. https://old-api.company.com → https://new-api.company.com
  newApiBase:  optional_env('NEW_API_BASE'),

  // Comma-separated API path patterns to watch in audit mode
  // e.g. AUDIT_APIS=/api/paycheck,/api/employees
  auditApis:   parse_audit_apis(),

  // Back-compat: also accept old variable names
  get appBaseUrl(): string { return this.uiUrl; },
  get newBaseUrl(): string | undefined { return this.newApiBase ?? optional_env('NEW_BASE_URL'); },

  get targetUrl(): string {
    return this.uiUrl + this.targetPath;
  },

  get loginUrl(): string {
    return this.uiUrl + this.loginPath;
  },
};
