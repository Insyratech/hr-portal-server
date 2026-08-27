import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canWriteDirectoryShiftAssignments } from '../employees/access';
import { assertCanStaffDirectoryTarget } from '../employees/staff-target';
import {
  addUtcDays,
  formatIsoDate,
  isWeekPattern,
  parseIsoDate,
  type WeekPattern,
  type WorkWeekRecord,
} from '../leave/day-count';

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

      if (existing) {
        const { data, error } = await supabase
          .from('employee_work_weeks')
          .update({ pattern: input.pattern })
          .eq('id', (existing as WorkWeekRow).id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update working week.', 500);
        }
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'employee.work_week_update',
          entityType: 'employee_work_week',
          entityId: data.id as string,
          newValues: { pattern: input.pattern, effectiveFrom },
          ...meta,
        });
        return mapWorkWeek(data as WorkWeekRow);
      }

      const previousOpen = await supabase
        .from('employee_work_weeks')
        .select('id, effective_from')
        .eq('employee_id', employeeId)
        .is('effective_to', null)
        .lt('effective_from', effectiveFrom);
      const closeTo = formatIsoDate(addUtcDays(parseIsoDate(effectiveFrom), -1));
      for (const row of previousOpen.data ?? []) {
        if ((row.effective_from as string) > closeTo) {
          continue;
        }
        await supabase.from('employee_work_weeks').update({ effective_to: closeTo }).eq('id', row.id);
      }

      const { data, error } = await supabase
        .from('employee_work_weeks')
        .insert({
          employee_id: employeeId,
          pattern: input.pattern,
          effective_from: effectiveFrom,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to save working week.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.work_week_create',
        entityType: 'employee_work_week',
        entityId: data.id as string,
        newValues: { pattern: input.pattern, effectiveFrom },
        ...meta,
      });
      return mapWorkWeek(data as WorkWeekRow);
    },
  };
}

export type WorkWeekService = ReturnType<typeof createWorkWeekService>;
