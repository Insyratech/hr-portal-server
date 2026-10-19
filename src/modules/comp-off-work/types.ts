export type CompOffWorkStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type CompOffWorkRecord = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  leaveApplicationId: string;
  leaveTypeCode: string | null;
  leaveTypeName: string | null;
  workDate: string;
  leaveDate: string;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  balanceRestored: number;
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
