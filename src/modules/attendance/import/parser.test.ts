import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { biometricMonthGrid } from './biometric-fixture';
import { extractTimes, firstAndLast, parseBiometricGrid } from './parser';
import { gridFromXlsx } from './workbook';

describe('parseBiometricGrid', () => {
  it('reads UserID block, day grid, first in and last out from stacked times', () => {
    const grid: unknown[][] = [
      ['User ID : EMP01', 'Name : Ada Lovelace'],
      [1, 2, 3, 4, 5, 6, 7, 8],
      ['09:00', '09:15', '', '', '', '', '', ''],
      ['18:00', '18:10', '', '', '', '', '', ''],
    ];
    const result = parseBiometricGrid(grid);
    expect(result.exceptions).toEqual([]);
    const day1 = result.days.find((row) => row.day === 1);
    const day2 = result.days.find((row) => row.day === 2);
    expect(day1?.times).toEqual(['09:00', '18:00']);
    expect(firstAndLast(day1?.times ?? [])).toEqual({ inTime: '09:00', outTime: '18:00' });
    expect(firstAndLast(day2?.times ?? [])).toEqual({ inTime: '09:15', outTime: '18:10' });
  });

  it('treats a single timestamp as miss punch (in only)', () => {
    expect(firstAndLast(['09:12'])).toEqual({ inTime: '09:12', outTime: null });
  });

  it('lists duplicate UserIDs as exceptions and drops their days', () => {
    const grid: unknown[][] = [
      ['User ID : A1', 'Name : One'],
      [1, 2, 3, 4, 5, 6, 7],
      ['09:00', '', '', '', '', '', ''],
      ['18:00', '', '', '', '', '', ''],
      ['User ID : A1', 'Name : One again'],
      [1, 2, 3, 4, 5, 6, 7],
      ['10:00', '', '', '', '', '', ''],
      ['19:00', '', '', '', '', '', ''],
    ];
    const result = parseBiometricGrid(grid);
    expect(result.days).toEqual([]);
    expect(result.exceptions.some((item) => item.reason.includes('Duplicate'))).toBe(true);
  });

  it('extracts multiple HH:mm from one multiline cell', () => {
    expect(extractTimes('09:00\n18:05')).toEqual(['09:00', '18:05']);
  });

  it('reads 12-hour times with am/pm', () => {
    expect(extractTimes('08:56 AM\n06:18 PM')).toEqual(['08:56', '18:18']);
  });

  it('reads excel serial datetime numbers as clock times', () => {
    const serial = 45839 + 8 / 24 + 56 / 1440;
    expect(extractTimes(serial)).toEqual(['08:56']);
  });

  it('parses a 31-day grid with multiline cells and flags a missing UserID', () => {
    const result = parseBiometricGrid(biometricMonthGrid({ includeMissingUserId: true }));
    expect(result.exceptions.some((item) => item.reason === 'Missing UserID.')).toBe(true);
    const day1 = result.days.find((row) => row.employeeCode === 'EMP01' && row.day === 1);
    const day2 = result.days.find((row) => row.employeeCode === 'EMP01' && row.day === 2);
    expect(day1?.times).toEqual(['09:00', '18:05']);
    expect(firstAndLast(day1?.times ?? [])).toEqual({ inTime: '09:00', outTime: '18:05' });
    expect(firstAndLast(day2?.times ?? [])).toEqual({ inTime: '09:12', outTime: null });
    expect(result.days.some((row) => row.day === 31)).toBe(false);
  });

  it('round-trips the 31-day fixture through a real .xlsx workbook', () => {
    const sheet = XLSX.utils.aoa_to_sheet(biometricMonthGrid());
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    const buffer = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const result = parseBiometricGrid(gridFromXlsx(buffer));
    const day1 = result.days.find((row) => row.day === 1);
    expect(day1?.times).toEqual(['09:00', '18:05']);
  });

  it('reads biometric reports where UserID and Name live in separate cells', () => {
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    const punches = days.map((day) => (day === 1 ? '08:56\n18:18' : ''));
    const grid: unknown[][] = [
      ['', 'UserID:', '', '2025009', '', '', '', '', '', '', 'Name:', 'sandip', '', '', '', '', '', 'Dept.:', 'DEPT1'],
      ['', ...days],
      ['', ...punches],
    ];
    const result = parseBiometricGrid(grid);
    expect(result.exceptions).toEqual([]);
    expect(result.days.find((row) => row.day === 1)).toEqual({
      employeeCode: '2025009',
      name: 'sandip',
      day: 1,
      times: ['08:56', '18:18'],
    });
  });
});
