import type { DayContext } from './types';

export function tallyToday(rows: DayContext[]): {
  expected: number;
  submitted: number;
  missing: number;
  onLeave: number;
} {
  return {
    expected: rows.filter((row) => row.required).length,
    submitted: rows.filter((row) => row.required && row.submitted).length,
    missing: rows.filter((row) => row.required && !row.submitted).length,
    onLeave: rows.filter((row) => row.status === 'ON_LEAVE').length,
  };
}
