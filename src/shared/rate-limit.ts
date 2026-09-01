import { API_ERROR_CODES } from './constants/error-codes';
import { AppError } from './errors/app-error';

export const UPLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
export const UPLOAD_RATE_MAX = 10;

export type RateWindow = { count: number; resetAt: number };

export function hitRateLimit(
  store: Map<string, RateWindow>,
  key: string,
  now = Date.now(),
  windowMs = UPLOAD_RATE_WINDOW_MS,
  max = UPLOAD_RATE_MAX,
  limitMessage?: string,
): RateWindow {
  const current = store.get(key);
  if (!current || now >= current.resetAt) {
    const next = { count: 1, resetAt: now + windowMs };
    store.set(key, next);
    return next;
  }
  current.count += 1;
  if (current.count > max) {
    throw new AppError(
      API_ERROR_CODES.RATE_LIMITED,
      limitMessage ?? 'Too many requests. Wait a few minutes and try again.',
      429,
    );
  }
  return current;
}
