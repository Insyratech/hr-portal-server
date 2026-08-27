import { ROLE_CODES } from '../../shared/constants/permissions';

export const APPROVAL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RESUBMIT_REQUESTED'] as const;
export type PriorityApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const SKIP_EXECUTION = new Set(['CANCELLED', 'CARRIED_FORWARD']);

/** SA / HR / GM / Finance skip the personal priority + daily approval loop. CSO still participates as employee. */
export function skipsWorkApprovalLoop(roles: readonly string[]): boolean {
  if (roles.includes(ROLE_CODES.SUPER_ADMIN)) return true;
  if (roles.includes(ROLE_CODES.HR_MANAGER)) return true;
  if (roles.includes(ROLE_CODES.GENERAL_MANAGER) || roles.includes(ROLE_CODES.ADMIN)) return true;
  if (roles.includes(ROLE_CODES.FINANCE_MANAGER)) return true;
  return false;
}

export function isActivePriorityForGate(executionStatus: string): boolean {
  return !SKIP_EXECUTION.has(executionStatus);
}

export function isWorkGoalType(type: string): boolean {
  return type === 'PROJECT' || type === 'REGULAR';
}

export const MIN_WORK_GOAL_MESSAGE =
  'Add at least one work goal (R&D project or regular work) before submitting. Skill development is optional.';

const WEEK_WORK_GOAL_APPROVAL = new Set(['DRAFT', 'RESUBMIT_REQUESTED', 'SUBMITTED', 'APPROVED']);

/** True when the week already has a live work goal (draft, with CSO, or approved). */
export function weekHasWorkGoal(
  priorities: { type: string; status: string; approvalStatus: string }[],
): boolean {
  return priorities.some(
    (row) =>
      isWorkGoalType(row.type) &&
      isActivePriorityForGate(row.status) &&
      WEEK_WORK_GOAL_APPROVAL.has(row.approvalStatus),
  );
}

/** Skill lines may submit only after a work goal is in the CSO loop or already approved. */
export function weekAllowsSkillSubmit(
  priorities: { type: string; status: string; approvalStatus: string }[],
): boolean {
  return priorities.some(
    (row) =>
      isWorkGoalType(row.type) &&
      isActivePriorityForGate(row.status) &&
      (row.approvalStatus === 'SUBMITTED' ||
        row.approvalStatus === 'APPROVED' ||
        row.approvalStatus === 'RESUBMIT_REQUESTED'),
  );
}

export function dailyPrioritiesGate(
  priorities: { status: string; approvalStatus: string }[],
): { ok: boolean; reason: string | null } {
  const active = priorities.filter((row) => isActivePriorityForGate(row.status));
  if (active.length === 0) {
    return {
      ok: false,
      reason: 'Set your priorities and submit them for CSO approval before today’s update.',
    };
  }
  if (active.some((row) => row.approvalStatus !== 'APPROVED')) {
    return { ok: false, reason: 'Waiting for CSO approval on priorities.' };
  }
  return { ok: true, reason: null };
}

export function canEditPriorityContent(approvalStatus: string): boolean {
  return approvalStatus === 'DRAFT' || approvalStatus === 'RESUBMIT_REQUESTED';
}

export function canEditPriorityExecution(approvalStatus: string): boolean {
  return approvalStatus === 'APPROVED';
}

export function approvalLabel(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'SUBMITTED':
      return 'Awaiting CSO';
    case 'APPROVED':
      return 'Approved';
    case 'RESUBMIT_REQUESTED':
      return 'Needs resubmit';
    default:
      return status;
  }
}

export type PlanApprovalSummary = 'none' | 'draft' | 'awaiting' | 'needs_resubmit' | 'approved';

/** Roll up active priorities for Team week / desk glance. */
export function aggregatePriorityApproval(
  priorities: { status: string; approvalStatus: string }[],
): PlanApprovalSummary {
  const active = priorities.filter((row) => isActivePriorityForGate(row.status));
  if (active.length === 0) return 'none';
  if (active.some((row) => row.approvalStatus === 'RESUBMIT_REQUESTED')) return 'needs_resubmit';
  if (active.some((row) => row.approvalStatus === 'SUBMITTED')) return 'awaiting';
  if (active.every((row) => row.approvalStatus === 'APPROVED')) return 'approved';
  return 'draft';
}

export function planApprovalLabel(summary: PlanApprovalSummary): string {
  switch (summary) {
    case 'none':
      return 'No priorities';
    case 'draft':
      return 'Not submitted';
    case 'awaiting':
      return 'Awaiting CSO';
    case 'needs_resubmit':
      return 'Needs resubmit';
    case 'approved':
      return 'Approved';
    default:
      return summary;
  }
}

export type WeeklyPptGlanceStatus = 'on_time' | 'late' | 'missing' | 'pending';

export function weeklyPptGlanceStatus(input: {
  hasUpdate: boolean;
  late: boolean;
  todayIso: string;
  saturdayIso: string;
}): WeeklyPptGlanceStatus {
  if (input.hasUpdate) return input.late ? 'late' : 'on_time';
  if (input.todayIso > input.saturdayIso) return 'missing';
  return 'pending';
}

export function weeklyPptGlanceLabel(status: WeeklyPptGlanceStatus): string {
  switch (status) {
    case 'on_time':
      return 'PPT on time';
    case 'late':
      return 'PPT late';
    case 'missing':
      return 'PPT missing';
    case 'pending':
      return 'PPT pending';
    default:
      return status;
  }
}
