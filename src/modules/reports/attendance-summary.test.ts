import { describe, expect, it } from 'vitest';
import { summarizeConfirmedAttendance } from './attendance-summary';

describe('summarizeConfirmedAttendance', () => {
  const rows = [
    { status: 'PRESENT', finalLop: 0, companyId: 'insyra' },
    { status: 'LATE', finalLop: 0, companyId: 'insyra' },
    { status: 'ABSENT', finalLop: 1, companyId: '30m' },
    { status: 'MISSING_PUNCH', finalLop: 0.5, companyId: 'insyra' },
    { status: 'WEEK_OFF', finalLop: 0, companyId: 'insyra' },
  ];

  it('counts present, late, absent, miss punch and sums LOP from confirmed days', () => {
    expect(summarizeConfirmedAttendance(rows)).toEqual({
      present: 1,
      late: 1,
      absent: 1,
      missPunch: 1,
      lop: 1.5,
      halfDay: 0,
      onLeave: 0,
    });
  });

  it('filters by company', () => {
    expect(summarizeConfirmedAttendance(rows, '30m')).toEqual({
      present: 0,
      late: 0,
      absent: 1,
      missPunch: 0,
      lop: 1,
      halfDay: 0,
      onLeave: 0,
    });
  });
});
