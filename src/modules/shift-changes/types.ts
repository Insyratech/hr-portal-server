export type ShiftChangeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type ShiftChangeRequest = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  projectId: string | null;
  projectName: string | null;
  projectCode: string | null;
  startDate: string;
  endDate: string;
  requestedShiftId: string;
  requestedShiftName: string | null;
  currentShiftId: string | null;
  currentShiftName: string | null;
  reason: string;
  status: ShiftChangeStatus;
  projectLeadEmployeeId: string | null;
  projectLeadName: string | null;
  projectLeadRequired: boolean;
  projectLeadAccepted: boolean;
  projectLeadActedAt: string | null;
  reviewerEmployeeId: string | null;
  reviewerComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type ShiftChangeApplyInput = {
  startDate: string;
  endDate: string;
  requestedShiftId: string;
  reason: string;
  projectId?: string;
};
