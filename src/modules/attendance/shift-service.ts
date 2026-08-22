import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { mapShift, type ShiftRow } from './support';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export function createShiftService(supabase: SupabaseClient) {
  return {
    async list() {
      const { data, error } = await supabase.from('shifts').select('*').order('name');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shifts.', 500);
      return ((data ?? []) as ShiftRow[]).map(mapShift);
    },

    async create(
      actor: RequestUser,
      input: {
        name: string;
        startTime: string;
        endTime: string;
        minimumDurationMinutes: number;
        gracePeriodMinutes?: number;
        lateThresholdMinutes?: number;
        earlyExitThresholdMinutes?: number;
        flexible?: boolean;
      },
      meta: RequestMeta,
    ) {
      if (!actor.permissions.includes(PERMISSIONS.SHIFTS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage shifts.', 403);
      }
      const { data, error } = await supabase
        .from('shifts')
        .insert({
          name: input.name,
          start_time: input.startTime,
          end_time: input.endTime,
          minimum_duration_minutes: input.minimumDurationMinutes,
          grace_period_minutes: input.gracePeriodMinutes ?? 0,
          late_threshold_minutes: input.lateThresholdMinutes ?? 0,
          early_exit_threshold_minutes: input.earlyExitThresholdMinutes ?? 0,
          flexible: input.flexible ?? false,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'Shift name already exists.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create shift.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift.create',
        entityType: 'shift',
        entityId: data.id as string,
        newValues: mapShift(data as ShiftRow),
        ...meta,
      });
      return mapShift(data as ShiftRow);
    },

    async update(actor: RequestUser, id: string, input: Record<string, unknown>, meta: RequestMeta) {
      if (!actor.permissions.includes(PERMISSIONS.SHIFTS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage shifts.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.startTime !== undefined) patch.start_time = input.startTime;
      if (input.endTime !== undefined) patch.end_time = input.endTime;
      if (input.minimumDurationMinutes !== undefined) patch.minimum_duration_minutes = input.minimumDurationMinutes;
      if (input.gracePeriodMinutes !== undefined) patch.grace_period_minutes = input.gracePeriodMinutes;
      if (input.lateThresholdMinutes !== undefined) patch.late_threshold_minutes = input.lateThresholdMinutes;
      if (input.earlyExitThresholdMinutes !== undefined) {
        patch.early_exit_threshold_minutes = input.earlyExitThresholdMinutes;
      }
      if (input.flexible !== undefined) patch.flexible = input.flexible;
      if (input.active !== undefined) patch.active = input.active;

      const { data, error } = await supabase.from('shifts').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update shift.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Shift not found.', 404);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift.update',
        entityType: 'shift',
        entityId: id,
        newValues: mapShift(data as ShiftRow),
        ...meta,
      });
      return mapShift(data as ShiftRow);
    },

    async assign(actor: RequestUser, input: { employeeId: string; shiftId: string; effectiveFrom?: string }, meta: RequestMeta) {
      if (!actor.permissions.includes(PERMISSIONS.SHIFTS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot assign shifts.', 403);
      }
      const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('shift_assignments')
        .insert({
          employee_id: input.employeeId,
          shift_id: input.shiftId,
          effective_from: effectiveFrom,
        })
        .select('id, employee_id, shift_id, effective_from')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A shift assignment already exists for this effective date.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign shift.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift.assign',
        entityType: 'shift_assignment',
        entityId: data.id as string,
        newValues: data as Record<string, unknown>,
        ...meta,
      });
      const { data: shift } = await supabase.from('shifts').select('name').eq('id', data.shift_id).maybeSingle();
      const shiftName = (shift?.name as string | undefined) ?? 'a shift';
      await notifyStaff(supabase, await loadStaffById(supabase, data.employee_id as string), {
        type: 'attendance',
        title: 'Shift assigned',
        message: `${shiftName} is effective from ${data.effective_from as string}.`,
        referenceType: 'shift_assignment',
        referenceId: data.id as string,
        eyebrow: 'Attendance',
        paragraphs: [
          `An administrator assigned you to ${shiftName}, effective ${data.effective_from as string}.`,
        ],
        details: [
          { label: 'Shift', value: shiftName },
          { label: 'Effective from', value: data.effective_from as string },
        ],
        ctaLabel: 'Open HR Portal',
      });
      return {
        id: data.id as string,
        employeeId: data.employee_id as string,
        shiftId: data.shift_id as string,
        effectiveFrom: data.effective_from as string,
      };
    },

    async listAssignments() {
      const { data, error } = await supabase
        .from('shift_assignments')
        .select('id, employee_id, shift_id, effective_from, effective_to, employees (full_name), shifts (name)')
        .order('effective_from', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift assignments.', 500);
      return (data ?? []).map((row) => {
        const employee = row.employees as { full_name: string } | { full_name: string }[] | null;
        const shift = row.shifts as { name: string } | { name: string }[] | null;
        return {
          id: row.id as string,
          employeeId: row.employee_id as string,
          employeeName: (Array.isArray(employee) ? employee[0]?.full_name : employee?.full_name) ?? null,
          shiftId: row.shift_id as string,
          shiftName: (Array.isArray(shift) ? shift[0]?.name : shift?.name) ?? null,
          effectiveFrom: row.effective_from as string,
          effectiveTo: (row.effective_to as string | null) ?? null,
        };
      });
    },
  };
}
