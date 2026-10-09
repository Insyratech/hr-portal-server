import { describe, expect, it } from 'vitest';
import {
  buildWeeklyPptSystemFileName,
  isWeeklyPptLate,
  isWithinWeeklyPptUploadWindow,
  mondayOfPptWeek,
  pptExtension,
  pptWeekBounds,
  readWeeklyPptTiming,
  saturdayOfPptWeek,
  sundayOfPptWeek,
  weeklyPptTiming,
  weeklyPptUploadWindowState,
} from './ppt-week';

describe('weekly PPT week helpers', () => {
  it('uses Tue–Mon calendar bounds (Monday = last day)', () => {
    // Wed 2026-08-26 → Tue 2026-08-25 … Mon 2026-08-31
    expect(pptWeekBounds('2026-08-26')).toEqual({ start: '2026-08-25', end: '2026-08-31' });
    // Monday still belongs to the week that started previous Tuesday
    expect(pptWeekBounds('2026-08-31')).toEqual({ start: '2026-08-25', end: '2026-08-31' });
    // Next Tuesday starts the next week
    expect(pptWeekBounds('2026-09-01')).toEqual({ start: '2026-09-01', end: '2026-09-07' });
    expect(saturdayOfPptWeek('2026-08-25')).toBe('2026-08-29');
    expect(sundayOfPptWeek('2026-08-25')).toBe('2026-08-30');
    expect(mondayOfPptWeek('2026-08-25')).toBe('2026-08-31');
  });

  it('opens the upload window Sat 14:00 IST through Sunday', () => {
    const week = '2026-08-25';
    const state = (utc: string) => weeklyPptUploadWindowState(new Date(utc), week);
    const open = (utc: string) => isWithinWeeklyPptUploadWindow(new Date(utc), week);

    expect(state('2026-08-28T12:30:00.000Z')).toBe('before'); // Fri 18:00 IST
    expect(open('2026-08-28T12:30:00.000Z')).toBe(false);
    expect(state('2026-08-29T08:00:00.000Z')).toBe('before'); // Sat 13:30 IST
    expect(state('2026-08-29T08:30:00.000Z')).toBe('open'); // Sat 14:00 IST
    expect(state('2026-08-30T12:30:00.000Z')).toBe('open'); // Sun 18:00 IST
    expect(state('2026-08-30T18:29:00.000Z')).toBe('open'); // Sun 23:59 IST
    expect(state('2026-08-30T18:30:00.000Z')).toBe('after'); // Mon 00:00 IST
    expect(open('2026-08-31T05:00:00.000Z')).toBe(false); // Mon morning
  });

  it('tags on_time / last_hour inside the window and late outside', () => {
    const timing = (utc: string) => weeklyPptTiming(new Date(utc), '2026-08-25');

    expect(timing('2026-08-29T08:00:00.000Z')).toBe('late'); // Sat 13:30 IST — before open
    expect(timing('2026-08-29T08:30:00.000Z')).toBe('on_time'); // Sat 14:00 IST
    expect(timing('2026-08-30T12:30:00.000Z')).toBe('on_time'); // Sun 18:00 IST
    expect(timing('2026-08-30T17:29:00.000Z')).toBe('on_time'); // Sun 22:59 IST
    expect(timing('2026-08-30T17:30:00.000Z')).toBe('last_hour'); // Sun 23:00 IST
    expect(timing('2026-08-30T18:28:00.000Z')).toBe('last_hour'); // Sun 23:58 IST
    expect(timing('2026-08-30T18:30:00.000Z')).toBe('late'); // Mon 00:00 IST
    expect(timing('2026-08-31T05:00:00.000Z')).toBe('late'); // Mon 10:30 IST — still same week
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
    expect(buildWeeklyPptSystemFileName('Sandip Kumar Yadav', '2026-08-25', '2026-08-31', '.pptx')).toBe(
      'Sandip_Kumar_Yadav_August_25-31.pptx',
    );
    expect(pptExtension('deck.PPTX')).toBe('.pptx');
    expect(pptExtension('notes.pdf')).toBeNull();
  });
});
