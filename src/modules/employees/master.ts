import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canWriteDirectoryMasterPay } from './access';
import { parseMoney } from './money';
import { maskPayment } from './payment-mask';
import type { CompensationInput, CompensationRecord, EmployeePayroll, PaymentInput, PaymentRecord } from './types';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type CompensationRow = {
  id: string;
  employee_id: string;
  basic: number | string;
  da: number | string;
  hra: number | string;
  fuel: number | string;
  incentives: number | string;
  other_earnings: number | string;
  professional_tax: number | string;
  tds: number | string;
  employee_welfare: number | string;
  kpi: number | string;
  other_deductions: number | string;
  effective_from: string;
  created_at: string;
};

type PaymentRow = {
  employee_id: string;
  pan: string | null;
  bank_account_number: string | null;
  bank_name: string | null;
  ifsc: string | null;
  updated_at: string;
};

function num(value: number | string): number {
  return Number(value);
}

export function mapCompensation(row: CompensationRow): CompensationRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    basic: num(row.basic),
    da: num(row.da),
    hra: num(row.hra),
    fuel: num(row.fuel),
    incentives: num(row.incentives),
    other: num(row.other_earnings),
    professionalTax: num(row.professional_tax),
    tds: num(row.tds),
    employeeWelfare: num(row.employee_welfare),
    kpi: num(row.kpi),
    otherDeductions: num(row.other_deductions),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    createdAt: row.created_at,
  };
}

export function mapPayment(row: PaymentRow): PaymentRecord {
  return {
    employeeId: row.employee_id,
    pan: row.pan,
    bankAccountNumber: row.bank_account_number,
    bankName: row.bank_name,
    ifsc: row.ifsc,
    updatedAt: row.updated_at,
  };
}

export function normalizeCompensation(input: Partial<CompensationInput>, fallbackDate: string): CompensationInput {
  return {
    basic: parseMoney(input.basic ?? 0, 'Basic'),
    da: parseMoney(input.da ?? 0, 'DA'),
    hra: parseMoney(input.hra ?? 0, 'HRA'),
    fuel: parseMoney(input.fuel ?? 0, 'Fuel'),
    incentives: parseMoney(input.incentives ?? 0, 'Incentives'),
    other: parseMoney(input.other ?? 0, 'Other earnings'),
    professionalTax: parseMoney(input.professionalTax ?? 0, 'Professional tax'),
    tds: parseMoney(input.tds ?? 0, 'TDS'),
    employeeWelfare: parseMoney(input.employeeWelfare ?? 0, 'Employee welfare'),
    kpi: parseMoney(input.kpi ?? 0, 'KPI'),
    otherDeductions: parseMoney(input.otherDeductions ?? 0, 'Other deductions'),
    effectiveFrom: (input.effectiveFrom?.slice(0, 10) || fallbackDate),
  };
}

export function compensationInsertRow(employeeId: string, input: CompensationInput) {
  return {
    employee_id: employeeId,
    basic: input.basic,
    da: input.da,
    hra: input.hra,
    fuel: input.fuel,
    incentives: input.incentives,
    other_earnings: input.other,
    professional_tax: input.professionalTax,
    tds: input.tds,
    employee_welfare: input.employeeWelfare,
    kpi: input.kpi,
    other_deductions: input.otherDeductions,
    effective_from: input.effectiveFrom,
  };
}

export function normalizePayment(input: PaymentInput): PaymentInput {
  const pan = input.pan?.trim().toUpperCase() || null;
  const ifsc = input.ifsc?.trim().toUpperCase() || null;
  const bankAccountNumber = input.bankAccountNumber?.trim() || null;
  const bankName = input.bankName?.trim() || null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'PAN must be 10 characters (AAAAA9999A).', 400);
  }
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'IFSC must be 11 characters.', 400);
  }
  return { pan, bankAccountNumber, bankName, ifsc };
}

function canViewPayroll(actor: RequestUser): boolean {
  return (
    actor.permissions.includes(PERMISSIONS.PAYROLL_VIEW) ||
    actor.permissions.includes(PERMISSIONS.PAYROLL_MANAGE) ||
    actor.permissions.includes(PERMISSIONS.USERS_VIEW) ||
    actor.permissions.includes(PERMISSIONS.USERS_MANAGE)
  );
}


function currentOf(rows: CompensationRecord[]): CompensationRecord | null {
  const today = new Date().toISOString().slice(0, 10);
  return rows.find((row) => row.effectiveFrom <= today) ?? rows[0] ?? null;
}

export function createEmployeeMasterService(supabase: SupabaseClient) {
  return {
    async getPayroll(actor: RequestUser, employeeId: string): Promise<EmployeePayroll> {
      if (!canViewPayroll(actor) && actor.employeeId !== employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view payroll details.', 403);
      }
      const [{ data: compensationRows, error: compensationError }, { data: paymentRow, error: paymentError }] =
        await Promise.all([
          supabase
            .from('employee_compensation')
            .select('*')
            .eq('employee_id', employeeId)
            .order('effective_from', { ascending: false }),
          supabase.from('employee_payment').select('*').eq('employee_id', employeeId).maybeSingle(),
        ]);
      if (compensationError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensation.', 500);
      }
      if (paymentError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank details.', 500);
      }
      const history = ((compensationRows ?? []) as CompensationRow[]).map(mapCompensation);
      return {
        current: currentOf(history),
        history,
        payment: paymentRow ? mapPayment(paymentRow as PaymentRow) : null,
      };
    },

    async saveCompensation(
      actor: RequestUser,
      employeeId: string,
      input: Partial<CompensationInput>,
      meta: RequestMeta,
    ): Promise<CompensationRecord> {
      if (!canWriteDirectoryMasterPay(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only HR Manager can update compensation.', 403);
      }
      const normalized = normalizeCompensation(input, new Date().toISOString().slice(0, 10));
      const { data: existing } = await supabase
        .from('employee_compensation')
        .select('*')
        .eq('employee_id', employeeId)
        .eq('effective_from', normalized.effectiveFrom)
        .maybeSingle();

      const row = compensationInsertRow(employeeId, normalized);
      let saved: CompensationRow;
      if (existing) {
        const { data, error } = await supabase
          .from('employee_compensation')
          .update(row)
          .eq('id', (existing as CompensationRow).id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update compensation.', 500);
        }
        saved = data as CompensationRow;
      } else {
        const { data, error } = await supabase.from('employee_compensation').insert(row).select('*').single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to save compensation.', 500);
        }
        saved = data as CompensationRow;
      }

      const mapped = mapCompensation(saved);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: existing ? 'employee.compensation_update' : 'employee.compensation_create',
        entityType: 'employee',
        entityId: employeeId,
        newValues: mapped,
        ...meta,
      });
      return mapped;
    },

    async savePayment(
      actor: RequestUser,
      employeeId: string,
      input: PaymentInput,
      meta: RequestMeta,
    ): Promise<PaymentRecord> {
      if (!canWriteDirectoryMasterPay(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only HR Manager can update bank details.', 403);
      }
      const normalized = normalizePayment(input);
      const { data, error } = await supabase
        .from('employee_payment')
        .upsert(
          {
            employee_id: employeeId,
            pan: normalized.pan,
            bank_account_number: normalized.bankAccountNumber,
            bank_name: normalized.bankName,
            ifsc: normalized.ifsc,
          },
          { onConflict: 'employee_id' },
        )
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to save bank details.', 500);
      }
      const mapped = mapPayment(data as PaymentRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.payment_update',
        entityType: 'employee',
        entityId: employeeId,
        newValues: maskPayment(mapped),
        ...meta,
      });
      return mapped;
    },
  };
}
