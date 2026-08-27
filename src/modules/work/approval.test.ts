import { describe, expect, it } from 'vitest';
import {
  aggregatePriorityApproval,
  canEditPriorityContent,
  canEditPriorityExecution,
  dailyPrioritiesGate,
  skipsWorkApprovalLoop,
  weeklyPptGlanceStatus,
} from './approval';

describe('work priority approval helpers', () => {
  it('exempts SA / HR / GM / Finance from the approval loop', () => {
    expect(skipsWorkApprovalLoop(['SUPER_ADMIN'])).toBe(true);
    expect(skipsWorkApprovalLoop(['HR_MANAGER', 'EMPLOYEE'])).toBe(true);
    expect(skipsWorkApprovalLoop(['GENERAL_MANAGER'])).toBe(true);
    expect(skipsWorkApprovalLoop(['FINANCE_MANAGER'])).toBe(true);
    expect(skipsWorkApprovalLoop(['CSO', 'EMPLOYEE'])).toBe(false);
    expect(skipsWorkApprovalLoop(['EMPLOYEE'])).toBe(false);
  });

  it('blocks daily updates until every active priority is approved', () => {
    expect(dailyPrioritiesGate([])).toMatchObject({ ok: false });
    expect(
      dailyPrioritiesGate([{ status: 'NOT_STARTED', approvalStatus: 'SUBMITTED' }]),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/Waiting for CSO/i) });
    expect(
      dailyPrioritiesGate([
        { status: 'NOT_STARTED', approvalStatus: 'APPROVED' },
        { status: 'CANCELLED', approvalStatus: 'DRAFT' },
      ]),
    ).toMatchObject({ ok: true });
  });

  it('locks content edits after submit and unlocks execution after approve', () => {
    expect(canEditPriorityContent('DRAFT')).toBe(true);
    expect(canEditPriorityContent('RESUBMIT_REQUESTED')).toBe(true);
    expect(canEditPriorityContent('SUBMITTED')).toBe(false);
    expect(canEditPriorityContent('APPROVED')).toBe(false);
    expect(canEditPriorityExecution('APPROVED')).toBe(true);
    expect(canEditPriorityExecution('SUBMITTED')).toBe(false);
  });

  it('rolls up plan approval for Team week glance', () => {
    expect(aggregatePriorityApproval([])).toBe('none');
    expect(aggregatePriorityApproval([{ status: 'NOT_STARTED', approvalStatus: 'DRAFT' }])).toBe('draft');
    expect(
      aggregatePriorityApproval([
        { status: 'NOT_STARTED', approvalStatus: 'APPROVED' },
        { status: 'IN_PROGRESS', approvalStatus: 'SUBMITTED' },
      ]),
    ).toBe('awaiting');
    expect(
      aggregatePriorityApproval([
        { status: 'NOT_STARTED', approvalStatus: 'APPROVED' },
        { status: 'CANCELLED', approvalStatus: 'DRAFT' },
      ]),
    ).toBe('approved');
    expect(
      aggregatePriorityApproval([{ status: 'NOT_STARTED', approvalStatus: 'RESUBMIT_REQUESTED' }]),
    ).toBe('needs_resubmit');
  });

  it('labels weekly PPT glance from update + Saturday deadline', () => {
    expect(
      weeklyPptGlanceStatus({
        hasUpdate: true,
        late: false,
        todayIso: '2026-08-26',
        saturdayIso: '2026-08-29',
      }),
    ).toBe('on_time');
    expect(
      weeklyPptGlanceStatus({
        hasUpdate: true,
        late: true,
        todayIso: '2026-08-30',
        saturdayIso: '2026-08-29',
      }),
    ).toBe('late');
    expect(
      weeklyPptGlanceStatus({
        hasUpdate: false,
        late: false,
        todayIso: '2026-08-30',
        saturdayIso: '2026-08-29',
      }),
    ).toBe('missing');
    expect(
      weeklyPptGlanceStatus({
        hasUpdate: false,
        late: false,
        todayIso: '2026-08-26',
        saturdayIso: '2026-08-29',
      }),
    ).toBe('pending');
  });
});
