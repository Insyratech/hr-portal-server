import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../../shared/constants/error-codes';
import { PERMISSIONS } from '../../../shared/constants/permissions';
import { isGmDomainOwner } from '../../../shared/domain-owners';
import { AppError } from '../../../shared/errors/app-error';
import type { RequestUser } from '../../../shared/types/request-user';
import { writeAuditLog } from '../../audit/write-audit-log';
import { portalUrl } from '../../notifications/mail';
import { listActiveStaff, notifyStaff } from '../../notifications/notify-staff';
import { combineDateAndTime, deriveAttendance } from '../rule-engine';
import { ATTENDANCE_RULES_VERSION, adjustPunchClock } from '../punch-clock';
import { toShiftDefinition, type ShiftRow } from '../support';
import { loadHolidayDates, loadWorkingDays } from '../../leave/support';
import { listWorkWeekRows } from '../work-week';
import { patternOnDate } from '../../leave/day-count';
import { MONTHLY_QUOTA_MINUTES, remainingLabel, remainingMinutes, quotaUsed } from '../../work-permissions/quota';
import { firstAndLast, parseBiometricGrid } from './parser';
import { buildEmployeeLookup, matchEmployee } from './employee-match';
import { lopFromAction, proposeLop, untouchedFlagCount, effectiveDayLop, type HrAction, type LeaveOverlay } from './lop-proposal';
import { datesInPeriod, parsePeriod } from './period';
import { decodeBase64File, gridFromXlsx, bufferForStorage } from './workbook';
import { listApprovedShiftOverrides } from '../../shift-changes/service';
import { ATTENDANCE_IMPORT_BUCKET, originalExcelPath } from './storage-path';
import { isExcelFileName } from './excel-file';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type EmployeeRow = {
  id: string;
  employee_code: string;
  full_name: string;
  user_id: string | null;
  companies?: { name: string } | { name: string }[] | null;
};

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type AssignmentRow = {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  shifts: ShiftRow | ShiftRow[] | null;
};

function shiftOnDate(assignments: AssignmentRow[], employeeId: string, iso: string): ShiftRow | null {
  const current = assignments
    .filter(
      (row) =>
        row.employee_id === employeeId &&
        row.effective_from <= iso &&
        (!row.effective_to || row.effective_to >= iso),
    )
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  return current ? firstRel(current.shifts) : null;
}

function shiftForDay(
  assignments: AssignmentRow[],
  shiftById: Map<string, ShiftRow>,
  overrides: { employeeId: string; startDate: string; endDate: string; shiftId: string }[],
  employeeId: string,
  iso: string,
): ShiftRow | null {
  const overrideId = overrides.find(
    (row) => row.employeeId === employeeId && row.startDate <= iso && row.endDate >= iso,
  )?.shiftId;
  if (overrideId) {
    return shiftById.get(overrideId) ?? null;
  }
  return shiftOnDate(assignments, employeeId, iso);
}

function requireManage(actor: RequestUser): void {
  if (!isGmDomainOwner(actor) || !actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage attendance imports.', 403);
  }
}

function requireView(actor: RequestUser): void {
  if (
    !actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE) &&
    !actor.permissions.includes(PERMISSIONS.USERS_VIEW)
  ) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view attendance imports.', 403);
  }
}

async function payrollPublished(supabase: SupabaseClient, period: string): Promise<boolean> {
  const { data } = await supabase
    .from('payroll_runs')
    .select('id')
    .eq('period', period)
    .eq('status', 'PUBLISHED')
    .maybeSingle();
  return Boolean(data);
}

async function supersedePeriod(supabase: SupabaseClient, period: string): Promise<void> {
  await supabase
    .from('attendance_imports')
    .update({ status: 'REJECTED' })
    .eq('period', period)
    .neq('status', 'REJECTED');
}

function importRulesVersion(row: Record<string, unknown>): number {
  return Number(row.rules_version ?? 0);
}

function needsRulesRefresh(imp: Record<string, unknown>): boolean {
  const status = imp.status as string;
  if (status !== 'IN_REVIEW' && status !== 'PARSED') return false;
  return importRulesVersion(imp) < ATTENDANCE_RULES_VERSION;
}

function dayReviewChanged(
  row: Record<string, unknown>,
  next: {
    status: string;
    shift_name: string | null;
    actual_in: string | null;
    actual_out: string | null;
    worked_minutes: number | null;
    late_minutes: number;
    permission_minutes: number;
    permission_covered: boolean;
    leave_type_name: string | null;
    leave_paid: boolean | null;
    leave_duration: string | null;
    proposed_lop: number;
    final_lop: number;
    hr_action: string | null;
    needs_hr_decision: boolean;
    skipped_from_lop: boolean;
  },
): boolean {
  const sameIso = (value: unknown, expected: string | null) => {
    if (!expected) return value == null || value === '';
    if (value == null) return false;
    return new Date(String(value)).toISOString() === expected;
  };
  return !(
    row.status === next.status &&
    (row.shift_name ?? null) === next.shift_name &&
    sameIso(row.actual_in, next.actual_in) &&
    sameIso(row.actual_out, next.actual_out) &&
    Number(row.worked_minutes ?? 0) === Number(next.worked_minutes ?? 0) &&
    Number(row.late_minutes ?? 0) === next.late_minutes &&
    Number(row.permission_minutes ?? 0) === next.permission_minutes &&
    Boolean(row.permission_covered) === next.permission_covered &&
    (row.leave_type_name ?? null) === next.leave_type_name &&
    (row.leave_paid ?? null) === next.leave_paid &&
    (row.leave_duration ?? null) === next.leave_duration &&
    Number(row.proposed_lop ?? 0) === next.proposed_lop &&
    Number(row.final_lop ?? 0) === next.final_lop &&
    (row.hr_action ?? null) === next.hr_action &&
    Boolean(row.needs_hr_decision) === next.needs_hr_decision &&
    Boolean(row.skipped_from_lop) === next.skipped_from_lop
  );
}

/**
 * Re-apply attendance rules + approved permissions on open imports (batched).
 * Keeps days where HR typed an override reason. Call only when rules_version is behind.
 * Pass employeeId to refresh a single card without stamping the import.
 */
async function refreshOpenImportDayReviews(
  supabase: SupabaseClient,
  importId: string,
  periodKey: string,
  options?: { employeeId?: string; stampVersion?: boolean },
): Promise<void> {
  const period = parsePeriod(periodKey);
  let reviewQuery = supabase.from('attendance_day_reviews').select('*').eq('import_id', importId);
  if (options?.employeeId) {
    reviewQuery = reviewQuery.eq('employee_id', options.employeeId);
  }
  const { data: reviews, error: reviewError } = await reviewQuery;
  if (reviewError || !reviews?.length) return;

  let punchQuery = supabase
    .from('attendance_import_rows')
    .select('employee_id, attendance_date, raw_in, raw_out')
    .eq('import_id', importId)
    .not('employee_id', 'is', null);
  if (options?.employeeId) {
    punchQuery = punchQuery.eq('employee_id', options.employeeId);
  }
  const { data: punchRows } = await punchQuery;

  const punches = new Map<string, { inTime: string | null; outTime: string | null }>();
  for (const row of punchRows ?? []) {
    const employeeId = row.employee_id as string;
    const iso = dateOnly(String(row.attendance_date));
    punches.set(`${employeeId}:${iso}`, {
      inTime: (row.raw_in as string | null) ?? null,
      outTime: (row.raw_out as string | null) ?? null,
    });
  }

  const workingDays = await loadWorkingDays(supabase);
  const holidayDates = await loadHolidayDates(supabase);
  const workWeeks = await listWorkWeekRows(supabase);
  let leaveQuery = supabase
    .from('leave_applications')
    .select('employee_id, start_date, end_date, duration, leave_types (name, paid)')
    .eq('status', 'APPROVED')
    .lte('start_date', period.end)
    .gte('end_date', period.start);
  if (options?.employeeId) {
    leaveQuery = leaveQuery.eq('employee_id', options.employeeId);
  }
  const { data: leaves } = await leaveQuery;
  let permissionQuery = supabase
    .from('work_permissions')
    .select('employee_id, permission_date, minutes, status, slot')
    .gte('permission_date', period.start)
    .lte('permission_date', period.end);
  if (options?.employeeId) {
    permissionQuery = permissionQuery.eq('employee_id', options.employeeId);
  }
  const { data: permissions } = await permissionQuery;
  let assignmentQuery = supabase
    .from('shift_assignments')
    .select('employee_id, effective_from, effective_to, shifts (*)');
  if (options?.employeeId) {
    assignmentQuery = assignmentQuery.eq('employee_id', options.employeeId);
  }
  const { data: assignmentRows } = await assignmentQuery;
  const assignments = (assignmentRows ?? []) as AssignmentRow[];
  const overrides = await listApprovedShiftOverrides(supabase, period.start, period.end);
  const { data: allShifts } = await supabase.from('shifts').select('*');
  const shiftById = new Map(((allShifts ?? []) as ShiftRow[]).map((row) => [row.id, row]));

  const updates: Record<string, unknown>[] = [];
  for (const row of reviews) {
    const employeeId = row.employee_id as string;
    const iso = dateOnly(String(row.attendance_date));
    const shift = shiftForDay(assignments, shiftById, overrides, employeeId, iso);
    const shiftName = shift?.name ?? null;

    // Preserve manager LOP decisions, but always keep shift label in sync with assignments.
    if (String(row.reason ?? '').trim() || row.hr_action) {
      if ((row.shift_name ?? null) !== shiftName) {
        updates.push({ id: row.id as string, shift_name: shiftName });
      }
      continue;
    }

    const punch = punches.get(`${employeeId}:${iso}`);
    const leave = leaveOnDate(leaves ?? [], employeeId, iso);
    const permission = approvedPermission(permissions ?? [], employeeId, iso);
    const rawIn = punch?.inTime ? combineDateAndTime(iso, punch.inTime) : null;
    const rawOut = punch?.outTime ? combineDateAndTime(iso, punch.outTime) : null;
    const actualIn = adjustPunchClock(rawIn);
    const actualOut = adjustPunchClock(rawOut);
    const derived = deriveAttendance({
      isoDate: iso,
      workingDays,
      holidayDates,
      weekPattern: patternOnDate(workWeeks, employeeId, iso),
      onApprovedLeave: Boolean(leave),
      shift: shift ? toShiftDefinition(shift) : null,
      actualIn,
      actualOut,
      permissionMinutes: permission.minutes,
    });
    const proposal = proposeLop({
      derived,
      permissionMinutes: permission.minutes,
      permissionSlot: permission.slot,
      leave,
    });
    const next = {
      status: derived.status,
      shift_name: shiftName,
      actual_in: actualIn?.toISOString() ?? null,
      actual_out: actualOut?.toISOString() ?? null,
      worked_minutes: derived.workedMinutes,
      late_minutes: derived.lateMinutes,
      permission_minutes: permission.minutes,
      permission_covered: proposal.permissionCovered,
      leave_type_name: leave?.typeName ?? null,
      leave_paid: leave ? leave.paid : null,
      leave_duration: leave?.duration ?? null,
      proposed_lop: Number(proposal.proposedLop ?? 0),
      final_lop: Number(proposal.finalLop ?? 0),
      hr_action: proposal.hrAction,
      needs_hr_decision: proposal.needsHrDecision,
      skipped_from_lop: proposal.skippedFromLop,
    };
    if (!dayReviewChanged(row, next)) continue;
    updates.push({ id: row.id as string, ...next });
  }

  for (let i = 0; i < updates.length; i += 25) {
    const chunk = updates.slice(i, i + 25);
    const results = await Promise.all(
      chunk.map(({ id, ...fields }) =>
        supabase.from('attendance_day_reviews').update(fields).eq('id', id as string),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to refresh attendance day reviews.', 500);
    }
  }

  if (options?.stampVersion !== false && !options?.employeeId) {
    const { error: stampError } = await supabase
      .from('attendance_imports')
      .update({ rules_version: ATTENDANCE_RULES_VERSION })
      .eq('id', importId);
    // Ignore missing-column until migration 079 is applied; in-memory cache still gates repeats.
    void stampError;
  }
}

const refreshedImportIds = new Set<string>();
const refreshedEmployeeKeys = new Set<string>();

function refreshCacheKey(importId: string, employeeId?: string): string {
  return employeeId
    ? `${ATTENDANCE_RULES_VERSION}:${importId}:${employeeId}`
    : `${ATTENDANCE_RULES_VERSION}:${importId}`;
}

async function maybeRefreshOpenImportRules(
  supabase: SupabaseClient,
  imp: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const importId = imp.id as string;
  if (!needsRulesRefresh(imp)) return imp;
  const cacheKey = refreshCacheKey(importId);
  if (refreshedImportIds.has(cacheKey)) {
    return { ...imp, rules_version: ATTENDANCE_RULES_VERSION };
  }
  await refreshOpenImportDayReviews(supabase, importId, imp.period as string);
  refreshedImportIds.add(cacheKey);
  return { ...imp, rules_version: ATTENDANCE_RULES_VERSION };
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(11, 16);
}

export function createAttendanceImportService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser) {
      requireView(actor);
      const { data, error } = await supabase
        .from('attendance_imports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load imports.', 500);
      return (data ?? []).map(mapImport);
    },

    async get(actor: RequestUser, id: string) {
      requireView(actor);
      const { data: rawImp, error } = await supabase.from('attendance_imports').select('*').eq('id', id).maybeSingle();
      if (error || !rawImp) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Import not found.', 404);
      const imp = await maybeRefreshOpenImportRules(supabase, rawImp as Record<string, unknown>);

      const { data: rowData } = await supabase.from('attendance_import_rows').select('*').eq('import_id', id);
      const { data: reviews } = await supabase
        .from('attendance_day_reviews')
        .select('*')
        .eq('import_id', id)
        .order('attendance_date');

      const daysByEmployee = new Map<string, Record<string, unknown>[]>();
      for (const row of reviews ?? []) {
        const employeeId = row.employee_id as string;
        const list = daysByEmployee.get(employeeId);
        if (list) list.push(row);
        else daysByEmployee.set(employeeId, [row]);
      }
      const employeeIds = [...daysByEmployee.keys()];
      const { data: employees } = employeeIds.length
        ? await supabase
            .from('employees')
            .select('id, employee_code, full_name, companies (name)')
            .in('id', employeeIds)
        : { data: [] as EmployeeRow[] };

      const employeeMap = new Map((employees ?? []).map((row) => [row.id as string, row as EmployeeRow]));
      const period = parsePeriod(imp.period as string);
      const { data: monthPermissions } = await supabase
        .from('work_permissions')
        .select('employee_id, minutes, status')
        .gte('permission_date', period.start)
        .lte('permission_date', period.end);
      const usedByEmployee = new Map<string, number>();
      for (const row of monthPermissions ?? []) {
        const employeeId = row.employee_id as string;
        usedByEmployee.set(
          employeeId,
          (usedByEmployee.get(employeeId) ?? 0) +
            quotaUsed([{ minutes: Number(row.minutes), status: row.status as string }]),
        );
      }
      const cards = employeeIds
        .map((employeeId) => {
          const emp = employeeMap.get(employeeId);
          const days = daysByEmployee.get(employeeId) ?? [];
          return mapCard(emp, days, period.monthName, usedByEmployee.get(employeeId) ?? 0);
        })
        .sort((a, b) => b.openFlags - a.openFlags || a.fullName.localeCompare(b.fullName));

      const exceptions = (rowData ?? [])
        .filter((row) => row.match_status === 'UNMATCHED' || row.match_status === 'DUPLICATE')
        .map((row) => ({
          id: `${row.employee_code}:${row.match_status}`,
          employeeCode: row.employee_code as string,
          name: row.name as string,
          date: row.attendance_date as string,
          reason: row.match_status === 'DUPLICATE' ? 'Duplicate UserID' : 'No employee with this code',
        }));

      const uniqueExceptions = [...new Map(exceptions.map((item) => [`${item.employeeCode}:${item.reason}`, item])).values()];
      const openFlags = untouchedFlagCount(
        (reviews ?? []).map((row) => ({
          needsHrDecision: Boolean(row.needs_hr_decision),
          hrAction: (row.hr_action as string | null) ?? null,
        })),
      );

      return {
        import: mapImport(imp),
        exceptions: uniqueExceptions,
        openFlags,
        canConfirm: openFlags === 0 && (imp.status === 'IN_REVIEW' || imp.status === 'PARSED'),
        cards,
      };
    },

    async getCard(actor: RequestUser, importId: string, employeeId: string) {
      requireView(actor);
      const { data: rawImp, error } = await supabase
        .from('attendance_imports')
        .select('*')
        .eq('id', importId)
        .maybeSingle();
      if (error || !rawImp) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Import not found.', 404);
      const imp = rawImp as Record<string, unknown>;

      // Refresh only this employee (~31 days) so card opens stay fast even when month is stale.
      if (needsRulesRefresh(imp)) {
        const employeeKey = refreshCacheKey(importId, employeeId);
        const importKey = refreshCacheKey(importId);
        if (!refreshedImportIds.has(importKey) && !refreshedEmployeeKeys.has(employeeKey)) {
          await refreshOpenImportDayReviews(supabase, importId, imp.period as string, {
            employeeId,
            stampVersion: false,
          });
          refreshedEmployeeKeys.add(employeeKey);
        }
      }

      const { data: reviews } = await supabase
        .from('attendance_day_reviews')
        .select('*')
        .eq('import_id', importId)
        .eq('employee_id', employeeId)
        .order('attendance_date');
      if (!reviews?.length) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Review card not found.', 404);

      const { data: emp } = await supabase
        .from('employees')
        .select('id, employee_code, full_name, companies (name)')
        .eq('id', employeeId)
        .maybeSingle();

      const period = parsePeriod(imp.period as string);
      const { data: monthPermissions } = await supabase
        .from('work_permissions')
        .select('minutes, status')
        .eq('employee_id', employeeId)
        .gte('permission_date', period.start)
        .lte('permission_date', period.end);
      const used = quotaUsed(
        (monthPermissions ?? []).map((row) => ({
          minutes: Number(row.minutes),
          status: row.status as string,
        })),
      );

      return {
        import: mapImport(imp),
        card: mapCard((emp as EmployeeRow | null) ?? undefined, reviews, period.monthName, used),
      };
    },

    async upload(
      actor: RequestUser,
      input: { period: string; fileName: string; contentBase64: string },
      meta: RequestMeta,
    ) {
      requireManage(actor);
      const period = parsePeriod(input.period);
      if (await payrollPublished(supabase, period.key)) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          `Payroll for ${period.label} is published. This month cannot be re-uploaded.`,
          409,
        );
      }
      if (!isExcelFileName(input.fileName)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Upload an Excel file (.xls or .xlsx).', 400);
      }

      const buffer = decodeBase64File(input.contentBase64);
      const parsed = parseBiometricGrid(gridFromXlsx(buffer));
      await supersedePeriod(supabase, period.key);

      const importId = crypto.randomUUID();
      const stored = bufferForStorage(buffer, input.fileName);
      const storagePath = originalExcelPath(importId, stored.storedName);
      const { error: storageError } = await supabase.storage.from(ATTENDANCE_IMPORT_BUCKET).upload(storagePath, stored.body, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });
      if (storageError) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          storageError.message || 'Failed to store the original Excel file.',
          500,
        );
      }

      const { data: created, error: createError } = await supabase
        .from('attendance_imports')
        .insert({
          id: importId,
          period: period.key,
          file_name: input.fileName,
          storage_path: storagePath,
          uploaded_by: actor.employeeId,
          status: 'UPLOADED',
        })
        .select('*')
        .single();
      if (createError || !created) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to store the import.', 500);
      }

      const { data: employees, error: empError } = await supabase
        .from('employees')
        .select('id, employee_code, full_name, companies (name)')
        .eq('status', 'active');
      if (empError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employees.', 500);

      const employeeList = (employees ?? []) as EmployeeRow[];
      const lookup = buildEmployeeLookup(employeeList);
      const dates = datesInPeriod(period.key);
      const punches = new Map<string, { inTime: string | null; outTime: string | null; name: string; warnings: string[] }>();
      const employeesInFile = new Set<string>();

      const rowInserts: Record<string, unknown>[] = [];

      for (const day of parsed.days) {
        const matched = matchEmployee(day.employeeCode, day.name, lookup);
        const emp = matched.employee;
        const { inTime, outTime } = firstAndLast(day.times);
        const iso = `${period.key}-${String(day.day).padStart(2, '0')}`;
        if (!dates.includes(iso)) continue;
        const warnings = [...matched.warnings];
        const matchStatus = matched.status;
        rowInserts.push({
          import_id: created.id,
          employee_code: day.employeeCode,
          name: day.name,
          attendance_date: iso,
          raw_in: inTime,
          raw_out: outTime,
          warnings,
          employee_id: emp?.id ?? null,
          match_status: matchStatus,
        });
        if (emp) {
          employeesInFile.add(emp.id);
          punches.set(`${emp.id}:${iso}`, { inTime, outTime, name: day.name, warnings });
        }
      }

      for (const exception of parsed.exceptions) {
        if (!exception.employeeCode) continue;
        rowInserts.push({
          import_id: created.id,
          employee_code: exception.employeeCode,
          name: exception.name,
          attendance_date: period.start,
          raw_in: null,
          raw_out: null,
          warnings: [exception.reason],
          employee_id: null,
          match_status: exception.reason.includes('Duplicate') ? 'DUPLICATE' : 'UNMATCHED',
        });
      }

      if (rowInserts.length) {
        const { error } = await supabase.from('attendance_import_rows').insert(rowInserts);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to store parsed rows.', 500);
      }

      const workingDays = await loadWorkingDays(supabase);
      const holidayDates = await loadHolidayDates(supabase);
      const workWeeks = await listWorkWeekRows(supabase);
      const { start, end } = period;

      const { data: leaves } = await supabase
        .from('leave_applications')
        .select('employee_id, start_date, end_date, duration, leave_types (name, paid)')
        .eq('status', 'APPROVED')
        .lte('start_date', end)
        .gte('end_date', start);

      const { data: permissions } = await supabase
        .from('work_permissions')
        .select('employee_id, permission_date, minutes, status, slot')
        .gte('permission_date', start)
        .lte('permission_date', end);

      const { data: assignmentRows } = await supabase
        .from('shift_assignments')
        .select('employee_id, effective_from, effective_to, shifts (*)');
      const assignments = (assignmentRows ?? []) as AssignmentRow[];
      const overrides = await listApprovedShiftOverrides(supabase, start, end);
      const { data: allShifts } = await supabase.from('shifts').select('*');
      const shiftById = new Map(
        ((allShifts ?? []) as ShiftRow[]).map((row) => [row.id, row]),
      );

      const reviewInserts: Record<string, unknown>[] = [];
      for (const emp of employeeList) {
        if (!employeesInFile.has(emp.id)) continue;
        for (const iso of dates) {
          const shift = shiftForDay(assignments, shiftById, overrides, emp.id, iso);
          const punch = punches.get(`${emp.id}:${iso}`);
          const leave = leaveOnDate(leaves ?? [], emp.id, iso);
          const permission = approvedPermission(permissions ?? [], emp.id, iso);
          const rawIn = punch?.inTime ? combineDateAndTime(iso, punch.inTime) : null;
          const rawOut = punch?.outTime ? combineDateAndTime(iso, punch.outTime) : null;
          const actualIn = adjustPunchClock(rawIn);
          const actualOut = adjustPunchClock(rawOut);
          const derived = deriveAttendance({
            isoDate: iso,
            workingDays,
            holidayDates,
            weekPattern: patternOnDate(workWeeks, emp.id, iso),
            onApprovedLeave: Boolean(leave),
            shift: shift ? toShiftDefinition(shift) : null,
            actualIn,
            actualOut,
            permissionMinutes: permission.minutes,
          });
          const proposal = proposeLop({
            derived,
            permissionMinutes: permission.minutes,
            permissionSlot: permission.slot,
            leave,
          });
          reviewInserts.push({
            import_id: created.id,
            employee_id: emp.id,
            attendance_date: iso,
            status: derived.status,
            shift_name: shift?.name ?? null,
            actual_in: actualIn?.toISOString() ?? null,
            actual_out: actualOut?.toISOString() ?? null,
            worked_minutes: derived.workedMinutes,
            late_minutes: derived.lateMinutes,
            permission_minutes: permission.minutes,
            permission_covered: proposal.permissionCovered,
            leave_type_name: leave?.typeName ?? null,
            leave_paid: leave ? leave.paid : null,
            leave_duration: leave?.duration ?? null,
            proposed_lop: proposal.proposedLop,
            final_lop: proposal.finalLop,
            hr_action: proposal.hrAction,
            needs_hr_decision: proposal.needsHrDecision,
            skipped_from_lop: proposal.skippedFromLop,
          });
        }
      }

      for (let i = 0; i < reviewInserts.length; i += 400) {
        const chunk = reviewInserts.slice(i, i + 400);
        const { error } = await supabase.from('attendance_day_reviews').insert(chunk);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to build review cards.', 500);
      }

      const { data: updated, error: statusError } = await supabase
        .from('attendance_imports')
        .update({ status: 'IN_REVIEW', rules_version: ATTENDANCE_RULES_VERSION })
        .eq('id', created.id)
        .select('*')
        .single();
      if (statusError || !updated) {
        // Fallback if rules_version column is not migrated yet.
        const { data: fallback, error: fallbackError } = await supabase
          .from('attendance_imports')
          .update({ status: 'IN_REVIEW' })
          .eq('id', created.id)
          .select('*')
          .single();
        if (fallbackError || !fallback) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to mark import for review.', 500);
        }
      }

      refreshedImportIds.add(refreshCacheKey(created.id as string));

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.import.upload',
        entityType: 'attendance_import',
        entityId: created.id as string,
        newValues: { period: period.key, fileName: input.fileName },
        ...meta,
      });

      return this.get(actor, created.id as string);
    },

    async decideDay(
      actor: RequestUser,
      reviewId: string,
      input: { action: HrAction; reason?: string },
      meta: RequestMeta,
    ) {
      requireManage(actor);
      const { data: row, error } = await supabase.from('attendance_day_reviews').select('*').eq('id', reviewId).maybeSingle();
      if (error || !row) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Day review not found.', 404);

      const { data: imp } = await supabase.from('attendance_imports').select('status, period').eq('id', row.import_id).maybeSingle();
      if (!imp || imp.status === 'CONFIRMED' || imp.status === 'REJECTED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This import can no longer be edited.', 400);
      }
      if (await payrollPublished(supabase, imp.period as string)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Payroll for this month is published.', 409);
      }

      const finalLop = lopFromAction(input.action);
      const { data, error: updateError } = await supabase
        .from('attendance_day_reviews')
        .update({
          hr_action: input.action,
          reason: input.reason?.trim() || null,
          // Keep proposed in sync with the decided amount so month/card totals update.
          proposed_lop: finalLop,
          final_lop: finalLop,
          needs_hr_decision: false,
        })
        .eq('id', reviewId)
        .select('*')
        .single();
      if (updateError || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save the LOP decision.', 500);

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.import.lop_override',
        entityType: 'attendance_day_review',
        entityId: reviewId,
        newValues: { action: input.action, finalLop, proposedLop: finalLop },
        ...meta,
      });
      return mapDay(data);
    },

    async confirm(
      actor: RequestUser,
      id: string,
      input: { salarySlipEmployeeIds: string[] },
      meta: RequestMeta,
    ) {
      requireManage(actor);
      const bundle = await this.get(actor, id);
      if (bundle.import.status === 'CONFIRMED') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This month is already confirmed.', 409);
      }
      if (bundle.import.status === 'REJECTED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This import was rejected.', 400);
      }
      if (!bundle.canConfirm) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Decide ${bundle.openFlags} flagged day${bundle.openFlags === 1 ? '' : 's'} before confirming.`,
          400,
        );
      }
      if (await payrollPublished(supabase, bundle.import.period)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Payroll for this month is published.', 409);
      }

      const allowedIds = new Set(bundle.cards.map((card) => card.employeeId));
      const salarySlipEmployeeIds = [...new Set(input.salarySlipEmployeeIds)];
      if (salarySlipEmployeeIds.length === 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Select at least one employee for salary slips before confirming.',
          400,
        );
      }
      for (const employeeId of salarySlipEmployeeIds) {
        if (!allowedIds.has(employeeId)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Salary slip selection includes an employee who is not on this import.',
            400,
          );
        }
      }

      const { data: reviews, error } = await supabase.from('attendance_day_reviews').select('*').eq('import_id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load reviews.', 500);
      const { data: assignmentRows } = await supabase
        .from('shift_assignments')
        .select('employee_id, effective_from, effective_to, shifts (*)');
      const assignments = (assignmentRows ?? []) as AssignmentRow[];
      const periodKey = bundle.import.period as string;
      const periodBounds = parsePeriod(periodKey);
      const overrides = await listApprovedShiftOverrides(supabase, periodBounds.start, periodBounds.end);
      const { data: allShifts } = await supabase.from('shifts').select('*');
      const shiftById = new Map(((allShifts ?? []) as ShiftRow[]).map((row) => [row.id, row]));

      for (const row of reviews ?? []) {
        const employeeId = row.employee_id as string;
        const attendanceDate = row.attendance_date as string;
        const shift = shiftForDay(assignments, shiftById, overrides, employeeId, attendanceDate);
        const status = freezeAttendanceStatus(row.status as string);
        const payload = {
          employee_id: employeeId,
          attendance_date: attendanceDate,
          shift_id: shift?.id ?? null,
          actual_in: row.actual_in,
          actual_out: row.actual_out,
          worked_minutes: row.worked_minutes,
          status,
          late_minutes: Number(row.late_minutes ?? 0),
          early_exit_minutes: 0,
          overtime_minutes: 0,
        };
        const { data: upserted, error: ups } = await supabase
          .from('attendance_records')
          .upsert(payload, { onConflict: 'employee_id,attendance_date' })
          .select('id')
          .single();
        if (ups || !upserted) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            `Failed to freeze attendance for ${attendanceDate} (${status})${ups?.message ? `: ${ups.message}` : '.'}`,
            500,
          );
        }
        await supabase.from('attendance_day_reviews').update({ attendance_record_id: upserted.id }).eq('id', row.id);
      }

      const { data: confirmed, error: confirmError } = await supabase
        .from('attendance_imports')
        .update({
          status: 'CONFIRMED',
          confirmed_at: new Date().toISOString(),
          salary_slip_employee_ids: salarySlipEmployeeIds,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (confirmError || !confirmed) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to confirm the import.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.import.confirm',
        entityType: 'attendance_import',
        entityId: id,
        newValues: {
          period: bundle.import.period,
          salarySlipEmployeeIds,
          salarySlipCount: salarySlipEmployeeIds.length,
        },
        ...meta,
      });

      const publishedPeriod = parsePeriod(bundle.import.period);
      const recipients = await listActiveStaff(supabase);
      await notifyStaff(supabase, recipients, {
        type: 'attendance',
        title: `${publishedPeriod.monthName} attendance published`,
        message: `Your ${publishedPeriod.monthName} attendance is published. Open Attendance to review in and out times.`,
        referenceType: 'attendance_import',
        referenceId: publishedPeriod.key,
        eyebrow: 'Attendance',
        paragraphs: [
          `Attendance for ${publishedPeriod.label} has been published.`,
          'Open Attendance in the portal to see your in and out times for the month.',
        ],
        ctaLabel: 'Open attendance',
        ctaHref: portalUrl(`/attendance?period=${publishedPeriod.key}`),
      });

      return this.get(actor, id);
    },

    async reject(actor: RequestUser, id: string, meta: RequestMeta) {
      requireManage(actor);
      const { data: imp } = await supabase.from('attendance_imports').select('*').eq('id', id).maybeSingle();
      if (!imp) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Import not found.', 404);
      if (imp.status === 'CONFIRMED' && (await payrollPublished(supabase, imp.period as string))) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Payroll for this month is published.', 409);
      }
      const { data, error } = await supabase
        .from('attendance_imports')
        .update({ status: 'REJECTED' })
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reject the import.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.import.reject',
        entityType: 'attendance_import',
        entityId: id,
        ...meta,
      });
      return mapImport(data);
    },

    async remove(actor: RequestUser, id: string, meta: RequestMeta) {
      requireManage(actor);
      const { data: imp } = await supabase.from('attendance_imports').select('*').eq('id', id).maybeSingle();
      if (!imp) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Import not found.', 404);
      if (imp.status !== 'REJECTED') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Reject this import first. Only rejected imports can be deleted.',
          400,
        );
      }
      const { data: payrollLink } = await supabase
        .from('payroll_runs')
        .select('id')
        .eq('attendance_import_id', id)
        .maybeSingle();
      if (payrollLink) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This import is tied to payroll and cannot be deleted.', 409);
      }

      const storagePath = (imp.storage_path as string | null) ?? null;
      if (storagePath) {
        await supabase.storage.from(ATTENDANCE_IMPORT_BUCKET).remove([storagePath]);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.import.delete',
        entityType: 'attendance_import',
        entityId: id,
        oldValues: { period: imp.period, fileName: imp.file_name, status: imp.status },
        ...meta,
      });

      const { error } = await supabase.from('attendance_imports').delete().eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to delete the import.', 500);
      return { deleted: true };
    },

    async publishedMine(actor: RequestUser, period?: string) {
      const key = period && /^\d{4}-\d{2}$/.test(period) ? period : new Date().toISOString().slice(0, 7);
      const bounds = parsePeriod(key);
      const { data: confirmed } = await supabase
        .from('attendance_imports')
        .select('*')
        .eq('period', key)
        .eq('status', 'CONFIRMED')
        .order('confirmed_at', { ascending: false })
        .limit(1);
      const imp = (confirmed ?? [])[0];

      if (!imp) {
        return {
          published: false,
          period: key,
          monthLabel: bounds.label,
          message: 'This month is not published yet.',
          records: [] as ReturnType<typeof mapPublishedDay>[],
        };
      }

      const { data: reviews } = await supabase
        .from('attendance_day_reviews')
        .select('*')
        .eq('import_id', imp.id)
        .eq('employee_id', actor.employeeId)
        .order('attendance_date');

      return {
        published: true,
        period: key,
        monthLabel: bounds.label,
        message: null,
        records: (reviews ?? []).map(mapPublishedDay),
      };
    },
  };
}

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function leaveOnDate(
  rows: Record<string, unknown>[],
  employeeId: string,
  iso: string,
): LeaveOverlay | null {
  const day = dateOnly(iso);
  const row = rows.find((item) => {
    if (item.employee_id !== employeeId) return false;
    return dateOnly(String(item.start_date)) <= day && dateOnly(String(item.end_date)) >= day;
  });
  if (!row) return null;
  const type = firstRel(row.leave_types as { name: string; paid: boolean } | { name: string; paid: boolean }[]);
  return {
    typeName: type?.name ?? 'Leave',
    paid: type?.paid !== false,
    duration: (row.duration as 'full' | 'half') ?? 'full',
  };
}

function approvedPermission(
  rows: { employee_id: string; permission_date: string; minutes: number; status: string; slot?: string | null }[],
  employeeId: string,
  iso: string,
): { minutes: number; slot: 'START' | 'END' } {
  const day = dateOnly(iso);
  const match = rows.find(
    (row) =>
      row.employee_id === employeeId &&
      dateOnly(String(row.permission_date)) === day &&
      row.status === 'APPROVED',
  );
  if (!match) {
    return { minutes: 0, slot: 'START' };
  }
  return {
    minutes: Number(match.minutes),
    slot: match.slot === 'END' ? 'END' : 'START',
  };
}

/** Statuses allowed on attendance_records (must match DB check constraint). */
const FROZEN_ATTENDANCE_STATUSES = new Set([
  'PRESENT',
  'ABSENT',
  'LATE',
  'HALF_DAY',
  'LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
  'MISSING_PUNCH',
  'NO_SHIFT',
]);

function freezeAttendanceStatus(status: string): string {
  if (FROZEN_ATTENDANCE_STATUSES.has(status)) return status;
  return 'ABSENT';
}

function mapImport(row: Record<string, unknown>) {
  const slipIds = row.salary_slip_employee_ids;
  return {
    id: row.id as string,
    period: row.period as string,
    fileName: row.file_name as string,
    storagePath: (row.storage_path as string | null) ?? null,
    status: row.status as string,
    uploadedBy: row.uploaded_by as string,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    salarySlipEmployeeIds: Array.isArray(slipIds) ? (slipIds as string[]) : null,
    createdAt: row.created_at as string,
  };
}

function mapDay(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    attendanceDate: row.attendance_date as string,
    status: row.status as string,
    actualIn: clock(row.actual_in as string | null),
    actualOut: clock(row.actual_out as string | null),
    workedMinutes: (row.worked_minutes as number | null) ?? null,
    lateMinutes: Number(row.late_minutes ?? 0),
    permissionMinutes: Number(row.permission_minutes ?? 0),
    permissionCovered: Boolean(row.permission_covered),
    leaveTypeName: (row.leave_type_name as string | null) ?? null,
    leavePaid: row.leave_paid as boolean | null,
    leaveDuration: (row.leave_duration as string | null) ?? null,
    proposedLop: row.proposed_lop == null ? null : Number(row.proposed_lop),
    finalLop: row.final_lop == null ? null : Number(row.final_lop),
    hrAction: (row.hr_action as HrAction | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    needsHrDecision: Boolean(row.needs_hr_decision),
    skippedFromLop: Boolean(row.skipped_from_lop),
    shiftName: (row.shift_name as string | null) ?? null,
  };
}

function mapPublishedDay(row: Record<string, unknown>) {
  const day = mapDay(row);
  return {
    id: day.attendanceDate,
    attendanceDate: day.attendanceDate,
    actualIn: day.actualIn,
    actualOut: day.actualOut,
    status: day.status,
    workedMinutes: day.workedMinutes,
  };
}

function resolveCardShiftName(days: { attendanceDate: string; shiftName: string | null }[]): string | null {
  let best: { date: string; name: string } | null = null;
  for (const day of days) {
    if (!day.shiftName) continue;
    if (!best || day.attendanceDate > best.date) {
      best = { date: day.attendanceDate, name: day.shiftName };
    }
  }
  return best?.name ?? null;
}

function mapCard(
  emp: EmployeeRow | undefined,
  days: Record<string, unknown>[],
  monthName: string,
  quotaUsedMinutes: number,
) {
  const mapped = days.map(mapDay);
  const permissionTaken = mapped.reduce((sum, day) => sum + (day.permissionMinutes > 0 ? day.permissionMinutes : 0), 0);
  const remaining = remainingMinutes(quotaUsedMinutes);
  const workingDaysCount = mapped.filter(
    (day) => day.status !== 'WEEK_OFF' && day.status !== 'HOLIDAY' && day.status !== 'NO_SHIFT',
  ).length;
  const finalLop = mapped.reduce((sum, day) => sum + (day.finalLop ?? 0), 0);
  const proposedLop = mapped.reduce((sum, day) => sum + effectiveDayLop(day), 0);
  const openFlags = untouchedFlagCount(mapped.map((day) => ({ needsHrDecision: day.needsHrDecision, hrAction: day.hrAction })));
  const shiftName = resolveCardShiftName(mapped);
  const employeeId = emp?.id ?? mapped[0]?.employeeId ?? '';
  return {
    id: employeeId,
    employeeId,
    employeeCode: emp?.employee_code ?? '',
    fullName: emp?.full_name ?? 'Employee',
    companyName: firstRel(emp?.companies)?.name ?? null,
    shiftName,
    remainingLabel: remainingLabel(remaining, monthName),
    permissionTakenMinutes: permissionTaken,
    quotaMinutes: MONTHLY_QUOTA_MINUTES,
    leaves: mapped
      .filter((day) => day.leaveTypeName)
      .map((day) => ({
        date: day.attendanceDate,
        typeName: day.leaveTypeName,
        paid: day.leavePaid,
        duration: day.leaveDuration,
      })),
    permissions: mapped
      .filter((day) => day.permissionMinutes > 0)
      .map((day) => ({ date: day.attendanceDate, minutes: day.permissionMinutes })),
    days: mapped,
    proposedLop,
    finalLop,
    payableDays: Math.max(0, workingDaysCount - finalLop),
    workingDaysCount,
    openFlags,
    needsDecision: openFlags > 0,
  };
}
