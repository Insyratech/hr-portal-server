import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export function parseMoney(value: unknown, label: string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `${label} must be a number of 0 or more.`, 400);
  }
  return Math.round(amount * 100) / 100;
}
