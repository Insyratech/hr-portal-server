export type CompOffWorkStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type CompOffWorkKind = 'EARN' | 'LEGACY_OFFSET';

export type CompOffWaitingOn = 'PROJECT_LEAD' | 'HR' | 'WORK_CONFIRM' | null;

export type CompOffWorkRecord = {
  id: string;
  kind: CompOffWorkKind;
  employeeId: string;
  employeeName: string | null;
  leaveApplicationId: string | null;
  leaveTypeCode: string | null;
  leaveTypeName: string | null;
  workDate: string;
  leaveDate: string | null;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  waitingOn: CompOffWaitingOn;
  balanceRestored: number;
  projectId: string | null;
  projectName: string | null;
  projectCode: string | null;
  projectLeadEmployeeId: string | null;
  projectLeadName: string | null;
  projectLeadRequired: boolean;
  projectLeadAccepted: boolean;
  projectLeadActedAt: string | null;
  hrAccepted: boolean;
  hrActedAt: string | null;
  workConfirmedAt: string | null;
  creditedAt: string | null;
  creditedQuantity: number;
  actorId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type CompOffEligibleLeaveDay = {
  leaveDate: string;
  quantity: number;
  available: boolean;
};

export type CompOffEligibleLeave = {
  leaveApplicationId: string;
  leaveTypeCode: string | null;
  leaveTypeName: string | null;
  startDate: string;
  endDate: string;
  duration: 'full' | 'half';
  status: string;
  days: CompOffEligibleLeaveDay[];
};

export type CompOffAdjustmentRecord = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  leaveApplicationId: string;
  leaveTypeCode: string | null;
  leaveTypeName: string | null;
  leaveDate: string;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  compConsumed: number;
  originalRestored: number;
  actorId: string | null;
  decidedAt: string | null;
  createdAt: string;
};
