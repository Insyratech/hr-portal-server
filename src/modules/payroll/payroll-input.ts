import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { datesInPeriod, parsePeriod } from '../attendance/import/period';
import { mapCompensation } from '../employees/master';
import {
  durationDays,
  emptyParticulars,
  leaveCodeBucket,
  type CompensationParts,
  type LeaveParticulars,
} from './calc';

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function buildParticulars(
  days: Record<string, unknown>[],
  typeByName: Map<string, string>,
): LeaveParticulars {
  const particulars = emptyParticulars();
  const permissionDates = new Set<string>();
  for (const day of days) {
    particulars.totalLop += Number(day.final_lop ?? 0);
    if (day.status === 'MISSING_PUNCH') particulars.missPunch += 1;
    if (day.status === 'ABSENT') particulars.absent += 1;
    if (day.status === 'LATE') particulars.lateDays += 1;
    const minutes = Number(day.permission_minutes ?? 0);
    if (minutes > 0) {
      permissionDates.add(day.attendance_date as string);
      particulars.permissionHours += minutes / 60;
    }
    const name = (day.leave_type_name as string | null) ?? null;
    if (name) {
      const code = typeByName.get(name.toLowerCase()) ?? null;
      const bucket = leaveCodeBucket(code, name);
      if (bucket === 'cl' || bucket === 'sl' || bucket === 'ml' || bucket === 'el' || bucket === 'maternityPaternity') {
        particulars[bucket] += durationDays(day.leave_duration as string | null);
      }
    }
  }
  particulars.permissionsCount = permissionDates.size;
  particulars.permissionHours = Math.round(particulars.permissionHours * 100) / 100;
  particulars.totalLop = Math.round(particulars.totalLop * 100) / 100;
  return particulars;
}

export type PayrollEmployeeInput = {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  companyName: string | null;
  lopDays: number;
  compensation: CompensationParts | null;
  ready: boolean;
  skipReason: string | null;
};

export type LoadedPayrollInput = {
  imp: Record<string, unknown>;
  period: ReturnType<typeof parsePeriod>;
  existingRun: Record<string, unknown> | null;
  calendarDays: number;
  employees: PayrollEmployeeInput[];
  compByEmployee: Map<string, CompensationParts>;
  payByEmployee: Map<string, Record<string, unknown>>;
  employeeRows: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  typeByName: Map<string, string>;
};

export async function loadPayrollInput(supabase: SupabaseClient, importId: string): Promise<LoadedPayrollInput> {
  const { data: imp, error: impError } = await supabase
    .from('attendance_imports')
    .select('*')
    .eq('id', importId)
    .maybeSingle();
  if (impError || !imp) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Attendance import not found.', 404);
  if (imp.status !== 'CONFIRMED') {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Confirm the attendance month before calculating payroll.', 400);
  }

  const period = parsePeriod(imp.period as string);
  const { data: existing } = await supabase.from('payroll_runs').select('*').eq('period', period.key).maybeSingle();
  if (existing?.status === 'PUBLISHED') {
    throw new AppError(API_ERROR_CODES.CONFLICT, `Payroll for ${period.label} is already published.`, 409);
  }

  const { data: reviews, error: reviewError } = await supabase
    .from('attendance_day_reviews')
    .select('*')
    .eq('import_id', imp.id);
  if (reviewError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load attendance reviews.', 500);

  const employeeIds = [...new Set((reviews ?? []).map((row) => row.employee_id as string))];
  if (employeeIds.length === 0) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This import has no employee reviews to pay.', 400);
  }

  const [{ data: employeeRows }, { data: compensationRows }, { data: payments }, { data: types }] = await Promise.all([
    supabase
      .from('employees')
      .select('id, employee_code, full_name, company_id, designation_id, department_id, user_id, companies (name, address, logo_storage_path), designations (name), departments (name)')
      .in('id', employeeIds),
    supabase
      .from('employee_compensation')
      .select('*')
      .in('employee_id', employeeIds)
      .lte('effective_from', period.end)
      .order('effective_from', { ascending: false }),
    supabase.from('employee_payment').select('*').in('employee_id', employeeIds),
    supabase.from('leave_types').select('code, name'),
  ]);

  const typeByName = new Map((types ?? []).map((row) => [(row.name as string).toLowerCase(), row.code as string]));
  const payByEmployee = new Map((payments ?? []).map((row) => [row.employee_id as string, row as Record<string, unknown>]));
  const compByEmployee = new Map<string, CompensationParts>();
  for (const row of compensationRows ?? []) {
    const id = row.employee_id as string;
    if (compByEmployee.has(id)) continue;
    if (!employeeIds.includes(id)) continue;
    const mapped = mapCompensation(row as never);
    compByEmployee.set(id, {
      basic: mapped.basic,
      da: mapped.da,
      hra: mapped.hra,
      fuel: mapped.fuel,
      incentives: mapped.incentives,
      other: mapped.other,
      professionalTax: mapped.professionalTax,
      tds: mapped.tds,
      employeeWelfare: mapped.employeeWelfare,
      kpi: mapped.kpi,
      otherDeductions: mapped.otherDeductions,
    });
  }

  const calendarDays = datesInPeriod(period.key).length;
  const employees: PayrollEmployeeInput[] = (employeeRows ?? []).map((emp) => {
    const company = firstRel(
      emp.companies as { name: string } | { name: string }[] | null,
    );
    const compensation = compByEmployee.get(emp.id as string) ?? null;
    const days = (reviews ?? []).filter((row) => row.employee_id === emp.id);
    const particulars = buildParticulars(days, typeByName);
    if (!company) {
      return {
        employeeId: emp.id as string,
        employeeCode: emp.employee_code as string,
        fullName: emp.full_name as string,
        companyName: null,
        lopDays: particulars.totalLop,
        compensation: null,
        ready: false,
        skipReason: 'No company assigned.',
      };
    }
    if (!compensation) {
      return {
        employeeId: emp.id as string,
        employeeCode: emp.employee_code as string,
        fullName: emp.full_name as string,
        companyName: company.name,
        lopDays: particulars.totalLop,
        compensation: null,
        ready: false,
        skipReason: 'No compensation on file.',
      };
    }
    return {
      employeeId: emp.id as string,
      employeeCode: emp.employee_code as string,
      fullName: emp.full_name as string,
      companyName: company.name,
      lopDays: particulars.totalLop,
      compensation,
      ready: true,
      skipReason: null,
    };
  });

  employees.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return {
    imp,
    period,
    existingRun: existing ?? null,
    calendarDays,
    employees,
    compByEmployee,
    payByEmployee,
    employeeRows: employeeRows ?? [],
    reviews: reviews ?? [],
    typeByName,
  };
}
