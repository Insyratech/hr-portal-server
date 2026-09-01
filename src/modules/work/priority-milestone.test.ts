import { describe, expect, it } from 'vitest';
import { projectMilestoneSubmitError } from './priority-milestone';

describe('projectMilestoneSubmitError', () => {
  const projectId = 'p-1';
  const milestoneId = 'm-1';

  it('allows non-PROJECT priorities', () => {
    expect(projectMilestoneSubmitError('REGULAR', null, null, null)).toBeNull();
  });

  it('requires milestone on PROJECT priorities', () => {
    expect(projectMilestoneSubmitError('PROJECT', projectId, null, null)).toMatch(/active project milestone/);
  });

  it('rejects missing milestone row', () => {
    expect(projectMilestoneSubmitError('PROJECT', projectId, milestoneId, null)).toMatch(/no longer exists/);
  });

  it('rejects milestone from another project', () => {
    expect(
      projectMilestoneSubmitError('PROJECT', projectId, milestoneId, {
        projectId: 'other',
        status: 'ACTIVE',
      }),
    ).toMatch(/does not belong/);
  });

  it('rejects non-ACTIVE milestone', () => {
    expect(
      projectMilestoneSubmitError('PROJECT', projectId, milestoneId, {
        projectId,
        status: 'COMPLETED',
      }),
    ).toMatch(/no longer active/);
  });

  it('allows ACTIVE milestone on the same project', () => {
    expect(
      projectMilestoneSubmitError('PROJECT', projectId, milestoneId, {
        projectId,
        status: 'ACTIVE',
      }),
    ).toBeNull();
  });
});
