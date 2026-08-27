import { describe, expect, it } from 'vitest';
import {
  buildWeeklyPptSystemFileName,
  isWeeklyPptLate,
  pptExtension,
  pptWeekBounds,
  saturdayOfPptWeek,
} from './ppt-week';

describe('weekly PPT week helpers', () => {
  it('uses Mon–Sun calendar bounds', () => {
    expect(pptWeekBounds('2026-08-26')).toEqual({ start: '2026-08-24', end: '2026-08-30' });
    expect(saturdayOfPptWeek('2026-08-24')).toBe('2026-08-29');
  });

  it('marks late at or after Saturday 18:00 IST', () => {
    // Sat 2026-08-29 17:30 IST = 12:00 UTC
    expect(isWeeklyPptLate(new Date('2026-08-29T12:00:00.000Z'), '2026-08-24')).toBe(false);
    // Sat 18:00 IST = 12:30 UTC
    expect(isWeeklyPptLate(new Date('2026-08-29T12:30:00.000Z'), '2026-08-24')).toBe(true);
    // Sunday
    expect(isWeeklyPptLate(new Date('2026-08-30T05:00:00.000Z'), '2026-08-24')).toBe(true);
  });

  it('builds Name_Month_DD-DD system file names', () => {
    expect(buildWeeklyPptSystemFileName('Sandip Kumar Yadav', '2026-08-24', '2026-08-30', '.pptx')).toBe(
      'Sandip_Kumar_Yadav_August_24-30.pptx',
    );
    expect(pptExtension('deck.PPTX')).toBe('.pptx');
    expect(pptExtension('notes.pdf')).toBeNull();
  });
});
