export type AttendanceReviewStatRow = {
  status: string;
  finalLop: number;
  companyId: string | null;
};

export type AttendanceMonthStats = {
  present: number;
  late: number;
  absent: number;
  missPunch: number;
  lop: number;
  halfDay: number;
  onLeave: number;
};

export function summarizeConfirmedAttendance(
  rows: AttendanceReviewStatRow[],
  companyId?: string | null,
): AttendanceMonthStats {
  const scoped = companyId ? rows.filter((row) => row.companyId === companyId) : rows;
  let present = 0;
  let late = 0;
  let absent = 0;
  let missPunch = 0;
  let lop = 0;
  let halfDay = 0;
  let onLeave = 0;
  for (const row of scoped) {
    lop += Number(row.finalLop) || 0;
    if (row.status === 'PRESENT') present += 1;
    else if (row.status === 'LATE') late += 1;
    else if (row.status === 'ABSENT') absent += 1;
    else if (row.status === 'MISSING_PUNCH') missPunch += 1;
    else if (row.status === 'HALF_DAY') halfDay += 1;
    else if (row.status === 'LEAVE') onLeave += 1;
  }
  return {
    present,
    late,
    absent,
    missPunch,
    lop: Math.round(lop * 100) / 100,
    halfDay,
    onLeave,
  };
}
