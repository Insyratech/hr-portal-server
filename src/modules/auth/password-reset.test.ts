import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { hitRateLimit } from '../../shared/rate-limit';
import {
  PASSWORD_RESET_EMAIL_MAX,
  PASSWORD_RESET_EMAIL_WINDOW_MS,
  resetPasswordResetRateLimits,
  resolvePasswordResetRedirect,
  rewriteRecoveryActionLink,
} from './password-reset';

describe('resolvePasswordResetRedirect', () => {
  it('points to the reset-password page', () => {
    expect(resolvePasswordResetRedirect()).toMatch(/\/reset-password$/);
  });
});

describe('rewriteRecoveryActionLink', () => {
  it('replaces redirect_to in the Supabase verify URL', () => {
    const actionLink =
      'https://example.supabase.co/auth/v1/verify?token=abc&type=recovery&redirect_to=http://localhost:3000';
    const rewritten = rewriteRecoveryActionLink(
      actionLink,
      'https://hr-portal-client-nine.vercel.app/reset-password',
    );
    const url = new URL(rewritten);
    expect(url.searchParams.get('redirect_to')).toBe('https://hr-portal-client-nine.vercel.app/reset-password');
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
