import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

/** Atomically allocate the next document number for a series type (current FY label preferred). */
export async function allocateDocumentNumber(
  supabase: SupabaseClient,
  documentType: string,
  fiscalYearLabel = '2026-27',
): Promise<string> {
  const { data: rows, error } = await supabase
    .from('finance_number_series')
    .select('*')
    .eq('document_type', documentType)
    .eq('fiscal_year_label', fiscalYearLabel)
    .limit(1);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load number series.', 500);
  }
  let row = rows?.[0] as
    | { id: string; prefix: string; pad_length: number; next_number: number | string; fiscal_year_label: string }
    | undefined;
  if (!row) {
    const { data: anyYear } = await supabase
      .from('finance_number_series')
      .select('*')
      .eq('document_type', documentType)
      .order('fiscal_year_label', { ascending: false })
      .limit(1);
    row = anyYear?.[0] as typeof row;
  }
  if (!row) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, `Number series missing for ${documentType}.`, 404);
  }
  const next = Number(row.next_number);
  const { error: updErr } = await supabase
    .from('finance_number_series')
    .update({ next_number: next + 1 })
    .eq('id', row.id)
    .eq('next_number', row.next_number);
  if (updErr) {
    throw new AppError(API_ERROR_CODES.CONFLICT, 'Could not allocate document number. Retry.', 409);
  }
  const padded = String(next).padStart(row.pad_length, '0');
  return `${row.prefix}-${row.fiscal_year_label}-${padded}`;
}

/** Preview next document number without consuming the series counter. */
export async function peekDocumentNumber(
  supabase: SupabaseClient,
  documentType: string,
  fiscalYearLabel = '2026-27',
): Promise<string> {
  const { data: rows, error } = await supabase
    .from('finance_number_series')
    .select('*')
    .eq('document_type', documentType)
    .eq('fiscal_year_label', fiscalYearLabel)
    .limit(1);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load number series.', 500);
  }
  let row = rows?.[0] as
    | { prefix: string; pad_length: number; next_number: number | string; fiscal_year_label: string }
    | undefined;
  if (!row) {
    const { data: anyYear } = await supabase
      .from('finance_number_series')
      .select('*')
      .eq('document_type', documentType)
      .order('fiscal_year_label', { ascending: false })
      .limit(1);
    row = anyYear?.[0] as typeof row;
  }
  if (!row) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, `Number series missing for ${documentType}.`, 404);
  }
  const next = Number(row.next_number);
  const padded = String(next).padStart(row.pad_length, '0');
  return `${row.prefix}-${row.fiscal_year_label}-${padded}`;
}

export function lineAmount(quantity: number, rate: number, taxPercent: number): { amount: number; taxAmount: number } {
  const amount = Math.round(quantity * rate * 100) / 100;
  const taxAmount = Math.round(amount * (taxPercent / 100) * 100) / 100;
  return { amount, taxAmount };
}
