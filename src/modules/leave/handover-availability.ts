import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import {
  listApprovedShiftOverrides,
  overrideShiftIdOnDate,
  type ApprovedShiftOverride,
} from '../shift-changes/service';

type ShiftAssignmentRow = {
  employee_id: string;
  shift_id: string;
  effective_from: string;
  effective_to: string | null;
};

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

/** Inclusive calendar days between start and end (ISO dates). */
export function eachIsoDateInclusive(startDate: string, endDate: string): string[] {
  const start = dateOnly(startDate);
  const end = dateOnly(endDate);
  const out: string[] = [];
  const cursor = new Date(`${start}T12:00:00.000Z`);
  const last = new Date(`${end}T12:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export async function employeeIdsOnLeave(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<Map<string, { startDate: string; endDate: string }>> {
  const { data, error } = await supabase
    .from('leave_applications')
    .select('employee_id, start_date, end_date')
    .in('status', ['PENDING', 'APPROVED'])
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check colleague leave.', 500);
  }
  const busy = new Map<string, { startDate: string; endDate: string }>();
  for (const row of data ?? []) {
    const id = String(row.employee_id);
    if (!busy.has(id)) {
      busy.set(id, { startDate: dateOnly(String(row.start_date)), endDate: dateOnly(String(row.end_date)) });
    }
  }
  return busy;
}

/**
 * Employees who have accepted handover for a pending/approved leave overlapping [start, end].
 * They must not apply leave on those coverage days (including sick / ML).
 */
export async function employeeIdsCoveringHandover(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<Map<string, { startDate: string; endDate: string; applicantId: string; applicantName?: string }>> {
  const { data, error } = await supabase
    .from('leave_applications')
    .select('handover_employee_id, start_date, end_date, employee_id, leave_approvals ( approver_role, status )')
    .in('status', ['PENDING', 'APPROVED'])
    .not('handover_employee_id', 'is', null)
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check handover coverage.', 500);
  }
  const covering = mapCoveringRows(data ?? []);
  const applicantIds = [...new Set([...covering.values()].map((row) => row.applicantId))];
  if (applicantIds.length === 0) return covering;
  const { data: names } = await supabase.from('employees').select('id, full_name').in('id', applicantIds);
  const byId = new Map((names ?? []).map((row) => [row.id as string, row.full_name as string]));
  for (const entry of covering.values()) {
    entry.applicantName = byId.get(entry.applicantId);
  }
  return covering;
}

function mapCoveringRows(
  rows: {
    handover_employee_id?: string | null;
    employee_id?: string;
    start_date: string;
    end_date: string;
    leave_approvals?: { approver_role: string; status: string }[] | null;
  }[],
): Map<string, { startDate: string; endDate: string; applicantId: string; applicantName?: string }> {
  const covering = new Map<string, { startDate: string; endDate: string; applicantId: string; applicantName?: string }>();
  for (const row of rows) {
    const handoverId = row.handover_employee_id ? String(row.handover_employee_id) : null;
    const applicantId = row.employee_id ? String(row.employee_id) : null;
    if (!handoverId || !applicantId) continue;
    const approvals = row.leave_approvals ?? [];
    const handoverAccepted = approvals.some(
      (item) => item.approver_role === 'HANDOVER' && item.status === 'APPROVED',
    );
    if (!handoverAccepted) continue;
    if (covering.has(handoverId)) continue;
    covering.set(handoverId, {
      startDate: dateOnly(String(row.start_date)),
      endDate: dateOnly(String(row.end_date)),
      applicantId,
    });
  }
  return covering;
}

export async function assertApplicantNotCoveringHandover(
  supabase: SupabaseClient,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const rangeStart = dateOnly(startDate);
  const rangeEnd = dateOnly(endDate);
  const { data, error } = await supabase
    .from('leave_applications')
    .select('start_date, end_date, employee_id, leave_approvals ( approver_role, status )')
    .eq('handover_employee_id', employeeId)
    .in('status', ['PENDING', 'APPROVED'])
    .lte('start_date', rangeEnd)
    .gte('end_date', rangeStart);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check handover coverage.', 500);
  }
  for (const row of data ?? []) {
    const approvals = (row.leave_approvals ?? []) as { approver_role: string; status: string }[];
    const handoverAccepted = approvals.some(
      (item) => item.approver_role === 'HANDOVER' && item.status === 'APPROVED',
    );
    if (!handoverAccepted) continue;
    const { data: applicant } = await supabase
      .from('employees')
      .select('full_name')
      .eq('id', row.employee_id)
      .maybeSingle();
    const who = applicant?.full_name ? ` for ${applicant.full_name as string}` : '';
    throw new AppError(
      API_ERROR_CODES.LEAVE_OVERLAP,
      `You accepted handover${who} from ${dateOnly(String(row.start_date))} to ${dateOnly(String(row.end_date))}. You cannot apply leave on those days while covering. Ask GM to adjust LOP on the salary slip only if the absence is genuine.`,
      400,
    );
  }
}

function shiftIdOnDate(
  employeeId: string,
  isoDate: string,
  assignments: ShiftAssignmentRow[],
  overrides: ApprovedShiftOverride[],
): string | null {
  const overrideId = overrideShiftIdOnDate(overrides, employeeId, isoDate);
  if (overrideId) return overrideId;
  const current = assignments
    .filter((row) => {
      if (row.employee_id !== employeeId) return false;
      const from = dateOnly(row.effective_from);
      const to = row.effective_to ? dateOnly(row.effective_to) : null;
      return from <= isoDate && (!to || to >= isoDate);
    })
    .sort((a, b) => (dateOnly(a.effective_from) < dateOnly(b.effective_from) ? 1 : -1))[0];
  return current?.shift_id ?? null;
}

async function loadShiftAssignments(
  supabase: SupabaseClient,
  employeeIds?: string[],
): Promise<ShiftAssignmentRow[]> {
  let query = supabase
    .from('shift_assignments')
    .select('employee_id, shift_id, effective_from, effective_to');
  if (employeeIds && employeeIds.length > 0) {
    query = query.in('employee_id', employeeIds);
  }
  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift assignments.', 500);
  }
  return (data ?? []).map((row) => ({
    employee_id: row.employee_id as string,
    shift_id: row.shift_id as string,
    effective_from: String(row.effective_from),
    effective_to: (row.effective_to as string | null) ?? null,
  }));
}

export function sharesShiftOnAllDates(
  applicantId: string,
  colleagueId: string,
  startDate: string,
  endDate: string,
  assignments: ShiftAssignmentRow[],
  overrides: ApprovedShiftOverride[],
): boolean {
  for (const iso of eachIsoDateInclusive(startDate, endDate)) {
    const applicantShift = shiftIdOnDate(applicantId, iso, assignments, overrides);
    const colleagueShift = shiftIdOnDate(colleagueId, iso, assignments, overrides);
    if (applicantShift !== colleagueShift) return false;
  }
  return true;
}

export async function assertHandoverColleagueEligible(
  supabase: SupabaseClient,
  applicantId: string,
  colleagueId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  if (colleagueId === applicantId) {
    throw new AppError(API_ERROR_CODES.HANDOVER_REQUIRED, 'Select a colleague to take handover.', 400);
  }

  const busy = await employeeIdsOnLeave(supabase, startDate, endDate);
  const clash = busy.get(colleagueId);
  if (clash) {
    throw new AppError(
      API_ERROR_CODES.HANDOVER_REQUIRED,
      `This colleague is on leave from ${clash.startDate} to ${clash.endDate}. Choose someone who is at work.`,
      400,
    );
  }

  const { data: otherCoverage, error: coverError } = await supabase
    .from('leave_applications')
    .select('id, start_date, end_date, leave_approvals ( approver_role, status )')
    .eq('handover_employee_id', colleagueId)
    .neq('employee_id', applicantId)
    .in('status', ['PENDING', 'APPROVED'])
    .lte('start_date', dateOnly(endDate))
    .gte('end_date', dateOnly(startDate));
  if (coverError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check handover coverage.', 500);
  }
  const blockingCoverage = (otherCoverage ?? []).find((row) =>
    ((row.leave_approvals ?? []) as { approver_role: string; status: string }[]).some(
      (item) => item.approver_role === 'HANDOVER' && item.status === 'APPROVED',
    ),
  );
  if (blockingCoverage) {
    throw new AppError(
      API_ERROR_CODES.HANDOVER_REQUIRED,
      `This colleague is already covering handover from ${dateOnly(String(blockingCoverage.start_date))} to ${dateOnly(String(blockingCoverage.end_date))}. Choose someone else.`,
      400,
    );
  }

  const [assignments, overrides] = await Promise.all([
    loadShiftAssignments(supabase, [applicantId, colleagueId]),
    listApprovedShiftOverrides(supabase, dateOnly(startDate), dateOnly(endDate)),
  ]);
  if (!sharesShiftOnAllDates(applicantId, colleagueId, startDate, endDate, assignments, overrides)) {
    throw new AppError(
      API_ERROR_CODES.HANDOVER_REQUIRED,
      'Handover must go to a colleague on the same shift for every day of this leave.',
      400,
    );
  }
}

/** @deprecated Use assertHandoverColleagueEligible — kept name for call-site clarity during transition. */
export async function assertHandoverColleagueFree(
  supabase: SupabaseClient,
  colleagueId: string,
  startDate: string,
  endDate: string,
  applicantId?: string,
): Promise<void> {
  if (applicantId) {
    await assertHandoverColleagueEligible(supabase, applicantId, colleagueId, startDate, endDate);
    return;
  }
  const busy = await employeeIdsOnLeave(supabase, startDate, endDate);
  const clash = busy.get(colleagueId);
  if (clash) {
    throw new AppError(
      API_ERROR_CODES.HANDOVER_REQUIRED,
      `This colleague is on leave from ${clash.startDate} to ${clash.endDate}. Choose someone who is at work.`,
      400,
    );
  }
}

export type HandoverColleagueOption = {
  id: string;
  fullName: string;
  available: boolean;
  leaveDates: string | null;
  unavailableReason: string | null;
};

export async function listSameShiftHandoverColleagues(
  supabase: SupabaseClient,
  applicantId: string,
  startDate: string,
  endDate: string,
): Promise<HandoverColleagueOption[]> {
  const rangeStart = dateOnly(startDate);
  const rangeEnd = dateOnly(endDate);

  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('status', 'active')
    .neq('id', applicantId)
    .order('full_name');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load colleagues.', 500);
  }

  const rows = data ?? [];
  const ids = rows.map((row) => row.id as string);
  const [busy, covering, assignments, overrides] = await Promise.all([
    employeeIdsOnLeave(supabase, rangeStart, rangeEnd),
    employeeIdsCoveringHandover(supabase, rangeStart, rangeEnd),
    loadShiftAssignments(supabase, [applicantId, ...ids]),
    listApprovedShiftOverrides(supabase, rangeStart, rangeEnd),
  ]);

  const options: HandoverColleagueOption[] = [];
  for (const row of rows) {
    const id = row.id as string;
    if (!sharesShiftOnAllDates(applicantId, id, rangeStart, rangeEnd, assignments, overrides)) {
      continue;
    }
    const leaveClash = busy.get(id);
    const coverClash = covering.get(id);
    if (leaveClash) {
      options.push({
        id,
        fullName: row.full_name as string,
        available: false,
        leaveDates: `${leaveClash.startDate} – ${leaveClash.endDate}`,
        unavailableReason: `On leave ${leaveClash.startDate} – ${leaveClash.endDate}`,
      });
      continue;
    }
    if (coverClash && coverClash.applicantId !== applicantId) {
      // Same-shift person covering someone else — still listed as unavailable.
      options.push({
        id,
        fullName: row.full_name as string,
        available: false,
        leaveDates: `${coverClash.startDate} – ${coverClash.endDate}`,
        unavailableReason: `Covering handover ${coverClash.startDate} – ${coverClash.endDate}`,
      });
      continue;
    }
    options.push({
      id,
      fullName: row.full_name as string,
      available: true,
      leaveDates: null,
      unavailableReason: null,
    });
  }
  return options;
}
