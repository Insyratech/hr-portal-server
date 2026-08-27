import { describe, expect, it } from 'vitest';
import { buildLeaveApprovalSteps } from './project-lead-approval';

describe('buildLeaveApprovalSteps', () => {
  it('builds handover → project lead → HR', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: true,
      withProjectLead: true,
    });
    expect(rows.map((row) => [row.step_order, row.approver_role, row.status])).toEqual([
      [1, 'HANDOVER', 'PENDING'],
      [2, 'PROJECT_LEAD', 'PENDING'],
      [3, 'HR_MANAGER', 'PENDING'],
    ]);
  });

  it('builds project lead → HR when no handover', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: false,
      withProjectLead: true,
    });
    expect(rows.map((row) => row.approver_role)).toEqual(['PROJECT_LEAD', 'HR_MANAGER']);
  });

  it('keeps HR-only when not on a project', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: false,
      withProjectLead: false,
    });
    expect(rows).toEqual([
      {
        application_id: 'app-1',
        step_order: 1,
        approver_role: 'HR_MANAGER',
        status: 'PENDING',
      },
    ]);
  });

  it('marks lead step approved when applicant is the lead', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: true,
      withProjectLead: true,
      projectLeadAccepted: true,
    });
    expect(rows.find((row) => row.approver_role === 'PROJECT_LEAD')?.status).toBe('APPROVED');
    expect(rows.find((row) => row.approver_role === 'HANDOVER')?.status).toBe('PENDING');
  });
});
