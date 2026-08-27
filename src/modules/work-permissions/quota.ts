import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export const MONTHLY_QUOTA_MINUTES = 120;
export const PERMISSION_MINUTES = 60;
export const MAX_USES_PER_MONTH = 2;
export const PERMISSION_SLOTS = ['START', 'END'] as const;

export type PermissionSlot = (typeof PERMISSION_SLOTS)[number];
export type PermissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export function isPermissionSlot(value: string): value is PermissionSlot {
  return (PERMISSION_SLOTS as readonly string[]).includes(value);
}

export function monthOf(isoDate: string): { start: string; end: string; key: string; label: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.slice(0, 10));
  if (!match) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a valid date.', 400);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = `${match[1]}-${match[2]}-01`;
  const end = `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return { start, end, key: `${match[1]}-${match[2]}`, label };
}

export function countsTowardQuota(status: string): boolean {
  return status === 'PENDING' || status === 'APPROVED';
}

export function quotaUsed(rows: { minutes: number; status: string }[]): number {
  return rows.reduce((sum, row) => (countsTowardQuota(row.status) ? sum + row.minutes : sum), 0);
}

export function quotaUses(rows: { status: string }[]): number {
  return rows.reduce((sum, row) => (countsTowardQuota(row.status) ? sum + 1 : sum), 0);
}

export function remainingMinutes(used: number): number {
  return Math.max(0, MONTHLY_QUOTA_MINUTES - used);
}

export function remainingLabel(remaining: number, monthLabel: string): string {
  return `${remaining}m left in ${monthLabel}`;
}

export function slotLabel(slot: PermissionSlot): string {
  return slot === 'END' ? 'end of shift' : 'start of shift';
}

export function assertApplyAllowed(input: {
  minutes: number;
  usedMinutes: number;
  usedCount: number;
  hasOpenOnDate: boolean;
  slot: string;
  monthLabel: string;
}): void {
  if (!isPermissionSlot(input.slot)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose start of shift or end of shift.', 400);
  }
  if (input.minutes !== PERMISSION_MINUTES) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Permission is 1 hour per day.', 400);
  }
  if (input.hasOpenOnDate) {
    throw new AppError(API_ERROR_CODES.CONFLICT, 'You already have a permission request on this date.', 409);
  }
  if (input.usedCount >= MAX_USES_PER_MONTH || input.usedMinutes + input.minutes > MONTHLY_QUOTA_MINUTES) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `You can use 1 hour on 2 days in ${input.monthLabel}.`,
      400,
    );
  }
}
