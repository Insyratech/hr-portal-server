import { loadEnv } from '../config/env';

/** Public HR Portal origin used in emails and auth redirects (no trailing slash). */
export function portalPublicBase(): string {
  const env = loadEnv();
  if (env.PORTAL_PUBLIC_URL) {
    return env.PORTAL_PUBLIC_URL.replace(/\/$/, '');
  }
  return env.CORS_ORIGIN.replace(/\/$/, '');
}

export function portalPublicUrl(path = '/login'): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${portalPublicBase()}${suffix}`;
}
