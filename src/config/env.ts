import 'dotenv/config';

export type Env = {
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  CORS_ORIGIN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  /** Shared secret for Supabase Cron → HTTP job routes (`x-cron-secret`). */
  CRON_SECRET: string;
  BREVO_API_KEY: string;
  BREVO_SENDER_EMAIL: string;
  BREVO_SENDER_NAME: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
};

function readHost(source: NodeJS.ProcessEnv): string {
  if (source.RENDER) {
    return '0.0.0.0';
  }
  return source.HOST ?? '127.0.0.1';
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
  return {
    NODE_ENV: source.NODE_ENV ?? 'development',
    PORT: readPort(source.PORT, 3001),
    HOST: readHost(source),
    CORS_ORIGIN: source.CORS_ORIGIN ?? 'http://localhost:3000',
    SUPABASE_URL: source.SUPABASE_URL ?? '',
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY ?? '',
    SUPABASE_JWT_SECRET: source.SUPABASE_JWT_SECRET ?? '',
    CRON_SECRET: source.CRON_SECRET ?? '',
    BREVO_API_KEY: source.BREVO_API_KEY ?? '',
    BREVO_SENDER_EMAIL: source.BREVO_SENDER_EMAIL ?? '',
    BREVO_SENDER_NAME: source.BREVO_SENDER_NAME ?? 'HR Portal',
    VAPID_PUBLIC_KEY: source.VAPID_PUBLIC_KEY ?? '',
    VAPID_PRIVATE_KEY: source.VAPID_PRIVATE_KEY ?? '',
    VAPID_SUBJECT: source.VAPID_SUBJECT ?? '',
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
