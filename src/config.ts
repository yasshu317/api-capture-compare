import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}\nCheck your .env file (see .env.example).`);
  }
  return value;
}

function optional_env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const config = {
  appBaseUrl:  require_env('APP_BASE_URL').replace(/\/$/, ''),
  targetPath:  optional_env('TARGET_PATH', '/') as string,
  loginPath:   optional_env('LOGIN_PATH', '/login') as string,
  newBaseUrl:  optional_env('NEW_BASE_URL'),

  get targetUrl(): string {
    return this.appBaseUrl + this.targetPath;
  },

  get loginUrl(): string {
    return this.appBaseUrl + this.loginPath;
  },
};
