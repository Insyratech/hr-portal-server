import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canWriteDirectoryShiftAssignments } from '../employees/access';
import { assertCanStaffDirectoryTarget } from '../employees/staff-target';
import { isWeekPattern, type WeekPattern, type WorkWeekRecord } from '../leave/day-count';
import { closeDateForOpenRow, rowsToClose } from './shift-assignment-utils';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type WorkWeekRow = {
  id: string;
  employee_id: string;
  pattern: string;
  effective_from: string;
  effective_to: string | null;
};

export function mapWorkWeek(row: WorkWeekRow): WorkWeekRecord & { id: string } {
  return {
    id: row.id,
    employeeId: row.employee_id,
    pattern: row.pattern as WeekPattern,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
  };
}

export async function listWorkWeekRows(
  supabase: SupabaseClient,
  employeeId?: string,
): Promise<WorkWeekRecord[]> {
  let query = supabase
    .from('employee_work_weeks')
    .select('employee_id, pattern, effective_from, effective_to')
    .order('effective_from', { ascending: false });
  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  }
  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load working weeks.', 500);
  }
  return (data ?? []).map((row) => ({
    employeeId: row.employee_id as string,
    pattern: row.pattern as WeekPattern,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
  }));
}

export function createWorkWeekService(supabase: SupabaseClient) {
  return {
    async listForEmployee(_actor: RequestUser, employeeId: string) {
      const { data: employee } = await supabase
        .from('employees')
        .select('id, deleted_at')
        .eq('id', employeeId)
        .maybeSingle();
      if (!employee || employee.deleted_at) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      const { data, error } = await supabase
        .from('employee_work_weeks')
        .select('*')
        .eq('employee_id', employeeId)
        .order('effective_from', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load working weeks.', 500);
      }
      return ((data ?? []) as WorkWeekRow[]).map(mapWorkWeek);
    },

    async save(
      actor: RequestUser,
      employeeId: string,
      input: { pattern: string; effectiveFrom: string },
      meta: RequestMeta,
    ) {
      if (!canWriteDirectoryShiftAssignments(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot update working weeks.', 403);
      }
      await assertCanStaffDirectoryTarget(supabase, actor, employeeId);
      if (!isWeekPattern(input.pattern)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select a working week.', 400);
      }
      const effectiveFrom = input.effectiveFrom.slice(0, 10);

      const { data: existing } = await supabase
        .from('employee_work_weeks')
        .select('*')
        .eq('employee_id', employeeId)
        .eq('effective_from', effectiveFrom)
        .maybeSingle();

      const { data: openRows, error: openError } = await supabase
        .from('employee_work_weeks')
        .select('id, effective_from')
        .eq('employee_id', employeeId)
        .is('effective_to', null);
      if (openError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load working weeks.', 500);
      }

      const normalizedOpen = (openRows ?? []).map((row) => ({
        id: row.id as string,
        effective_from: String(row.effective_from).slice(0, 10),
      }));
      const keepId = existing ? ((existing as WorkWeekRow).id as string) : undefined;

      for (const close of rowsToClose(normalizedOpen, effectiveFrom, keepId)) {
        const { error: closeError } = await supabase
          .from('employee_work_weeks')
          .update({ effective_to: close.effectiveTo })
          .eq('id', close.id);
        if (closeError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to close previous working week.', 500);
        }
      }

      let saved: WorkWeekRow;
      if (existing) {
        const { data, error } = await supabase
          .from('employee_work_weeks')
          .update({ pattern: input.pattern, effective_to: null })
          .eq('id', (existing as WorkWeekRow).id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update working week.', 500);
        }
        saved = data as WorkWeekRow;
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'employee.work_week_update',
          entityType: 'employee_work_week',
          entityId: saved.id,
          newValues: { pattern: input.pattern, effectiveFrom },
          ...meta,
        });
      } else {
        const { data, error } = await supabase
          .from('employee_work_weeks')
          .insert({
            employee_id: employeeId,
            pattern: input.pattern,
            effective_from: effectiveFrom,
            effective_to: null,
          })
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to save working week.', 500);
        }
        saved = data as WorkWeekRow;
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'employee.work_week_create',
          entityType: 'employee_work_week',
          entityId: saved.id,
          newValues: { pattern: input.pattern, effectiveFrom },
          ...meta,
        });
      }

      // Guarantee the row just saved is the only Current assignment.
      const { data: leftovers, error: leftoverError } = await supabase
        .from('employee_work_weeks')
        .select('id, effective_from')
        .eq('employee_id', employeeId)
        .is('effective_to', null)
        .neq('id', saved.id);
      if (leftoverError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to verify working week.', 500);
      }
      for (const row of leftovers ?? []) {
        const { error: closeError } = await supabase
          .from('employee_work_weeks')
          .update({
            effective_to: closeDateForOpenRow(effectiveFrom, String(row.effective_from).slice(0, 10)),
          })
          .eq('id', row.id as string);
        if (closeError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to close previous working week.', 500);
        }
      }

      return mapWorkWeek({ ...saved, effective_to: null });
    },
  };
}

export type WorkWeekService = ReturnType<typeof createWorkWeekService>;
