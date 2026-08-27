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

function truncateTime(value: string): string {
  return value.slice(0, 5);
}

export function todayIso(now = new Date()): string {
  return formatIsoDate(now);
}
