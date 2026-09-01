import { describe, expect, it } from 'vitest';
import { buildProjectReportingChain } from './project-reporting';

describe('buildProjectReportingChain', () => {
  it('nests daily work under priorities within goal → milestone → employee', () => {
    const chain = buildProjectReportingChain({
      goals: [
        {
          id: 'g1',
          name: 'Delivery',
          sequence: 1,
          milestones: [
            { id: 'm1', name: 'Phase 1', status: 'ACTIVE', sequence: 1 },
            { id: 'm2', name: 'Phase 2', status: 'UPCOMING', sequence: 2 },
          ],
        },
      ],
      priorities: [
        {
          id: 'pr1',
          employeeId: 'e1',
          employeeName: 'Alex',
          title: 'API work',
          status: 'IN_PROGRESS',
          approvalStatus: 'APPROVED',
          milestoneId: 'm1',
          isAdditional: false,
        },
        {
          id: 'pr2',
          employeeId: 'e2',
          employeeName: 'Blake',
          title: 'UI polish',
          status: 'IN_PROGRESS',
          approvalStatus: 'SUBMITTED',
          milestoneId: 'm1',
          isAdditional: true,
        },
      ],
      dailyEntries: [
        {
          id: 'd1',
          date: '2026-09-01',
          employeeId: 'e1',
          category: 'PLANNED',
          description: 'Shipped endpoint',
          priorityId: 'pr1',
        },
      ],
    });

    expect(chain).toHaveLength(1);
    expect(chain[0]?.name).toBe('Delivery');
    expect(chain[0]?.milestones).toHaveLength(2);
    const active = chain[0]?.milestones[0];
    expect(active?.employees).toHaveLength(2);
    const alex = active?.employees.find((row) => row.employeeId === 'e1');
    expect(alex?.priorities[0]?.dailyEntries).toEqual([
      {
        id: 'd1',
        date: '2026-09-01',
        category: 'PLANNED',
        description: 'Shipped endpoint',
      },
    ]);
    const emptyMilestone = chain[0]?.milestones[1];
    expect(emptyMilestone?.employees).toEqual([]);
  });
});
