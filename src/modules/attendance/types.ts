export type AttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'LATE'
  | 'HALF_DAY'
  | 'LEAVE'
  | 'HOLIDAY'
  | 'WEEK_OFF'
  | 'MISSING_PUNCH';

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
