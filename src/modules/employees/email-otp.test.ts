import { describe, expect, it, beforeEach } from 'vitest';
import {
  confirmWorkEmailOtp,
  consumeWorkEmailVerification,
  issueWorkEmailOtp,
  resetWorkEmailOtpStore,
} from './email-otp';

describe('work email otp', () => {
  beforeEach(() => {
    resetWorkEmailOtpStore();
  });

  it('confirms a 4-digit code and then consumes the token', () => {
    const previous = process.env.VITEST;
    delete process.env.VITEST;
    const code = issueWorkEmailOtp('actor-1', '  New@Example.com ');
    expect(code).toMatch(/^\d{4}$/);
    const token = confirmWorkEmailOtp('actor-1', 'new@example.com', code);
    consumeWorkEmailVerification('actor-1', 'new@example.com', token);
    expect(() => consumeWorkEmailVerification('actor-1', 'new@example.com', token)).toThrow();
    process.env.VITEST = previous;
  });

  it('rejects a wrong code', () => {
    issueWorkEmailOtp('actor-1', 'a@b.co');
    expect(() => confirmWorkEmailOtp('actor-1', 'a@b.co', '0000')).toThrow('That code is not correct.');
  });
});
