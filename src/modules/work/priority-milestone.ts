type PriorityBatchRow = {
  type: string;
  approvalStatus: string;
  milestoneId: string | null;
};

type MilestoneRef = {
  projectId: string;
  status: string;
};

/** Returns a user-facing validation message, or null when the PROJECT line may be submitted. */
export function projectMilestoneSubmitError(
  priorityType: string,
  projectId: string | null,
  milestoneId: string | null,
  milestone: MilestoneRef | null,
): string | null {
  if (priorityType !== 'PROJECT') return null;
  if (!projectId || !milestoneId) {
    return 'R&D priorities must be tied to the active project milestone.';
  }
  if (!milestone) {
    return 'This milestone no longer exists. Ask your project lead.';
  }
  if (milestone.projectId !== projectId) {
    return 'This milestone does not belong to the selected project.';
  }
  if (milestone.status !== 'ACTIVE') {
    return 'This milestone is no longer active. Ask your project lead before submitting.';
  }
  return null;
}

/** Mid-week PROJECT lines are additional only after an approved line on the same active milestone. */
export function resolveProjectPriorityIsAdditional(
  existing: PriorityBatchRow[],
  priorityType: string,
  milestoneId: string | null,
): boolean {
  if (priorityType !== 'PROJECT' || !milestoneId) return false;
  return existing.some(
    (row) =>
      row.type === 'PROJECT' &&
      row.approvalStatus === 'APPROVED' &&
      row.milestoneId === milestoneId,
  );
}

export type MilestonePriorityCounts = {
  initialCount: number;
  additionalCount: number;
  completedCount: number;
};

export function tallyMilestonePriorities(
  priorities: {
    type: string;
    projectId: string | null;
    milestoneId: string | null;
    isAdditional: boolean;
    status: string;
  }[],
  projectId: string,
  activeMilestoneId: string | null,
): MilestonePriorityCounts {
  const rows = priorities.filter(
    (row) =>
      row.type === 'PROJECT' &&
      row.projectId === projectId &&
      activeMilestoneId &&
      row.milestoneId === activeMilestoneId,
  );
  return {
    initialCount: rows.filter((row) => !row.isAdditional).length,
    additionalCount: rows.filter((row) => row.isAdditional).length,
    completedCount: rows.filter((row) => row.status === 'COMPLETED').length,
  };
}
