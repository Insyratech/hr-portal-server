import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { hitRateLimit } from '../../shared/rate-limit';
import {
  buildPasswordResetLink,
  PASSWORD_RESET_EMAIL_MAX,
  PASSWORD_RESET_EMAIL_WINDOW_MS,
  resetPasswordResetRateLimits,
  resolvePasswordResetRedirect,
} from './password-reset';

describe('resolvePasswordResetRedirect', () => {
  it('points to the reset-password page', () => {
    expect(resolvePasswordResetRedirect()).toMatch(/\/reset-password$/);
  });
});

describe('buildPasswordResetLink', () => {
  it('builds a portal URL with token_hash and type=recovery', () => {
    const link = buildPasswordResetLink(
      'https://hr-portal-client-nine.vercel.app/reset-password',
      'abc123token',
    );
    const url = new URL(link);
    expect(url.origin).toBe('https://hr-portal-client-nine.vercel.app');
    expect(url.pathname).toBe('/reset-password');
    expect(url.searchParams.get('token_hash')).toBe('abc123token');
    expect(url.searchParams.get('type')).toBe('recovery');
    expect(link).not.toContain('supabase.co');
  });
});

describe('password reset rate limits', () => {
  it('allows five requests per email in the window', () => {
    resetPasswordResetRateLimits();
    const store = new Map();
    const now = 1_000;
    for (let i = 0; i < PASSWORD_RESET_EMAIL_MAX; i += 1) {
      hitRateLimit(store, 'user@example.com', now, PASSWORD_RESET_EMAIL_WINDOW_MS, PASSWORD_RESET_EMAIL_MAX);
    }
    try {
      hitRateLimit(store, 'user@example.com', now, PASSWORD_RESET_EMAIL_WINDOW_MS, PASSWORD_RESET_EMAIL_MAX);
      throw new Error('expected limit');
    } catch (error) {
      expect(error).toMatchObject({ code: API_ERROR_CODES.RATE_LIMITED, statusCode: 429 });
    }
  });
});
