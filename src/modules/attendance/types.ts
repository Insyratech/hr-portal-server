import type { WeekPattern } from '../leave/day-count';

/** Day outcome from the rule engine. MISSING_PUNCH is a flag only — HR chooses LOP in payroll Phase 5; never auto half-day. */
export type AttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'LATE'
  | 'HALF_DAY'
  | 'LEAVE'
  | 'HOLIDAY'
  | 'WEEK_OFF'
  | 'MISSING_PUNCH'
  | 'NO_SHIFT';

export type ShiftDefinition = {
  startTime: string;
  endTime: string;
  minimumDurationMinutes: number;
  gracePeriodMinutes: number;
  lateThresholdMinutes: number;
  earlyExitThresholdMinutes: number;
  flexible: boolean;
};

export type DeriveAttendanceInput = {
  isoDate: string;
  workingDays: string[];
  holidayDates: string[];
  weekPattern?: WeekPattern | null;
  onApprovedLeave: boolean;
  shift: ShiftDefinition | null;
  actualIn: Date | null;
  actualOut: Date | null;
};

export type DeriveAttendanceResult = {
  status: AttendanceStatus;
  workedMinutes: number | null;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  scheduledIn: Date | null;
  scheduledOut: Date | null;
};
