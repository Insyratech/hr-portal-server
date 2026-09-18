import { describe, expect, it } from 'vitest';
import { buildLeaveApprovalSteps, leaveWorkflowStillPending } from './project-lead-approval';

describe('buildLeaveApprovalSteps', () => {
  it('builds handover → project lead → HR', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: true,
      withProjectLead: true,
      withHr: true,
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
      withHr: true,
    });
    expect(rows.map((row) => row.approver_role)).toEqual(['PROJECT_LEAD', 'HR_MANAGER']);
  });

  it('keeps HR-only when not on a project', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: false,
      withProjectLead: false,
      withHr: true,
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

  it('builds PL-only without HR', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: false,
      withProjectLead: true,
      withHr: false,
    });
    expect(rows.map((row) => row.approver_role)).toEqual(['PROJECT_LEAD']);
  });

  it('builds handover-only when neither PL nor HR', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: true,
      withProjectLead: false,
      withHr: false,
    });
    expect(rows.map((row) => row.approver_role)).toEqual(['HANDOVER']);
  });

  it('marks lead step approved when applicant is the lead', () => {
    const rows = buildLeaveApprovalSteps({
      applicationId: 'app-1',
      withHandover: true,
      withProjectLead: true,
      withHr: true,
      projectLeadAccepted: true,
    });
    expect(rows.find((row) => row.approver_role === 'PROJECT_LEAD')?.status).toBe('APPROVED');
    expect(rows.find((row) => row.approver_role === 'HANDOVER')?.status).toBe('PENDING');
  });
});

describe('leaveWorkflowStillPending', () => {
  it('is pending when HR is required', () => {
    expect(
      leaveWorkflowStillPending({
        withHandover: false,
        withProjectLead: false,
        withHr: true,
      }),
    ).toBe(true);
  });

  it('is not pending when PL already accepted and no HR', () => {
    expect(
      leaveWorkflowStillPending({
        withHandover: false,
        withProjectLead: true,
        withHr: false,
        projectLeadAccepted: true,
      }),
    ).toBe(false);
  });

  it('is pending when PL still needed', () => {
    expect(
      leaveWorkflowStillPending({
        withHandover: false,
        withProjectLead: true,
        withHr: false,
        projectLeadAccepted: false,
      }),
    ).toBe(true);
  });
});
