export type NoticeUnit = 'hours' | 'days';

export type PolicyRules = {
  noticePeriod: { value: number; unit: NoticeUnit };
  requiresApproval: boolean;
  requiresHandover: boolean;
  requiresAttachment: boolean;
  allowHalfDay: boolean;
  allowNegativeBalance: boolean;
  minimumServiceDays: number;
  maximumConsecutiveDays: number | null;
  annualAllocation: number;
  carryForward: number;
  employmentTypes: string[] | null;
  departmentIds: string[] | null;
  designationIds: string[] | null;
};

export type LeaveTypeFlags = {
  active: boolean;
  requiresApproval: boolean;
  requiresHandover: boolean;
  requiresAttachment: boolean;
  allowHalfDay: boolean;
  allowMultipleDays: boolean;
};

export type LeaveDuration = 'full' | 'half';

export type ApplicationInput = {
  startDate: string;
  endDate: string;
  duration: LeaveDuration;
  reason?: string;
  handover?: string;
  handoverEmployeeId?: string;
  attachmentUrl?: string;
  now: Date;
  joiningDate: string;
  employmentType: string;
  departmentId: string | null;
  designationId: string | null;
  employeeStatus: 'active' | 'inactive';
  available: number;
  overlapping: boolean;
  workingDays: string[];
  holidayDates: string[];
};

export type Violation = {
  code: string;
  message: string;
};

export type EngineResult = {
  valid: boolean;
  violations: Violation[];
  quantity: number;
  requiresApproval: boolean;
  requiresHandover: boolean;
  requiresAttachment: boolean;
};
