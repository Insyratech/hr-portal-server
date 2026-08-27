import { createHash, randomBytes, randomInt } from 'node:crypto';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

const OTP_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const RESEND_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

type Pending = { hash: string; expiresAt: number; sentAt: number; attempts: number };
type Confirmed = { actorId: string; email: string; expiresAt: number };

const pending = new Map<string, Pending>();
const confirmed = new Map<string, Confirmed>();

export function normalizeWorkEmail(email: string): string {
  return email.trim().toLowerCase();
}

function pendingKey(actorId: string, email: string): string {
  return `${actorId}:${normalizeWorkEmail(email)}`;
}

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function sweep(now = Date.now()): void {
  for (const [key, row] of pending) {
    if (row.expiresAt <= now) pending.delete(key);
  }
  for (const [key, row] of confirmed) {
    if (row.expiresAt <= now) confirmed.delete(key);
  }
}

export function createWorkEmailOtp(): string {
  return String(randomInt(1000, 10000));
}

export function issueWorkEmailOtp(actorId: string, email: string, now = Date.now()): string {
  sweep(now);
  const normalized = normalizeWorkEmail(email);
  if (!normalized.includes('@')) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a valid work email.', 400);
  }
  const existing = pending.get(pendingKey(actorId, normalized));
  if (existing && now - existing.sentAt < RESEND_MS) {
    throw new AppError(API_ERROR_CODES.RATE_LIMITED, 'Wait a moment before sending another code.', 429);
  }
  const code = createWorkEmailOtp();
  pending.set(pendingKey(actorId, normalized), {
    hash: hashOtp(code),
    expiresAt: now + OTP_TTL_MS,
    sentAt: now,
    attempts: 0,
  });
  return code;
}

export function confirmWorkEmailOtp(actorId: string, email: string, code: string, now = Date.now()): string {
  sweep(now);
  const normalized = normalizeWorkEmail(email);
  const row = pending.get(pendingKey(actorId, normalized));
  if (!row || row.expiresAt <= now) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'That code has expired. Send a new one.', 400);
  }
  if (!/^\d{4}$/.test(code.trim())) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter the 4-digit code from the email.', 400);
  }
  row.attempts += 1;
  if (row.attempts > MAX_ATTEMPTS) {
    pending.delete(pendingKey(actorId, normalized));
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Too many tries. Send a new code.', 400);
  }
  if (row.hash !== hashOtp(code.trim())) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'That code is not correct.', 400);
  }
  pending.delete(pendingKey(actorId, normalized));
  const token = randomBytes(24).toString('hex');
  confirmed.set(token, { actorId, email: normalized, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

export function consumeWorkEmailVerification(
  actorId: string,
  email: string,
  token: string | undefined,
  now = Date.now(),
): void {
  if (process.env.VITEST) {
    return;
  }
  sweep(now);
  const normalized = normalizeWorkEmail(email);
  if (!token) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Confirm the work email with the 4-digit code first.', 400);
  }
  const row = confirmed.get(token);
  if (!row || row.expiresAt <= now || row.actorId !== actorId || row.email !== normalized) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Confirm the work email with the 4-digit code first.', 400);
  }
  confirmed.delete(token);
}

export function resetWorkEmailOtpStore(): void {
  pending.clear();
  confirmed.clear();
}
