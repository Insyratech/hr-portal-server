import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  computeAndPersistStatus,
  loadShiftForEmployee,
  mapShift,
  todayIso,
} from './support';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };
type Location = { latitude?: number; longitude?: number };

type AttendanceRow = {
  id: string;
  employee_id: string;
  attendance_date: string;
  shift_id: string | null;
  scheduled_in: string | null;
  scheduled_out: string | null;
  actual_in: string | null;
  actual_out: string | null;
  worked_minutes: number | null;
  status: string;
  late_minutes: number;
  early_exit_minutes: number;
  overtime_minutes: number;
  employees?: { full_name: string } | { full_name: string }[] | null;
  shifts?: { name: string } | { name: string }[] | null;
};

function first<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function mapAttendance(row: AttendanceRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: first(row.employees)?.full_name ?? null,
    attendanceDate: row.attendance_date,
    shiftId: row.shift_id,
    shiftName: first(row.shifts)?.name ?? null,
    scheduledIn: row.scheduled_in,
    scheduledOut: row.scheduled_out,
    actualIn: row.actual_in,
    actualOut: row.actual_out,
    workedMinutes: row.worked_minutes,
    status: row.status,
    lateMinutes: row.late_minutes,
    earlyExitMinutes: row.early_exit_minutes,
    overtimeMinutes: row.overtime_minutes,
  };
}

async function notifyAdmins(
  supabase: SupabaseClient,
  input: { title: string; message: string; referenceId: string },
): Promise<void> {
  const { data } = await supabase.from('employee_roles').select('employees ( user_id ), roles ( code )');
  const userIds = new Set<string>();
  for (const row of data ?? []) {
    const role = (row as { roles?: { code?: string } | { code?: string }[] }).roles;
    const code = Array.isArray(role) ? role[0]?.code : role?.code;
    if (code !== 'ADMIN' && code !== 'SUPER_ADMIN') continue;
    const employee = (row as { employees?: { user_id?: string } | { user_id?: string }[] }).employees;
    const userId = Array.isArray(employee) ? employee[0]?.user_id : employee?.user_id;
    if (userId) userIds.add(userId);
  }
  for (const userId of userIds) {
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'attendance',
      title: input.title,
      message: input.message,
      reference_type: 'attendance_correction',
      reference_id: input.referenceId,
    });
  }
}

export function createAttendanceService(supabase: SupabaseClient) {
  return {
    async getMine(actor: RequestUser, date?: string) {
      const attendanceDate = date ?? todayIso();
      let { data: record } = await supabase
        .from('attendance_records')
        .select('*, shifts (name)')
        .eq('employee_id', actor.employeeId)
        .eq('attendance_date', attendanceDate)
        .maybeSingle();

      const shift = await loadShiftForEmployee(supabase, actor.employeeId, attendanceDate);

      if (!record) {
        const derivedSeed = {
          employee_id: actor.employeeId,
          attendance_date: attendanceDate,
          shift_id: shift?.id ?? null,
          status: 'ABSENT',
        };
        const { data: created, error } = await supabase
          .from('attendance_records')
          .insert(derivedSeed)
          .select('*, shifts (name)')
          .single();
        if (error || !created) {
          if (error?.code === '23505') {
            const { data: existing } = await supabase
              .from('attendance_records')
              .select('*, shifts (name)')
              .eq('employee_id', actor.employeeId)
              .eq('attendance_date', attendanceDate)
              .maybeSingle();
            record = existing;
          } else {
            throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load attendance.', 500);
          }
        } else {
          record = created;
        }
      }

      if (!record) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load attendance.', 500);
      }

      const refreshed = await computeAndPersistStatus(
        supabase,
        {
          id: record.id as string,
          employee_id: actor.employeeId,
          attendance_date: attendanceDate,
          shift_id: (record.shift_id as string | null) ?? null,
          actual_in: (record.actual_in as string | null) ?? null,
          actual_out: (record.actual_out as string | null) ?? null,
        },
        shift,
      );

      const { data: todayRow } = await supabase
        .from('attendance_records')
        .select('*, shifts (name)')
        .eq('id', refreshed.id as string)
        .single();

      const { data: history } = await supabase
        .from('attendance_records')
        .select('*, shifts (name)')
        .eq('employee_id', actor.employeeId)
        .order('attendance_date', { ascending: false })
        .limit(30);

      return {
        today: mapAttendance((todayRow ?? refreshed) as AttendanceRow),
        shift: shift ? mapShift(shift) : null,
        history: ((history ?? []) as AttendanceRow[]).map(mapAttendance),
      };
    },

    async punchIn(actor: RequestUser, location: Location, meta: RequestMeta) {
      const attendanceDate = todayIso();
      const shift = await loadShiftForEmployee(supabase, actor.employeeId, attendanceDate);
      if (!shift) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No shift is assigned. Ask Super Admin to assign a shift.', 400);
      }

      const serverNow = new Date();
      const { data: existing } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .eq('attendance_date', attendanceDate)
        .maybeSingle();

      if (existing?.actual_in) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Already punched in for today.', 409);
      }

      const payload = {
        employee_id: actor.employeeId,
        attendance_date: attendanceDate,
        shift_id: shift.id,
        actual_in: serverNow.toISOString(),
        punch_in_latitude: location.latitude ?? null,
        punch_in_longitude: location.longitude ?? null,
        status: 'MISSING_PUNCH',
      };

      let recordId: string;
      if (existing) {
        const { data, error } = await supabase
          .from('attendance_records')
          .update(payload)
          .eq('id', existing.id)
          .select('id, employee_id, attendance_date, shift_id, actual_in, actual_out')
          .single();
        if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to punch in.', 500);
        recordId = data.id as string;
        await computeAndPersistStatus(supabase, data as never, shift);
      } else {
        const { data, error } = await supabase
          .from('attendance_records')
          .insert(payload)
          .select('id, employee_id, attendance_date, shift_id, actual_in, actual_out')
          .single();
        if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to punch in.', 500);
        recordId = data.id as string;
        await computeAndPersistStatus(supabase, data as never, shift);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.punch_in',
        entityType: 'attendance_record',
        entityId: recordId,
        newValues: { actualIn: serverNow.toISOString() },
        ...meta,
      });

      return (await this.getMine(actor)).today;
    },

    async punchOut(actor: RequestUser, location: Location, meta: RequestMeta) {
      const attendanceDate = todayIso();
      const shift = await loadShiftForEmployee(supabase, actor.employeeId, attendanceDate);
      const { data: existing } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .eq('attendance_date', attendanceDate)
        .maybeSingle();

      if (!existing?.actual_in) {
        throw new AppError(API_ERROR_CODES.MISSING_PUNCH, 'Punch out requires punch in first.', 400);
      }
      if (existing.actual_out) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Already punched out for today.', 409);
      }

      const serverNow = new Date();
      const { data, error } = await supabase
        .from('attendance_records')
        .update({
          actual_out: serverNow.toISOString(),
          punch_out_latitude: location.latitude ?? null,
          punch_out_longitude: location.longitude ?? null,
        })
        .eq('id', existing.id)
        .select('id, employee_id, attendance_date, shift_id, actual_in, actual_out')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to punch out.', 500);

      await computeAndPersistStatus(supabase, data as never, shift);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.punch_out',
        entityType: 'attendance_record',
        entityId: data.id as string,
        newValues: { actualOut: serverNow.toISOString() },
        ...meta,
      });

      return (await this.getMine(actor)).today;
    },

    async listForDate(actor: RequestUser, date?: string) {
      if (
        !actor.permissions.includes(PERMISSIONS.ATTENDANCE_VIEW) &&
        !actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE)
      ) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view attendance records.', 403);
      }
      const attendanceDate = date ?? todayIso();
      const { data, error } = await supabase
        .from('attendance_records')
        .select('*, employees (full_name), shifts (name)')
        .eq('attendance_date', attendanceDate)
        .order('created_at', { ascending: true });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load attendance.', 500);

      const rows = ((data ?? []) as AttendanceRow[]).map(mapAttendance);
      const counts = {
        present: rows.filter((row) => row.status === 'PRESENT').length,
        late: rows.filter((row) => row.status === 'LATE').length,
        absent: rows.filter((row) => row.status === 'ABSENT').length,
        onLeave: rows.filter((row) => row.status === 'LEAVE').length,
        missingPunch: rows.filter((row) => row.status === 'MISSING_PUNCH').length,
      };
      return { date: attendanceDate, counts, records: rows };
    },

    async submitCorrection(
      actor: RequestUser,
      input: { date: string; proposedIn: string; proposedOut: string; reason: string },
      meta: RequestMeta,
    ) {
      const { data: pending } = await supabase
        .from('attendance_corrections')
        .select('id')
        .eq('employee_id', actor.employeeId)
        .eq('attendance_date', input.date)
        .eq('status', 'PENDING')
        .maybeSingle();
      if (pending) {
        throw new AppError(API_ERROR_CODES.CORRECTION_ALREADY_PENDING, 'A correction is already pending for this date.', 409);
      }

      const proposedIn = new Date(input.proposedIn);
      const proposedOut = new Date(input.proposedOut);
      if (Number.isNaN(proposedIn.getTime()) || Number.isNaN(proposedOut.getTime()) || proposedOut <= proposedIn) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Proposed punch times are invalid.', 400);
      }

      const { data, error } = await supabase
        .from('attendance_corrections')
        .insert({
          employee_id: actor.employeeId,
          attendance_date: input.date,
          proposed_in: proposedIn.toISOString(),
          proposed_out: proposedOut.toISOString(),
          reason: input.reason,
          status: 'PENDING',
        })
        .select('*')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to submit correction.', 500);

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.correction.submit',
        entityType: 'attendance_correction',
        entityId: data.id as string,
        newValues: { date: input.date, reason: input.reason },
        ...meta,
      });
      await notifyAdmins(supabase, {
        title: 'Attendance correction',
        message: 'An employee submitted an attendance correction.',
        referenceId: data.id as string,
      });

      return mapCorrection(data);
    },

    async listCorrections(actor: RequestUser, status?: string) {
      const canManage =
        actor.permissions.includes(PERMISSIONS.ATTENDANCE_CORRECT) ||
        actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE);
      let query = supabase
        .from('attendance_corrections')
        .select('*, employees (full_name)')
        .order('created_at', { ascending: false });
      if (!canManage) {
        query = query.eq('employee_id', actor.employeeId);
      }
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load corrections.', 500);
      return (data ?? []).map(mapCorrection);
    },

    async decideCorrection(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject',
      meta: RequestMeta,
    ) {
      if (
        !actor.permissions.includes(PERMISSIONS.ATTENDANCE_CORRECT) &&
        !actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE)
      ) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide attendance corrections.', 403);
      }

      const { data: correction, error } = await supabase
        .from('attendance_corrections')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !correction) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Correction not found.', 404);
      if (correction.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Correction is not pending.', 400);
      }

      if (action === 'reject') {
        const { data, error: updateError } = await supabase
          .from('attendance_corrections')
          .update({
            status: 'REJECTED',
            actor_id: actor.employeeId,
            decided_at: new Date().toISOString(),
          })
          .eq('id', id)
          .select('*')
          .single();
        if (updateError || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reject correction.', 500);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'attendance.correction.reject',
          entityType: 'attendance_correction',
          entityId: id,
          newValues: mapCorrection(data),
          ...meta,
        });
        return mapCorrection(data);
      }

      const attendanceDate = correction.attendance_date as string;
      const employeeId = correction.employee_id as string;
      const shift = await loadShiftForEmployee(supabase, employeeId, attendanceDate);

      const { data: existing } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('employee_id', employeeId)
        .eq('attendance_date', attendanceDate)
        .maybeSingle();

      const punchPatch = {
        employee_id: employeeId,
        attendance_date: attendanceDate,
        shift_id: shift?.id ?? null,
        actual_in: correction.proposed_in,
        actual_out: correction.proposed_out,
      };

      let record: { id: string; employee_id: string; attendance_date: string; shift_id: string | null; actual_in: string | null; actual_out: string | null };
      if (existing) {
        const { data, error: updateError } = await supabase
          .from('attendance_records')
          .update(punchPatch)
          .eq('id', existing.id)
          .select('id, employee_id, attendance_date, shift_id, actual_in, actual_out')
          .single();
        if (updateError || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to apply correction.', 500);
        record = data as never;
      } else {
        const { data, error: insertError } = await supabase
          .from('attendance_records')
          .insert({ ...punchPatch, status: 'PRESENT' })
          .select('id, employee_id, attendance_date, shift_id, actual_in, actual_out')
          .single();
        if (insertError || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to apply correction.', 500);
        record = data as never;
      }

      await computeAndPersistStatus(supabase, record, shift);

      const { data: decided, error: decideError } = await supabase
        .from('attendance_corrections')
        .update({
          status: 'APPROVED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select('*')
        .single();
      if (decideError || !decided) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to approve correction.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'attendance.correction.approve',
        entityType: 'attendance_correction',
        entityId: id,
        newValues: mapCorrection(decided),
        ...meta,
      });

      const { data: employee } = await supabase.from('employees').select('user_id').eq('id', employeeId).maybeSingle();
      if (employee?.user_id) {
        await supabase.from('notifications').insert({
          user_id: employee.user_id,
          type: 'attendance',
          title: 'Correction approved',
          message: 'Your attendance correction was approved.',
          reference_type: 'attendance_correction',
          reference_id: id,
        });
      }

      return mapCorrection(decided);
    },
  };
}

function mapCorrection(row: Record<string, unknown>) {
  const employee = row.employees as { full_name: string } | { full_name: string }[] | null | undefined;
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    employeeName: (Array.isArray(employee) ? employee[0]?.full_name : employee?.full_name) ?? null,
    attendanceDate: row.attendance_date as string,
    proposedIn: row.proposed_in as string,
    proposedOut: row.proposed_out as string,
    reason: row.reason as string,
    status: row.status as string,
    createdAt: row.created_at as string,
  };
}
