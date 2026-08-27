import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isGmDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { datesInPeriod, parsePeriod } from '../attendance/import/period';
import { mapCompensation } from '../employees/master';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, notifyStaff } from '../notifications/notify-staff';
import {
  calculateSlipMoney,
  durationDays,
  emptyParticulars,
  leaveCodeBucket,
  snapshotPayment,
  type CompensationParts,
  type LeaveParticulars,
} from './calc';
import { letterheadFromCompany } from './letterhead';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

const LOGO_BUCKET = 'company-logos';

function canView(actor: RequestUser): boolean {
  return actor.permissions.includes(PERMISSIONS.PAYROLL_VIEW) || actor.permissions.includes(PERMISSIONS.PAYROLL_MANAGE);
}

function canManage(actor: RequestUser): boolean {
  return isGmDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.PAYROLL_MANAGE);
}

function requireView(actor: RequestUser): void {
  if (!canView(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view payroll.', 403);
  }
}

function requireManage(actor: RequestUser): void {
  if (!canManage(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot run payroll.', 403);
  }
}

async function signedLogo(supabase: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(LOGO_BUCKET).createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function createPayrollService(supabase: SupabaseClient) {
  return {
    async listRuns(actor: RequestUser) {
      requireView(actor);
      const publishedOnly = !canManage(actor);
      let query = supabase.from('payroll_runs').select('*').order('period', { ascending: false });
      if (publishedOnly) query = query.eq('status', 'PUBLISHED');
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payroll runs.', 500);
      return (data ?? []).map(mapRun);
    },

    async listConfirmedImports(actor: RequestUser) {
      requireManage(actor);
      const { data, error } = await supabase
        .from('attendance_imports')
        .select('id, period, file_name, status, confirmed_at')
        .eq('status', 'CONFIRMED')
        .order('period', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load confirmed months.', 500);
      const { data: runs } = await supabase.from('payroll_runs').select('period, status, attendance_import_id');
      const byPeriod = new Map((runs ?? []).map((row) => [row.period as string, row]));
      return (data ?? []).map((row) => {
        const run = byPeriod.get(row.period as string);
        return {
          importId: row.id as string,
          period: row.period as string,
          fileName: row.file_name as string,
          confirmedAt: (row.confirmed_at as string | null) ?? null,
          payrollStatus: (run?.status as string | null) ?? null,
          payrollLocked: run?.status === 'PUBLISHED',
        };
      });
    },

    async getRun(actor: RequestUser, id: string) {
      requireView(actor);
      const { data: run, error } = await supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle();
      if (error || !run) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Payroll run not found.', 404);
      if (!canManage(actor) && run.status !== 'PUBLISHED') {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only published payroll is visible.', 403);
      }
      const { data: slips, error: slipError } = await supabase
        .from('salary_slips')
        .select('*')
        .eq('run_id', id)
        .order('company_name')
        .order('employee_name');
      if (slipError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load salary slips.', 500);
      const mapped = await Promise.all((slips ?? []).map((row) => mapSlip(supabase, row, run.period as string)));
      const companies = [...new Set(mapped.map((item) => item.companyName))];
      return { run: mapRun(run), companies, slips: mapped };
    },

    async getSlip(actor: RequestUser, id: string) {
      const { data: slip, error } = await supabase.from('salary_slips').select('*').eq('id', id).maybeSingle();
      if (error || !slip) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Salary slip not found.', 404);
      const { data: run } = await supabase.from('payroll_runs').select('*').eq('id', slip.run_id).maybeSingle();
      if (!run) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Payroll run not found.', 404);

      const own = slip.employee_id === actor.employeeId && run.status === 'PUBLISHED';
      if (!own && !canView(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this salary slip.', 403);
      }
      if (!canManage(actor) && run.status !== 'PUBLISHED') {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This slip is not published yet.', 403);
      }
      return mapSlip(supabase, slip, run.period as string);
    },

    async listMine(actor: RequestUser) {
      const { data, error } = await supabase
        .from('salary_slips')
        .select('*, payroll_runs (period, status, published_at)')
        .eq('employee_id', actor.employeeId)
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payslips.', 500);
      const rows = (data ?? []).filter((row) => {
        const run = firstRel(row.payroll_runs as { status?: string } | { status?: string }[]);
        return run?.status === 'PUBLISHED';
      });
      return Promise.all(
        rows.map(async (row) => {
          const run = firstRel(row.payroll_runs as { period?: string } | { period?: string }[]);
          return mapSlip(supabase, row, run?.period ?? '');
        }),
      );
    },

    async calculate(actor: RequestUser, input: { importId: string }, meta: RequestMeta) {
      requireManage(actor);
      const { data: imp, error: impError } = await supabase
        .from('attendance_imports')
        .select('*')
        .eq('id', input.importId)
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

      let runId: string;
      if (existing) {
        const { data: updated, error } = await supabase
          .from('payroll_runs')
          .update({
            attendance_import_id: imp.id,
            status: 'DRAFT',
            calculated_at: null,
            calculated_by: actor.employeeId,
          })
          .eq('id', existing.id)
          .select('id')
          .single();
        if (error || !updated) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reset the payroll run.', 500);
        runId = updated.id as string;
        await supabase.from('salary_slips').delete().eq('run_id', runId);
      } else {
        const { data: created, error } = await supabase
          .from('payroll_runs')
          .insert({
            period: period.key,
            attendance_import_id: imp.id,
            status: 'DRAFT',
            calculated_by: actor.employeeId,
          })
          .select('id')
          .single();
        if (error || !created) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create the payroll run.', 500);
        runId = created.id as string;
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

      const [{ data: employees }, { data: compensationRows }, { data: payments }, { data: types }] = await Promise.all([
        supabase
          .from('employees')
          .select('id, employee_code, full_name, company_id, designation_id, department_id, user_id, companies (name, address, logo_storage_path), designations (name), departments (name)')
          .in('id', employeeIds),
        supabase.from('employee_compensation').select('*').in('employee_id', employeeIds).lte('effective_from', period.end).order('effective_from', { ascending: false }),
        supabase.from('employee_payment').select('*').in('employee_id', employeeIds),
        supabase.from('leave_types').select('code, name'),
      ]);

      const typeByName = new Map((types ?? []).map((row) => [(row.name as string).toLowerCase(), row.code as string]));
      const payByEmployee = new Map((payments ?? []).map((row) => [row.employee_id as string, row]));
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
      const skipped: { employeeId: string; name: string; reason: string }[] = [];
      const inserts: Record<string, unknown>[] = [];

      for (const emp of employees ?? []) {
        const company = firstRel(emp.companies as { name: string; address: string; logo_storage_path: string | null } | { name: string; address: string; logo_storage_path: string | null }[]);
        const compensation = compByEmployee.get(emp.id as string);
        if (!company) {
          skipped.push({ employeeId: emp.id as string, name: emp.full_name as string, reason: 'No company assigned.' });
          continue;
        }
        if (!compensation) {
          skipped.push({ employeeId: emp.id as string, name: emp.full_name as string, reason: 'No compensation on file.' });
          continue;
        }
        const days = (reviews ?? []).filter((row) => row.employee_id === emp.id);
        const particulars = buildParticulars(days, typeByName);
        const money = calculateSlipMoney({
          compensation,
          calendarDays,
          lopDays: particulars.totalLop,
        });
        const payment = snapshotPayment({
          pan: (payByEmployee.get(emp.id as string)?.pan as string | null) ?? null,
          bankAccountNumber: (payByEmployee.get(emp.id as string)?.bank_account_number as string | null) ?? null,
          bankName: (payByEmployee.get(emp.id as string)?.bank_name as string | null) ?? null,
          ifsc: (payByEmployee.get(emp.id as string)?.ifsc as string | null) ?? null,
        });
        const designation = firstRel(emp.designations as { name: string } | { name: string }[]);
        const department = firstRel(emp.departments as { name: string } | { name: string }[]);
        const letterhead = letterheadFromCompany({
          name: company.name,
          address: company.address,
          logoStoragePath: company.logo_storage_path,
        });
        inserts.push({
          run_id: runId,
          employee_id: emp.id,
          employee_code: emp.employee_code,
          employee_name: emp.full_name,
          designation_name: designation?.name ?? null,
          department_name: department?.name ?? null,
          company_name: letterhead.companyName,
          company_address: letterhead.companyAddress,
          company_logo_path: letterhead.companyLogoPath,
          pan_masked: payment.panMasked,
          bank_account_masked: payment.bankAccountMasked,
          bank_name_masked: payment.bankNameMasked,
          ifsc_masked: payment.ifscMasked,
          basic: compensation.basic,
          da: compensation.da,
          hra: compensation.hra,
          fuel: compensation.fuel,
          incentives: compensation.incentives,
          other_earnings: compensation.other,
          professional_tax: compensation.professionalTax,
          tds: compensation.tds,
          employee_welfare: compensation.employeeWelfare,
          kpi: compensation.kpi,
          other_deductions: compensation.otherDeductions,
          calendar_days: calendarDays,
          gross: money.gross,
          daily_rate: money.dailyRate,
          lop_days: particulars.totalLop,
          lop_amount: money.lopAmount,
          net: money.net,
          particulars,
        });
      }

      for (let i = 0; i < inserts.length; i += 200) {
        const { error } = await supabase.from('salary_slips').insert(inserts.slice(i, i + 200));
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save salary slips.', 500);
      }

      const { data: calculated, error: calcError } = await supabase
        .from('payroll_runs')
        .update({
          status: 'CALCULATED',
          calculated_at: new Date().toISOString(),
          calculated_by: actor.employeeId,
          attendance_import_id: imp.id,
        })
        .eq('id', runId)
        .select('*')
        .single();
      if (calcError || !calculated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to mark payroll as calculated.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'payroll.calculate',
        entityType: 'payroll_run',
        entityId: runId,
        newValues: { period: period.key, slips: inserts.length, skipped: skipped.length },
        ...meta,
      });

      const bundle = await this.getRun(actor, runId);
      return { ...bundle, skipped };
    },

    async publish(actor: RequestUser, id: string, meta: RequestMeta) {
      requireManage(actor);
      const { data: run, error } = await supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle();
      if (error || !run) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Payroll run not found.', 404);
      if (run.status === 'PUBLISHED') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This payroll run is already published.', 409);
      }
      if (run.status !== 'CALCULATED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Calculate payroll before publishing.', 400);
      }

      const { data: published, error: pubError } = await supabase
        .from('payroll_runs')
        .update({
          status: 'PUBLISHED',
          published_at: new Date().toISOString(),
          published_by: actor.employeeId,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (pubError || !published) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to publish payroll.', 500);

      const { data: slips } = await supabase.from('salary_slips').select('id, employee_id').eq('run_id', id);
      const period = parsePeriod(run.period as string);
      for (const slip of slips ?? []) {
        const person = await loadStaffById(supabase, slip.employee_id as string);
        await notifyStaff(supabase, person, {
          type: 'payroll',
          title: `${period.monthName} salary slip`,
          message: `Your ${period.monthName} salary slip is published. Open it to view or print.`,
          referenceType: 'salary_slip',
          referenceId: slip.id as string,
          eyebrow: 'Payroll',
          paragraphs: [
            `HR published salary slips for ${period.label}.`,
            'Sign in and open your slip to view or print it.',
          ],
          ctaLabel: 'Open salary slip',
          ctaHref: portalUrl(`/payslips/${slip.id as string}`),
        });
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'payroll.publish',
        entityType: 'payroll_run',
        entityId: id,
        newValues: { period: run.period },
        ...meta,
      });
      return this.getRun(actor, id);
    },
  };
}

function buildParticulars(
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

function mapRun(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    period: row.period as string,
    attendanceImportId: (row.attendance_import_id as string | null) ?? null,
    status: row.status as string,
    calculatedAt: (row.calculated_at as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

async function mapSlip(supabase: SupabaseClient, row: Record<string, unknown>, period: string) {
  const bounds = period ? parsePeriod(period) : null;
  return {
    id: row.id as string,
    runId: row.run_id as string,
    employeeId: row.employee_id as string,
    period,
    monthLabel: bounds?.label ?? period,
    employeeCode: row.employee_code as string,
    employeeName: row.employee_name as string,
    designationName: (row.designation_name as string | null) ?? null,
    departmentName: (row.department_name as string | null) ?? null,
    companyName: row.company_name as string,
    companyAddress: row.company_address as string,
    companyLogoPath: (row.company_logo_path as string | null) ?? null,
    companyLogoUrl: await signedLogo(supabase, (row.company_logo_path as string | null) ?? null),
    panMasked: (row.pan_masked as string | null) ?? null,
    bankAccountMasked: (row.bank_account_masked as string | null) ?? null,
    bankNameMasked: (row.bank_name_masked as string | null) ?? null,
    ifscMasked: (row.ifsc_masked as string | null) ?? null,
    basic: Number(row.basic),
    da: Number(row.da),
    hra: Number(row.hra),
    fuel: Number(row.fuel),
    incentives: Number(row.incentives),
    other: Number(row.other_earnings),
    professionalTax: Number(row.professional_tax),
    tds: Number(row.tds),
    employeeWelfare: Number(row.employee_welfare),
    kpi: Number(row.kpi),
    otherDeductions: Number(row.other_deductions),
    calendarDays: Number(row.calendar_days),
    gross: Number(row.gross),
    dailyRate: Number(row.daily_rate),
    lopDays: Number(row.lop_days),
    lopAmount: Number(row.lop_amount),
    net: Number(row.net),
    particulars: (row.particulars as LeaveParticulars) ?? emptyParticulars(),
  };
}
