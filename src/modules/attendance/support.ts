import { formatIsoDate } from '../leave/day-count';
import type { ShiftDefinition } from './types';

export type ShiftRow = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  minimum_duration_minutes: number;
  grace_period_minutes: number;
  late_threshold_minutes: number;
  early_exit_threshold_minutes: number;
  flexible: boolean;
  active: boolean;
};

export function mapShift(row: ShiftRow) {
  return {
    id: row.id,
    name: row.name,
    startTime: truncateTime(row.start_time),
    endTime: truncateTime(row.end_time),
    minimumDurationMinutes: row.minimum_duration_minutes,
    gracePeriodMinutes: row.grace_period_minutes,
    lateThresholdMinutes: row.late_threshold_minutes,
    earlyExitThresholdMinutes: row.early_exit_threshold_minutes,
    flexible: row.flexible,
    active: row.active,
  };
}

export function toShiftDefinition(row: ShiftRow): ShiftDefinition {
  return {
    startTime: truncateTime(row.start_time),
    endTime: truncateTime(row.end_time),
    minimumDurationMinutes: row.minimum_duration_minutes,
    gracePeriodMinutes: row.grace_period_minutes,
    lateThresholdMinutes: row.late_threshold_minutes,
    earlyExitThresholdMinutes: row.early_exit_threshold_minutes,
    flexible: row.flexible,
  };
}

export function truncateTime(value: string): string {
  return value.slice(0, 5);
}

/** Stored for flexible shifts — no fixed in/out window; attendance uses worked hours only. */
export const FLEXIBLE_SHIFT_START = '00:00';
export const FLEXIBLE_SHIFT_END = '23:59';

export function normalizeFlexibleShiftFields<T extends {
  startTime?: string;
  endTime?: string;
  gracePeriodMinutes?: number;
  lateThresholdMinutes?: number;
  earlyExitThresholdMinutes?: number;
  flexible?: boolean;
}>(input: T): T {
  if (!input.flexible) return input;
  return {
    ...input,
    startTime: FLEXIBLE_SHIFT_START,
    endTime: FLEXIBLE_SHIFT_END,
    gracePeriodMinutes: 0,
    lateThresholdMinutes: 0,
    earlyExitThresholdMinutes: 0,
  };
}

export function todayIso(now = new Date()): string {
  return formatIsoDate(now);
}
