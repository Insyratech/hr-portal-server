export const WORK_DAY_STATUSES = [
  'COMPLETED',
  'MISSING',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKEND',
  'NOT_REQUIRED',
] as const;

export type WorkDayStatus = (typeof WORK_DAY_STATUSES)[number];

export type DayContext = {
  isoDate: string;
  required: boolean;
  status: WorkDayStatus;
  onApprovedLeave: boolean;
  submitted: boolean;
};
