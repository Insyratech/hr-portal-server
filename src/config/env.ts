import 'dotenv/config';

export type Env = {
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  CORS_ORIGIN: string;
  /** Public web app URL for emails and password-reset links (e.g. https://your-app.vercel.app). */
  PORTAL_PUBLIC_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  /** Shared secret for Supabase Cron → HTTP job routes (`x-cron-secret`). */
  CRON_SECRET: string;
  /** Run work reminder jobs from inside the API process. Disable when an external cron owns them. */
  WORK_CRON_ENABLED: boolean;
  BREVO_API_KEY: string;
  BREVO_SENDER_EMAIL: string;
  BREVO_SENDER_NAME: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  /** Finance GSP: sandbox (default) never calls IRP; live requires licensed GSP credentials. */
  FINANCE_GSP_MODE: 'sandbox' | 'live';
  FINANCE_GSP_BASE_URL: string;
  FINANCE_GSP_CLIENT_ID: string;
  FINANCE_GSP_CLIENT_SECRET: string;
  FINANCE_GSP_GSTIN: string;
  /** Optional gstinapi.in (or compatible) key for live GSTIN name/address enrichment. */
  FINANCE_GSTIN_LOOKUP_API_KEY: string;
  /** Override base URL; default https://www.gstinapi.in */
  FINANCE_GSTIN_LOOKUP_API_URL: string;
  FINANCE_PAYMENT_GATEWAY_PROVIDER: 'none' | 'razorpay' | 'stripe';
  FINANCE_PAYMENT_GATEWAY_KEY_ID: string;
  FINANCE_PAYMENT_GATEWAY_KEY_SECRET: string;
  FINANCE_BANK_FEED_PROVIDER: 'none' | 'account_aggregator' | 'manual_api';
  FINANCE_BANK_FEED_API_KEY: string;
};

function readHost(source: NodeJS.ProcessEnv): string {
  if (source.RENDER) {
    return '0.0.0.0';
  }
  return source.HOST ?? '127.0.0.1';
}

/** Opt-out flag: anything other than an explicit "false"/"0" keeps the default on. */
function readFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no');
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PORT must be a positive integer, received: ${value}`);
  }

  return parsed;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const gspModeRaw = (source.FINANCE_GSP_MODE ?? 'sandbox').trim().toLowerCase();
  const gspMode: Env['FINANCE_GSP_MODE'] = gspModeRaw === 'live' ? 'live' : 'sandbox';
  const payProviderRaw = (source.FINANCE_PAYMENT_GATEWAY_PROVIDER ?? 'none').trim().toLowerCase();
  const payProvider: Env['FINANCE_PAYMENT_GATEWAY_PROVIDER'] =
    payProviderRaw === 'razorpay' || payProviderRaw === 'stripe' ? payProviderRaw : 'none';
  const bankFeedRaw = (source.FINANCE_BANK_FEED_PROVIDER ?? 'none').trim().toLowerCase();
  const bankFeed: Env['FINANCE_BANK_FEED_PROVIDER'] =
    bankFeedRaw === 'account_aggregator' || bankFeedRaw === 'manual_api' ? bankFeedRaw : 'none';

  return {
    NODE_ENV: source.NODE_ENV ?? 'development',
    PORT: readPort(source.PORT, 3001),
    HOST: readHost(source),
    CORS_ORIGIN: source.CORS_ORIGIN ?? 'http://localhost:3000',
    PORTAL_PUBLIC_URL: source.PORTAL_PUBLIC_URL ?? '',
    SUPABASE_URL: source.SUPABASE_URL ?? '',
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY ?? '',
    SUPABASE_JWT_SECRET: source.SUPABASE_JWT_SECRET ?? '',
    CRON_SECRET: source.CRON_SECRET ?? '',
    WORK_CRON_ENABLED: readFlag(source.WORK_CRON_ENABLED, true),
    BREVO_API_KEY: source.BREVO_API_KEY ?? '',
    BREVO_SENDER_EMAIL: source.BREVO_SENDER_EMAIL ?? '',
    BREVO_SENDER_NAME: source.BREVO_SENDER_NAME ?? 'HR Portal',
    VAPID_PUBLIC_KEY: source.VAPID_PUBLIC_KEY ?? '',
    VAPID_PRIVATE_KEY: source.VAPID_PRIVATE_KEY ?? '',
    VAPID_SUBJECT: source.VAPID_SUBJECT ?? '',
    FINANCE_GSP_MODE: gspMode,
    FINANCE_GSP_BASE_URL: source.FINANCE_GSP_BASE_URL ?? '',
    FINANCE_GSP_CLIENT_ID: source.FINANCE_GSP_CLIENT_ID ?? '',
    FINANCE_GSP_CLIENT_SECRET: source.FINANCE_GSP_CLIENT_SECRET ?? '',
    FINANCE_GSP_GSTIN: source.FINANCE_GSP_GSTIN ?? '',
    FINANCE_GSTIN_LOOKUP_API_KEY: source.FINANCE_GSTIN_LOOKUP_API_KEY ?? '',
    FINANCE_GSTIN_LOOKUP_API_URL: source.FINANCE_GSTIN_LOOKUP_API_URL ?? '',
    FINANCE_PAYMENT_GATEWAY_PROVIDER: payProvider,
    FINANCE_PAYMENT_GATEWAY_KEY_ID: source.FINANCE_PAYMENT_GATEWAY_KEY_ID ?? '',
    FINANCE_PAYMENT_GATEWAY_KEY_SECRET: source.FINANCE_PAYMENT_GATEWAY_KEY_SECRET ?? '',
    FINANCE_BANK_FEED_PROVIDER: bankFeed,
    FINANCE_BANK_FEED_API_KEY: source.FINANCE_BANK_FEED_API_KEY ?? '',
  };
}

export function isSupabaseConfigured(env: Env): boolean {
  return env.SUPABASE_URL.length > 0 && env.SUPABASE_SERVICE_ROLE_KEY.length > 0;
}

export function isAuthConfigured(env: Env): boolean {
  return isSupabaseConfigured(env) && env.SUPABASE_JWT_SECRET.length > 0;
}

export function isWebPushConfigured(env: Env): boolean {
  return (
    env.VAPID_PUBLIC_KEY.length > 0 &&
    env.VAPID_PRIVATE_KEY.length > 0 &&
    env.VAPID_SUBJECT.length > 0
  );
}
