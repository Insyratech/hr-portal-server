import type { DeriveAttendanceResult } from '../types';

export type HrAction = 'FULL_LOP' | 'HALF_LOP' | 'NO_LOP' | 'EXCLUDE';

export type LeaveOverlay = {
  typeName: string;
  paid: boolean;
  duration: 'full' | 'half';
};

export type LopProposal = {
  proposedLop: number | null;
  finalLop: number | null;
  hrAction: HrAction | null;
  needsHrDecision: boolean;
  skippedFromLop: boolean;
  permissionCovered: boolean;
};

export function untouchedFlagCount(rows: { needsHrDecision: boolean; hrAction: string | null }[]): number {
  return rows.filter((row) => row.needsHrDecision && !row.hrAction).length;
}

export function lopFromAction(action: HrAction): number {
  if (action === 'FULL_LOP') return 1;
  if (action === 'HALF_LOP') return 0.5;
  return 0;
}

/**
 * LOP overlay on deriveAttendance. Weekly offs/holidays never become LOP.
 * Miss punch always waits for HR. Never auto half-day for miss punch.
 * Late waits for HR only on fixed shifts (status LATE), not on flexible hours.
 */
export function proposeLop(input: {
  derived: DeriveAttendanceResult;
  permissionMinutes: number;
  permissionSlot?: 'START' | 'END' | null;
  leave: LeaveOverlay | null;
}): LopProposal {
  const status = input.derived.status;
  const lateMinutes = input.derived.lateMinutes;
  const earlyExitMinutes = input.derived.earlyExitMinutes;
  const slot = input.permissionSlot === 'END' ? 'END' : 'START';
  const startCovered = slot === 'START' && lateMinutes > 0 && input.permissionMinutes >= lateMinutes;
  const endCovered = slot === 'END' && earlyExitMinutes > 0 && input.permissionMinutes >= earlyExitMinutes;
  const permissionCovered = startCovered || endCovered;

  if (status === 'HOLIDAY' || status === 'WEEK_OFF') {
    return {
      proposedLop: 0,
      finalLop: 0,
      hrAction: 'EXCLUDE',
      needsHrDecision: false,
      skippedFromLop: true,
      permissionCovered: false,
    };
  }

  if (status === 'LEAVE' || input.leave) {
    const unpaid = input.leave ? !input.leave.paid : false;
    const amount = unpaid ? (input.leave?.duration === 'half' ? 0.5 : 1) : 0;
    const action: HrAction = amount === 1 ? 'FULL_LOP' : amount === 0.5 ? 'HALF_LOP' : 'NO_LOP';
    return {
      proposedLop: amount,
      finalLop: amount,
      hrAction: action,
      needsHrDecision: false,
      skippedFromLop: !unpaid,
      permissionCovered: false,
    };
  }

  if (status === 'MISSING_PUNCH') {
    return {
      proposedLop: null,
      finalLop: null,
      hrAction: null,
      needsHrDecision: true,
      skippedFromLop: false,
      permissionCovered: false,
    };
  }

  if (status === 'LATE' && !startCovered) {
    return {
      proposedLop: null,
      finalLop: null,
      hrAction: null,
      needsHrDecision: true,
      skippedFromLop: false,
      permissionCovered: false,
    };
  }

  if (endCovered && (status === 'HALF_DAY' || status === 'LATE' || status === 'PRESENT')) {
    return {
      proposedLop: 0,
      finalLop: 0,
      hrAction: 'NO_LOP',
      needsHrDecision: false,
      skippedFromLop: false,
      permissionCovered: true,
    };
  }

  if (status === 'ABSENT') {
    return {
      proposedLop: 1,
      finalLop: 1,
      hrAction: 'FULL_LOP',
      needsHrDecision: false,
      skippedFromLop: false,
      permissionCovered: false,
    };
  }

  if (status === 'HALF_DAY') {
    return {
      proposedLop: 0.5,
      finalLop: 0.5,
      hrAction: 'HALF_LOP',
      needsHrDecision: false,
      skippedFromLop: false,
      permissionCovered,
    };
  }

  return {
    proposedLop: 0,
    finalLop: 0,
    hrAction: 'NO_LOP',
    needsHrDecision: false,
    skippedFromLop: false,
    permissionCovered,
  };
}
