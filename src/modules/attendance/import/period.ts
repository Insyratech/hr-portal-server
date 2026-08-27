import { API_ERROR_CODES } from '../../../shared/constants/error-codes';
import { AppError } from '../../../shared/errors/app-error';
import { eachIsoDate } from '../../leave/day-count';

export function parsePeriod(period: string): { start: string; end: string; label: string; monthName: string; key: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a month as YYYY-MM.', 400);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a month as YYYY-MM.', 400);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = `${match[1]}-${match[2]}-01`;
  const end = `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const label = `${monthName} ${year}`;
  return { start, end, label, monthName, key: `${match[1]}-${match[2]}` };
}

export function datesInPeriod(period: string): string[] {
  const { start, end } = parsePeriod(period);
  return eachIsoDate(start, end);
}
