import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from './constants/error-codes';
import { hitRateLimit } from './rate-limit';

describe('hitRateLimit', () => {
  it('allows up to the max hits then rejects', () => {
    const store = new Map();
    const now = 1_000;
    for (let i = 0; i < 10; i += 1) {
      expect(hitRateLimit(store, 'hr-1', now, 60_000, 10).count).toBe(i + 1);
    }
    try {
      hitRateLimit(store, 'hr-1', now, 60_000, 10);
      throw new Error('expected rate limit');
    } catch (error) {
      expect(error).toMatchObject({ code: API_ERROR_CODES.RATE_LIMITED, statusCode: 429 });
    }
  });

  it('resets after the window', () => {
    const store = new Map();
    hitRateLimit(store, 'hr-1', 1_000, 60_000, 1);
    expect(hitRateLimit(store, 'hr-1', 61_000, 60_000, 1).count).toBe(1);
  });
});
