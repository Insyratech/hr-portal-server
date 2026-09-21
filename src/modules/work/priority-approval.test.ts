import { describe, expect, it } from 'vitest';
import { canSkipLeadApproval, type PriorityForApproval } from './priority-approval';

function priority(partial: Partial<PriorityForApproval> & Pick<PriorityForApproval, 'priority_type'>): PriorityForApproval {
  return {
    id: 'p1',
    employee_id: 'e1',
    project_id: null,
    ...partial,
  };
}

describe('canSkipLeadApproval', () => {
  it('auto-approves REGULAR when the employee is not on any project', () => {
    expect(canSkipLeadApproval(priority({ priority_type: 'REGULAR' }), false)).toBe(true);
  });

  it('auto-approves SKILL when the employee is not on any project', () => {
    expect(canSkipLeadApproval(priority({ priority_type: 'SKILL' }), false)).toBe(true);
  });

  it('still requires a lead for REGULAR when the employee is on a project', () => {
    expect(canSkipLeadApproval(priority({ priority_type: 'REGULAR' }), true)).toBe(false);
  });

  it('never skips lead approval for PROJECT priorities', () => {
    expect(
      canSkipLeadApproval(priority({ priority_type: 'PROJECT', project_id: 'proj-1' }), false),
    ).toBe(false);
    expect(canSkipLeadApproval(priority({ priority_type: 'PROJECT' }), false)).toBe(false);
  });

  it('never skips when a project_id is set', () => {
    expect(
      canSkipLeadApproval(priority({ priority_type: 'REGULAR', project_id: 'proj-1' }), false),
    ).toBe(false);
  });
});
