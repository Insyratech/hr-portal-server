import { describe, expect, it } from 'vitest';
import {
  buildWeeklyPptSystemFileName,
  isWeeklyPptLate,
  pptExtension,
  pptWeekBounds,
  saturdayOfPptWeek,
  sundayOfPptWeek,
} from './ppt-week';

describe('weekly PPT week helpers', () => {
  it('uses Mon–Sun calendar bounds', () => {
    expect(pptWeekBounds('2026-08-26')).toEqual({ start: '2026-08-24', end: '2026-08-30' });
    expect(saturdayOfPptWeek('2026-08-24')).toBe('2026-08-29');
    expect(sundayOfPptWeek('2026-08-24')).toBe('2026-08-30');
    expect(sundayOfPptWeek('2026-08-31')).toBe('2026-09-06');
  });

  it('marks late at or after Sunday 18:00 IST', () => {
    // Sat still on time
    expect(isWeeklyPptLate(new Date('2026-08-29T12:30:00.000Z'), '2026-08-24')).toBe(false);
    // Sun 2026-08-30 17:30 IST = 12:00 UTC
    expect(isWeeklyPptLate(new Date('2026-08-30T12:00:00.000Z'), '2026-08-24')).toBe(false);
    // Sun 18:00 IST = 12:30 UTC
    expect(isWeeklyPptLate(new Date('2026-08-30T12:30:00.000Z'), '2026-08-24')).toBe(true);
    // Monday (next week)
    expect(isWeeklyPptLate(new Date('2026-08-31T05:00:00.000Z'), '2026-08-24')).toBe(true);
  });

  it('builds Name_Month_DD-DD system file names', () => {
    expect(buildWeeklyPptSystemFileName('Sandip Kumar Yadav', '2026-08-24', '2026-08-30', '.pptx')).toBe(
      'Sandip_Kumar_Yadav_August_24-30.pptx',
    );
    expect(pptExtension('deck.PPTX')).toBe('.pptx');
    expect(pptExtension('notes.pdf')).toBeNull();
  });
});
