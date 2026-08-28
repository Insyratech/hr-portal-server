import { describe, expect, it } from 'vitest';
import { closeDateForOpenRow, dayBefore, rowsToClose } from './shift-assignment-utils';

describe('shift assignment utils', () => {
  it('computes day before', () => {
    expect(dayBefore('2026-08-27')).toBe('2026-08-26');
  });

  it('closes older open rows the day before the new assignment', () => {
    expect(closeDateForOpenRow('2026-08-27', '2026-06-01')).toBe('2026-08-26');
  });

  it('closes future open rows on their start date when superseded', () => {
    expect(closeDateForOpenRow('2026-06-01', '2026-08-27')).toBe('2026-08-27');
  });

  it('closes every other open row when updating the current assignment', () => {
    const closes = rowsToClose(
      [
        { id: 'a', effective_from: '2026-06-01' },
        { id: 'b', effective_from: '2026-08-27' },
      ],
      '2026-08-27',
      'b',
    );
    expect(closes).toEqual([{ id: 'a', effectiveTo: '2026-08-26' }]);
  });
});
