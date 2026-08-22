export const GRIEVANCE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED',
] as const;

export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

export const GRIEVANCE_CATEGORIES = [
  'WORKPLACE',
  'SALARY',
  'MANAGER',
  'ATTENDANCE',
  'POLICY',
  'OTHER',
] as const;

export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];

export const COMMENT_VISIBILITY = ['EMPLOYEE', 'INTERNAL'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITY)[number];

/** Forward-only path. Skipping steps requires manage permission (still one hop max unless allowSkip). */
const NEXT: Record<GrievanceStatus, GrievanceStatus | null> = {
  OPEN: 'UNDER_REVIEW',
  UNDER_REVIEW: 'INVESTIGATING',
  INVESTIGATING: 'RESOLVED',
  RESOLVED: 'CLOSED',
  CLOSED: null,
};

export function canTransition(input: {
  from: GrievanceStatus;
  to: GrievanceStatus;
  allowSkip: boolean;
}): boolean {
  if (input.from === input.to) {
    return false;
  }
  if (input.to === NEXT[input.from]) {
    return true;
  }
  if (!input.allowSkip) {
    return false;
  }
  const fromIndex = GRIEVANCE_STATUSES.indexOf(input.from);
  const toIndex = GRIEVANCE_STATUSES.indexOf(input.to);
  return toIndex > fromIndex;
}

export function assertTransition(input: {
  from: string;
  to: string;
  allowSkip: boolean;
}): { from: GrievanceStatus; to: GrievanceStatus } {
  if (!GRIEVANCE_STATUSES.includes(input.from as GrievanceStatus)) {
    throw new Error('INVALID_STATUS');
  }
  if (!GRIEVANCE_STATUSES.includes(input.to as GrievanceStatus)) {
    throw new Error('INVALID_STATUS');
  }
  const from = input.from as GrievanceStatus;
  const to = input.to as GrievanceStatus;
  if (!canTransition({ from, to, allowSkip: input.allowSkip })) {
    throw new Error('INVALID_STATUS_TRANSITION');
  }
  return { from, to };
}
