import { describe, expect, it } from 'vitest';
import {
  buildWeeklyPptSystemFileName,
  isWeeklyPptLate,
  pptExtension,
  pptWeekBounds,
  readWeeklyPptTiming,
  saturdayOfPptWeek,
  sundayOfPptWeek,
  weeklyPptTiming,
} from './ppt-week';

describe('weekly PPT week helpers', () => {
  it('uses Mon–Sun calendar bounds', () => {
    expect(pptWeekBounds('2026-08-26')).toEqual({ start: '2026-08-24', end: '2026-08-30' });
    expect(saturdayOfPptWeek('2026-08-24')).toBe('2026-08-29');
    expect(sundayOfPptWeek('2026-08-24')).toBe('2026-08-30');
    expect(sundayOfPptWeek('2026-08-31')).toBe('2026-09-06');
  });

  it('stays on time until Sunday 23:00 IST, then tags the last hour', () => {
    // Week 2026-08-24 → deadline Sunday 2026-08-30. IST = UTC + 5:30.
    const timing = (utc: string) => weeklyPptTiming(new Date(utc), '2026-08-24');

    expect(timing('2026-08-29T12:30:00.000Z')).toBe('on_time'); // Sat 18:00 IST
    expect(timing('2026-08-30T12:30:00.000Z')).toBe('on_time'); // Sun 18:00 IST — no longer late
    expect(timing('2026-08-30T17:29:00.000Z')).toBe('on_time'); // Sun 22:59 IST
    expect(timing('2026-08-30T17:30:00.000Z')).toBe('last_hour'); // Sun 23:00 IST
    expect(timing('2026-08-30T18:28:00.000Z')).toBe('last_hour'); // Sun 23:58 IST
    expect(timing('2026-08-30T18:30:00.000Z')).toBe('late'); // Mon 00:00 IST
    expect(timing('2026-08-31T05:00:00.000Z')).toBe('late'); // Mon 10:30 IST
  });

  it('flags only true lateness on the stored boolean', () => {
    expect(isWeeklyPptLate('on_time')).toBe(false);
    expect(isWeeklyPptLate('last_hour')).toBe(false);
    expect(isWeeklyPptLate('late')).toBe(true);
  });

  it('reads stored timing, falling back to the legacy late flag', () => {
    expect(readWeeklyPptTiming({ submission_timing: 'last_hour', late: false })).toBe('last_hour');
    expect(readWeeklyPptTiming({ submission_timing: 'late', late: true })).toBe('late');
    expect(readWeeklyPptTiming({ submission_timing: null, late: true })).toBe('late');
    expect(readWeeklyPptTiming({ submission_timing: null, late: false })).toBe('on_time');
    expect(readWeeklyPptTiming({})).toBe('on_time');
  });

  it('builds Name_Month_DD-DD system file names', () => {
    expect(buildWeeklyPptSystemFileName('Sandip Kumar Yadav', '2026-08-24', '2026-08-30', '.pptx')).toBe(
      'Sandip_Kumar_Yadav_August_24-30.pptx',
    );
    expect(pptExtension('deck.PPTX')).toBe('.pptx');
    expect(pptExtension('notes.pdf')).toBeNull();
  });
});
