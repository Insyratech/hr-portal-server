import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { listWorkWeekRows } from '../attendance/work-week';
import { refreshOpenImportsForEmployeeDate } from '../attendance/import/refresh-for-date';
import { patternOnDate } from '../leave/day-count';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, notifyStaff, type StaffContact } from '../notifications/notify-staff';
import type { CompOffEligibleLeave, CompOffWorkRecord, CompOffWorkStatus } from './types';
import {
  assertWorkDateIsOff,
  leaveWorkingDates,
  monthBounds,
  monthKey,
  sameCalendarMonth,
} from './validation';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type CompOffRow = {
  id: string;
  employee_id: string;
  leave_application_id: string;
  work_date: string;
  leave_date: string;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  balance_restored: number;
  actor_id: string | null;
  decided_at: string | null;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
  leave_applications?:
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string; paid: boolean } | { code: string; name: string; paid: boolean }[] | null;
      }
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string; paid: boolean } | { code: string; name: string; paid: boolean }[] | null;
      }[]
    | null;
};

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function employeeName(value: CompOffRow['employees']): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0]?.full_name ?? null) : value.full_name;
}

function canApprove(actor: RequestUser): boolean {
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.COMP_OFF_APPROVE);
}

function canListAll(actor: RequestUser): boolean {
  return canApprove(actor) || actor.permissions.includes(PERMISSIONS.USERS_VIEW);
}

function mapRow(row: CompOffRow): CompOffWorkRecord {
  const app = firstRel(row.leave_applications);
  const type = firstRel(app?.leave_types ?? null);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: employeeName(row.employees),
    leaveApplicationId: row.leave_application_id,
    leaveTypeCode: type?.code ?? null,
    leaveTypeName: type?.name ?? null,
    workDate: dateOnly(row.work_date),
    leaveDate: dateOnly(row.leave_date),
    quantity: Number(row.quantity),
    reason: row.reason ?? '',
    status: row.status,
    balanceRestored: Number(row.balance_restored ?? 0),
    actorId: row.actor_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

const SELECT_WITH_RELS =
  '*, employees!employee_id (full_name), leave_applications (start_date, end_date, duration, status, leave_types (code, name, paid))';

async function loadHrManagers(supabase: SupabaseClient): Promise<StaffContact[]> {
  const { data } = await supabase
    .from('employee_roles')
    .select('employees ( id, user_id, email, notification_email, full_name ), roles ( code )');
  const people: StaffContact[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const role = row.roles as { code?: string } | { code?: string }[] | null;
    const code = Array.isArray(role) ? role[0]?.code : role?.code;
    if (code !== 'HR_MANAGER') continue;
    const employee = row.employees as
      | {
          id?: string;
          user_id?: string | null;
          email?: string | null;
          notification_email?: string | null;
          full_name?: string | null;
        }
      | {
          id?: string;
          user_id?: string | null;
          email?: string | null;
          notification_email?: string | null;
          full_name?: string | null;
        }[]
      | null;
    const person = Array.isArray(employee) ? employee[0] : employee;
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    people.push({
      id: person.id,
      userId: person.user_id ?? null,
      email: person.notification_email || person.email || '',
      fullName: person.full_name || 'HR Manager',
    });
  }
  return people;
}

async function claimedLeaveDates(
  supabase: SupabaseClient,
  leaveApplicationIds: string[],
): Promise<Set<string>> {
  if (leaveApplicationIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('comp_off_work_requests')
    .select('leave_application_id, leave_date')
    .in('leave_application_id', leaveApplicationIds)
    .in('status', ['PENDING', 'APPROVED']);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load existing comp-off claims.', 500);
  }
  const claimed = new Set<string>();
  for (const row of data ?? []) {
    claimed.add(`${row.leave_application_id as string}:${dateOnly(String(row.leave_date))}`);
  }
  return claimed;
}

async function restoreLeaveBalanceIfPossible(
  supabase: SupabaseClient,
  input: {
    leaveApplicationId: string;
    employeeId: string;
    leaveTypeId: string;
    quantity: number;
    requestId: string;
    actorId: string;
  },
): Promise<number> {
  const { data: ledger, error } = await supabase
    .from('leave_ledger')
    .select('id, allocation_id, quantity')
    .eq('reference_id', input.leaveApplicationId)
    .eq('transaction_type', 'LEAVE_APPROVED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave ledger for restore.', 500);
  }
  if (!ledger) {
    return 0;
  }
  const currentQty = Number(ledger.quantity);
  // LEAVE_APPROVED stores negative debits; restore by making the debit smaller.
  if (!(currentQty < 0) || Math.abs(currentQty) + 1e-9 < input.quantity) {
    return 0;
  }
  const nextQty = Number((currentQty + input.quantity).toFixed(2));
  const { error: updateError } = await supabase
    .from('leave_ledger')
    .update({ quantity: nextQty })
    .eq('id', ledger.id);
  if (updateError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to restore leave balance.', 500);
  }
  await supabase.rpc('recompute_leave_allocation', { p_allocation_id: ledger.allocation_id });
  await writeAuditLog(supabase, {
    actorId: input.actorId,
    action: 'comp_off.balance_restore',
    entityType: 'comp_off_work_request',
    entityId: input.requestId,
    newValues: {
      leaveApplicationId: input.leaveApplicationId,
      leaveTypeId: input.leaveTypeId,
      employeeId: input.employeeId,
      quantity: input.quantity,
      ledgerId: ledger.id,
      previousQuantity: currentQty,
      nextQuantity: nextQty,
    },
  });
  return input.quantity;
}

export function createCompOffWorkService(supabase: SupabaseClient) {
  return {
    async listMine(actor: RequestUser): Promise<CompOffWorkRecord[]> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory work requests.', 403);
      }
      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .eq('employee_id', actor.employeeId)
        .order('work_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory work requests.', 500);
      }
      return ((data ?? []) as CompOffRow[]).map(mapRow);
    },

    async listQueue(actor: RequestUser, status?: CompOffWorkStatus): Promise<CompOffWorkRecord[]> {
      if (!canListAll(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory work requests.', 403);
      }
      let query = supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .order('created_at', { ascending: false });
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory work requests.', 500);
      }
      return ((data ?? []) as CompOffRow[]).map(mapRow);
    },

    async listEligibleLeaves(actor: RequestUser, yearMonth: string): Promise<CompOffEligibleLeave[]> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request compensatory work.', 403);
      }
      let bounds: { start: string; end: string };
      try {
        bounds = monthBounds(yearMonth);
      } catch {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Provide month as YYYY-MM.', 400);
      }

      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, actor.employeeId),
      ]);

      const { data, error } = await supabase
        .from('leave_applications')
        .select('id, start_date, end_date, duration, status, leave_types (code, name)')
        .eq('employee_id', actor.employeeId)
        .eq('status', 'APPROVED')
        .lte('start_date', bounds.end)
        .gte('end_date', bounds.start)
        .order('start_date', { ascending: true });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave applications.', 500);
      }

      const apps = data ?? [];
      const claimed = await claimedLeaveDates(
        supabase,
        apps.map((row) => row.id as string),
      );

      const result: CompOffEligibleLeave[] = [];
      for (const row of apps) {
        const startDate = dateOnly(String(row.start_date));
        const endDate = dateOnly(String(row.end_date));
        const duration = (row.duration as 'full' | 'half') ?? 'full';
        const type = firstRel(
          row.leave_types as { code: string; name: string } | { code: string; name: string }[] | null,
        );
        const days = leaveWorkingDates({
          startDate,
          endDate,
          duration,
          workingDays,
          holidayDates,
          weekPatternForDate: (iso) => patternOnDate(workWeeks, actor.employeeId, iso),
        })
          .filter((day) => monthKey(day.leaveDate) === yearMonth)
          .map((day) => ({
            leaveDate: day.leaveDate,
            quantity: day.quantity,
            available: !claimed.has(`${row.id as string}:${day.leaveDate}`),
          }));
        if (days.length === 0) continue;
        result.push({
          leaveApplicationId: row.id as string,
          leaveTypeCode: type?.code ?? null,
          leaveTypeName: type?.name ?? null,
          startDate,
          endDate,
          duration,
          status: String(row.status),
          days,
        });
      }
      return result;
    },

    async apply(
      actor: RequestUser,
      input: { workDate: string; leaveApplicationId: string; leaveDate: string; reason?: string },
      meta: RequestMeta,
    ): Promise<CompOffWorkRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request compensatory work.', 403);
      }

      const workDate = dateOnly(input.workDate);
      const leaveDate = dateOnly(input.leaveDate);
      if (!sameCalendarMonth(workDate, leaveDate)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date and leave date must be in the same calendar month.',
          400,
        );
      }
      if (workDate === leaveDate) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date and leave date must be different days.',
          400,
        );
      }

      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, actor.employeeId),
      ]);

      try {
        assertWorkDateIsOff({
          workDate,
          workingDays,
          holidayDates,
          weekPattern: patternOnDate(workWeeks, actor.employeeId, workDate),
        });
      } catch {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date must be a week-off or holiday for your calendar.',
          400,
        );
      }

      const { data: leaveApp, error: leaveError } = await supabase
        .from('leave_applications')
        .select('id, employee_id, start_date, end_date, duration, status, leave_types (code, name, paid)')
        .eq('id', input.leaveApplicationId)
        .maybeSingle();
      if (leaveError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave application.', 500);
      }
      if (!leaveApp || leaveApp.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave application not found.', 404);
      }
      if (leaveApp.status !== 'APPROVED') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only approved leave applications can be linked for compensatory work.',
          400,
        );
      }

      const startDate = dateOnly(String(leaveApp.start_date));
      const endDate = dateOnly(String(leaveApp.end_date));
      const duration = (leaveApp.duration as 'full' | 'half') ?? 'full';
      const eligible = leaveWorkingDates({
        startDate,
        endDate,
        duration,
        workingDays,
        holidayDates,
        weekPatternForDate: (iso) => patternOnDate(workWeeks, actor.employeeId, iso),
      });
      const match = eligible.find((day) => day.leaveDate === leaveDate);
      if (!match) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Leave date must be a working day inside the selected leave application (same month).',
          400,
        );
      }
      if (!sameCalendarMonth(match.leaveDate, workDate)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Leave date must be in the same month as the work date.',
          400,
        );
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .insert({
          employee_id: actor.employeeId,
          leave_application_id: input.leaveApplicationId,
          work_date: workDate,
          leave_date: leaveDate,
          quantity: match.quantity,
          reason: input.reason?.trim() ?? '',
          status: 'PENDING',
        })
        .select(SELECT_WITH_RELS)
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'This work date or leave day already has a pending or approved compensatory request.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to submit request.', 500);
      }

      const created = mapRow(data as CompOffRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.apply',
        entityType: 'comp_off_work_request',
        entityId: created.id,
        newValues: {
          workDate,
          leaveDate,
          leaveApplicationId: input.leaveApplicationId,
          quantity: match.quantity,
        },
        ...meta,
      });

      await notifyStaff(
        supabase,
        (await loadHrManagers(supabase)).filter((person) => person.id !== actor.employeeId),
        {
          type: 'comp_off',
          title: 'Compensatory work request',
          message: `${actor.fullName} worked/will work on ${workDate} to offset leave on ${leaveDate}.`,
          referenceType: 'comp_off_work_request',
          referenceId: created.id,
          eyebrow: 'Comp-off',
          paragraphs: [
            `${actor.fullName} requested compensatory work: work on ${workDate} (week-off/holiday) to offset leave on ${leaveDate}.`,
          ],
          ctaLabel: 'Review request',
          ctaHref: portalUrl('/hr/comp-off'),
        },
      );

      return created;
    },

    async decide(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject',
      meta: RequestMeta,
    ): Promise<CompOffWorkRecord> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide compensatory work requests.', 403);
      }

      const { data: existing, error: loadError } = await supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .eq('id', id)
        .maybeSingle();
      if (loadError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load request.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Compensatory work request not found.', 404);
      }
      const current = existing as CompOffRow;
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'This request has already been decided.', 409);
      }

      if (action === 'reject') {
        const { data, error } = await supabase
          .from('comp_off_work_requests')
          .update({
            status: 'REJECTED',
            actor_id: actor.employeeId,
            decided_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'PENDING')
          .select(SELECT_WITH_RELS)
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reject request.', 500);
        }
        const mapped = mapRow(data as CompOffRow);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'comp_off.reject',
          entityType: 'comp_off_work_request',
          entityId: id,
          oldValues: { status: current.status },
          newValues: { status: 'REJECTED' },
          ...meta,
        });
        await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
          type: 'comp_off',
          title: 'Compensatory work rejected',
          message: `Your compensatory work on ${mapped.workDate} for leave on ${mapped.leaveDate} was rejected.`,
          referenceType: 'comp_off_work_request',
          referenceId: mapped.id,
          eyebrow: 'Comp-off',
          paragraphs: [
            `Your request to work on ${mapped.workDate} to offset leave on ${mapped.leaveDate} was rejected.`,
          ],
          ctaLabel: 'View leave',
          ctaHref: portalUrl('/leave'),
        });
        return mapped;
      }

      // Approve path — re-validate leave + off-day, then restore balance and refresh attendance.
      const leaveApp = firstRel(current.leave_applications);
      if (!leaveApp || leaveApp.status !== 'APPROVED') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Linked leave must still be approved before compensatory work can be approved.',
          409,
        );
      }

      const workDate = dateOnly(current.work_date);
      const leaveDate = dateOnly(current.leave_date);
      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, current.employee_id),
      ]);
      try {
        assertWorkDateIsOff({
          workDate,
          workingDays,
          holidayDates,
          weekPattern: patternOnDate(workWeeks, current.employee_id, workDate),
        });
      } catch {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date is no longer a week-off or holiday for this employee.',
          409,
        );
      }

      const { data: leaveFull, error: leaveLoadError } = await supabase
        .from('leave_applications')
        .select('id, employee_id, leave_type_id, start_date, end_date, duration, status')
        .eq('id', current.leave_application_id)
        .maybeSingle();
      if (leaveLoadError || !leaveFull || leaveFull.status !== 'APPROVED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Linked leave is not available.', 409);
      }

      const eligible = leaveWorkingDates({
        startDate: dateOnly(String(leaveFull.start_date)),
        endDate: dateOnly(String(leaveFull.end_date)),
        duration: (leaveFull.duration as 'full' | 'half') ?? 'full',
        workingDays,
        holidayDates,
        weekPatternForDate: (iso) => patternOnDate(workWeeks, current.employee_id, iso),
      });
      if (!eligible.some((day) => day.leaveDate === leaveDate)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Leave date is no longer a valid working day inside the linked leave.',
          409,
        );
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .update({
          status: 'APPROVED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
          balance_restored: 0,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select(SELECT_WITH_RELS)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to approve request.', 500);
      }

      let balanceRestored = 0;
      try {
        balanceRestored = await restoreLeaveBalanceIfPossible(supabase, {
          leaveApplicationId: current.leave_application_id,
          employeeId: current.employee_id,
          leaveTypeId: leaveFull.leave_type_id as string,
          quantity: Number(current.quantity),
          requestId: id,
          actorId: actor.employeeId,
        });
        if (balanceRestored > 0) {
          await supabase
            .from('comp_off_work_requests')
            .update({ balance_restored: balanceRestored })
            .eq('id', id);
        }
      } catch {
        // Keep APPROVED so attendance compensation still applies; balance can be adjusted manually.
        balanceRestored = 0;
      }

      const mapped = {
        ...mapRow(data as CompOffRow),
        balanceRestored,
        status: 'APPROVED' as const,
      };
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.approve',
        entityType: 'comp_off_work_request',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status: 'APPROVED', balanceRestored },
        ...meta,
      });

      try {
        await refreshOpenImportsForEmployeeDate(supabase, current.employee_id, leaveDate);
      } catch {
        // Approval already committed; attendance refresh is best-effort for open imports.
      }

      const restoreNote =
        balanceRestored > 0
          ? ` Leave balance restored by ${balanceRestored} day(s).`
          : ' Leave history kept; attendance will treat that day as compensated (no leave/LOP).';
      await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
        type: 'comp_off',
        title: 'Compensatory work approved',
        message: `Your work on ${mapped.workDate} offsets leave on ${mapped.leaveDate}.${restoreNote}`,
        referenceType: 'comp_off_work_request',
        referenceId: mapped.id,
        eyebrow: 'Comp-off',
        paragraphs: [
          `Your compensatory work on ${mapped.workDate} was approved to offset leave on ${mapped.leaveDate}.`,
          balanceRestored > 0
            ? `${balanceRestored} day(s) were restored to your leave balance.`
            : 'The leave day is marked compensated so attendance/payroll will not count it as leave or LOP.',
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });

      return mapped;
    },

    async cancel(actor: RequestUser, id: string, meta: RequestMeta): Promise<CompOffWorkRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot revoke compensatory work requests.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .eq('id', id)
        .maybeSingle();
      if (loadError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load request.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Compensatory work request not found.', 404);
      }
      const current = existing as CompOffRow;
      if (current.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only revoke your own request.', 403);
      }
      if (current.status !== 'PENDING') {
        throw new AppError(
          API_ERROR_CODES.INVALID_STATUS_TRANSITION,
          current.status === 'APPROVED'
            ? 'This request was already approved. Contact HR if you need a change.'
            : 'Only a pending request can be revoked.',
          409,
        );
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .update({
          status: 'CANCELLED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .eq('employee_id', actor.employeeId)
        .select(SELECT_WITH_RELS)
        .single();
      if (error || !data) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Could not revoke this request. It may already have been decided.',
          409,
        );
      }
      const mapped = mapRow(data as CompOffRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.cancel',
        entityType: 'comp_off_work_request',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status: 'CANCELLED' },
        ...meta,
      });
      return mapped;
    },
  };
}
