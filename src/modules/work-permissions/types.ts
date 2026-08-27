import type { PermissionSlot } from './quota';

export type WorkPermissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type WorkPermissionRecord = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  permissionDate: string;
  minutes: number;
  slot: PermissionSlot;
  reason: string;
  status: WorkPermissionStatus;
  actorId: string | null;
  decidedAt: string | null;
  createdAt: string;
  remainingMinutes: number;
  monthLabel: string;
};

export type WorkPermissionMine = {
  quotaMinutes: number;
  items: WorkPermissionRecord[];
};
