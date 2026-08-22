import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  return value;
}

export function toDateColumn(value: string | null | undefined, field: string, required = false): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    if (required) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `${field} is required.`, 400);
    }
    return null;
  }

  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const dmy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }

  throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`, 400);
}
