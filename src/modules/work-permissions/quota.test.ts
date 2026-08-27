import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import {
  assertApplyAllowed,
  monthOf,
  quotaUsed,
  quotaUses,
  remainingLabel,
  remainingMinutes,
} from './quota';

type Row = { date: string; minutes: number; status: 'PENDING' | 'APPROVED' | 'REJECTED' };

function tryApply(items: Row[], date: string, minutes = 60, slot = 'START'): AppError | null {
  const month = monthOf(date);
  const inMonth = items.filter((row) => row.date >= month.start && row.date <= month.end);
  const used = quotaUsed(inMonth);
  const usedCount = quotaUses(inMonth);
  const hasOpenOnDate = items.some(
    (row) => row.date === date && (row.status === 'PENDING' || row.status === 'APPROVED'),
  );
  try {
    assertApplyAllowed({
      minutes,
      usedMinutes: used,
      usedCount,
      hasOpenOnDate,
      slot,
      monthLabel: month.label,
    });
    items.push({ date, minutes, status: 'PENDING' });
    return null;
  } catch (error) {
    return error as AppError;
  }
}

describe('work permission quota', () => {
  it('allows two 1h requests in one month and rejects a third', () => {
    const items: Row[] = [];
    expect(tryApply(items, '2026-08-03')).toBeNull();
    items[0].status = 'APPROVED';
    expect(tryApply(items, '2026-08-10')).toBeNull();
    items[1].status = 'APPROVED';
    const third = tryApply(items, '2026-08-17');
    expect(third?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(third?.message).toMatch(/2 days in August/);
  });

  it('rejects 2 hours in one request', () => {
    const error = tryApply([], '2026-08-10', 120);
    expect(error?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(error?.message).toBe('Permission is 1 hour per day.');
  });

  it('counts pending minutes against the quota', () => {
    const items: Row[] = [{ date: '2026-08-03', minutes: 60, status: 'PENDING' }];
    expect(quotaUsed(items)).toBe(60);
    expect(remainingMinutes(60)).toBe(60);
    expect(remainingLabel(60, 'August')).toBe('60m left in August');
    expect(tryApply(items, '2026-08-10')).toBeNull();
    expect(tryApply(items, '2026-08-17')?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
  });

  it('frees rejected minutes so a later request can succeed', () => {
    const items: Row[] = [{ date: '2026-08-03', minutes: 60, status: 'REJECTED' }];
    expect(quotaUsed(items)).toBe(0);
    expect(tryApply(items, '2026-08-10')).toBeNull();
  });

  it('rejects a second open request on the same date', () => {
    const items: Row[] = [{ date: '2026-08-03', minutes: 60, status: 'PENDING' }];
    expect(tryApply(items, '2026-08-03')?.code).toBe(API_ERROR_CODES.CONFLICT);
  });

  it('requires start or end of shift', () => {
    const error = tryApply([], '2026-08-03', 60, 'MIDDLE');
    expect(error?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(error?.message).toMatch(/start of shift or end of shift/);
  });
});
