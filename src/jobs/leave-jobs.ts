import type { SupabaseClient } from '@supabase/supabase-js';
import { formatIsoDate } from '../modules/leave/day-count';
import { currentPeriod, loadActivePolicy } from '../modules/leave/support';
import { computeCarryForward, previousPeriod } from './leave-allocation-helpers';

export type AnnualAllocationResult = {
  period: string;
  created: number;
  skippedExisting: number;
  carriedForwardTotal: number;
};

/**
 * Creates leave_allocations for the given calendar period from published policy annual_allocation.
 * Unique (employee, leave_type, period) prevents double-allocation on re-run.
 * Carry-forward from the previous period is applied as ADMIN_ADJUSTMENT up to policy.carryForward;
 * excess available balance expires.
 */
export async function runAnnualLeaveAllocation(
  supabase: SupabaseClient,
  period = currentPeriod(),
): Promise<AnnualAllocationResult> {
  const { data: employees, error: empError } = await supabase
    .from('employees')
    .select('id')
    .eq('status', 'active');
  if (empError) {
    throw new Error(`Failed to load employees: ${empError.message}`);
  }

  const { data: leaveTypes, error: typeError } = await supabase
    .from('leave_types')
    .select('id')
    .eq('active', true);
  if (typeError) {
    throw new Error(`Failed to load leave types: ${typeError.message}`);
  }

  let created = 0;
  let skippedExisting = 0;
  let carriedForwardTotal = 0;
  const prior = previousPeriod(period);

  for (const employee of employees ?? []) {
    const employeeId = employee.id as string;
    for (const leaveType of leaveTypes ?? []) {
      const leaveTypeId = leaveType.id as string;
      let rules;
      try {
        ({ rules } = await loadActivePolicy(supabase, leaveTypeId));
      } catch {
        continue;
      }

      if (rules.annualAllocation <= 0 && rules.carryForward <= 0) {
        continue;
      }

      const { data: existing } = await supabase
        .from('leave_allocations')
        .select('id')
        .eq('employee_id', employeeId)
        .eq('leave_type_id', leaveTypeId)
        .eq('period', period)
        .maybeSingle();

      if (existing) {
        skippedExisting += 1;
        continue;
      }

      let carry = 0;
      if (rules.carryForward > 0) {
        const { data: prevAlloc } = await supabase
          .from('leave_allocations')
          .select('id, available')
          .eq('employee_id', employeeId)
          .eq('leave_type_id', leaveTypeId)
          .eq('period', prior)
          .maybeSingle();
        if (prevAlloc) {
          carry = computeCarryForward(Number(prevAlloc.available), rules.carryForward);
        }
      }

      const annual = rules.annualAllocation;
      if (annual <= 0 && carry <= 0) {
        continue;
      }

      const { data: allocation, error: insertError } = await supabase
        .from('leave_allocations')
        .insert({
          employee_id: employeeId,
          leave_type_id: leaveTypeId,
          period,
          allocated: annual,
          carried_forward: carry,
          available: annual + carry,
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') {
          skippedExisting += 1;
          continue;
        }
        throw new Error(`Failed to create allocation: ${insertError.message}`);
      }

      const ledgerRows: Record<string, unknown>[] = [];
      if (annual > 0) {
        ledgerRows.push({
          employee_id: employeeId,
          leave_type_id: leaveTypeId,
          allocation_id: allocation.id,
          transaction_type: 'ALLOCATION',
          quantity: annual,
          reference_type: 'period',
        });
      }
      if (carry > 0) {
        ledgerRows.push({
          employee_id: employeeId,
          leave_type_id: leaveTypeId,
          allocation_id: allocation.id,
          transaction_type: 'ADMIN_ADJUSTMENT',
          quantity: carry,
          reference_type: 'carry_forward',
          reference_id: null,
        });
        carriedForwardTotal += carry;
      }

      if (ledgerRows.length > 0) {
        const { error: ledgerError } = await supabase.from('leave_ledger').insert(ledgerRows);
        if (ledgerError) {
          throw new Error(`Failed to write allocation ledger: ${ledgerError.message}`);
        }
      }

      await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
      created += 1;
    }
  }

  return { period, created, skippedExisting, carriedForwardTotal };
}

export type ReminderResult = {
  leaveReminders: number;
  policyReminders: number;
  date: string;
};

export async function runDailyReminders(supabase: SupabaseClient, now = new Date()): Promise<ReminderResult> {
  const today = formatIsoDate(now);
  const dayStart = `${today}T00:00:00.000Z`;
  const dayEnd = `${today}T23:59:59.999Z`;

  let leaveReminders = 0;
  let policyReminders = 0;

  const { data: pendingLeaves } = await supabase
    .from('leave_applications')
    .select('id, employees ( full_name )')
    .eq('status', 'PENDING');

  const { data: adminRoles } = await supabase
    .from('employee_roles')
    .select('employees ( user_id ), roles ( code )');

  const adminUserIds = new Set<string>();
  for (const row of adminRoles ?? []) {
    const role = (row as { roles?: { code?: string } | { code?: string }[] }).roles;
    const code = Array.isArray(role) ? role[0]?.code : role?.code;
    if (code !== 'HR_MANAGER') continue;
    const employee = (row as { employees?: { user_id?: string } | { user_id?: string }[] }).employees;
    const userId = Array.isArray(employee) ? employee[0]?.user_id : employee?.user_id;
    if (userId) adminUserIds.add(userId);
  }

  for (const leave of pendingLeaves ?? []) {
    const leaveId = leave.id as string;
    const nameRel = (leave as { employees?: { full_name?: string } | { full_name?: string }[] }).employees;
    const name = Array.isArray(nameRel) ? nameRel[0]?.full_name : nameRel?.full_name;

    for (const userId of adminUserIds) {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'leave_reminder')
        .eq('reference_id', leaveId)
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd);
      if ((count ?? 0) > 0) continue;

      await supabase.from('notifications').insert({
        user_id: userId,
        type: 'leave_reminder',
        title: 'Pending leave approval',
        message: `${name ?? 'An employee'} still has a leave request awaiting approval.`,
        reference_type: 'leave_application',
        reference_id: leaveId,
      });
      leaveReminders += 1;
    }
  }

  const { data: policies } = await supabase.from('hr_policies').select('id, title');
  for (const policy of policies ?? []) {
    const { data: version } = await supabase
      .from('hr_policy_versions')
      .select('id, acknowledgement_required, version_label')
      .eq('policy_id', policy.id)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!version?.acknowledgement_required) continue;

    const { data: acks } = await supabase
      .from('policy_acknowledgements')
      .select('employee_id')
      .eq('version_id', version.id);
    const acknowledged = new Set((acks ?? []).map((row) => row.employee_id as string));

    const { data: activeEmployees } = await supabase
      .from('employees')
      .select('id, user_id')
      .eq('status', 'active')
      .not('user_id', 'is', null);

    for (const emp of activeEmployees ?? []) {
      if (acknowledged.has(emp.id as string)) continue;
      const userId = emp.user_id as string;

      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'policy_reminder')
        .eq('reference_id', version.id)
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd);
      if ((count ?? 0) > 0) continue;

      await supabase.from('notifications').insert({
        user_id: userId,
        type: 'policy_reminder',
        title: 'Policy acknowledgement required',
        message: `Please acknowledge ${(policy as { title: string }).title} (${version.version_label as string}).`,
        reference_type: 'hr_policy_version',
        reference_id: version.id,
      });
      policyReminders += 1;
    }
  }

  return { leaveReminders, policyReminders, date: today };
}
