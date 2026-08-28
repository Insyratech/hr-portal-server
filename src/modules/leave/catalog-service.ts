import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { assertGmDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canWriteDirectoryAllocations } from '../employees/access';
import { assertCanStaffDirectoryTarget } from '../employees/staff-target';
import { writeAuditLog } from '../audit/write-audit-log';
import { listActiveStaff, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl } from '../notifications/mail';
import { currentPeriod } from './balance';
import { parsePolicyRules, serializePolicyRules } from './parse-rules';
import type { PolicyRules } from './types';
import { canManagePolicies, canManageTypes } from './support';

export function createLeaveCatalogService(supabase: SupabaseClient) {
  return {
    async listTypes() {
      const { data, error } = await supabase.from('leave_types').select('*').order('name');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave types.', 500);
      return (data ?? []).map(mapType);
    },

    async createType(actor: RequestUser, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageTypes(actor)) throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave types.', 403);
      const { data, error } = await supabase
        .from('leave_types')
        .insert({
          name: input.name,
          code: input.code,
          description: input.description ?? '',
          active: input.active ?? true,
          requires_approval: input.requiresApproval ?? true,
          requires_handover: input.requiresHandover ?? false,
          requires_attachment: input.requiresAttachment ?? false,
          allow_half_day: input.allowHalfDay ?? true,
          allow_multiple_days: input.allowMultipleDays ?? true,
          paid: input.paid ?? true,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'Leave type code already exists.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create leave type.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_type.create',
        entityType: 'leave_type',
        entityId: data.id as string,
        newValues: mapType(data),
        ...meta,
      });
      const created = mapType(data);
      if (canManagePolicies(actor)) {
        const rules = parsePolicyRules(input.rules);
        const policy = await this.createPolicy(
          actor,
          { name: `${created.name} Policy`, leaveTypeId: created.id, rules },
          meta,
        );
        if (policy?.id) {
          await this.publish(actor, policy.id, meta);
        }
      }
      return created;
    },

    async updateType(actor: RequestUser, id: string, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageTypes(actor)) throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave types.', 403);
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.active !== undefined) patch.active = input.active;
      if (input.requiresApproval !== undefined) patch.requires_approval = input.requiresApproval;
      if (input.requiresHandover !== undefined) patch.requires_handover = input.requiresHandover;
      if (input.requiresAttachment !== undefined) patch.requires_attachment = input.requiresAttachment;
      if (input.allowHalfDay !== undefined) patch.allow_half_day = input.allowHalfDay;
      if (input.allowMultipleDays !== undefined) patch.allow_multiple_days = input.allowMultipleDays;
      if (input.paid !== undefined) patch.paid = input.paid;
      const { data, error } = await supabase.from('leave_types').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update leave type.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave type not found.', 404);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_type.update',
        entityType: 'leave_type',
        entityId: id,
        newValues: mapType(data),
        ...meta,
      });
      return mapType(data);
    },

    async listPolicies() {
      const { data, error } = await supabase
        .from('leave_policies')
        .select('id, name, leave_type_id, leave_types (name, code), leave_policy_versions (id, version_number, status, published_at, leave_policy_rules (rules))')
        .order('name');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave policies.', 500);
      return (data ?? []).map(mapPolicy);
    },

    async createPolicy(actor: RequestUser, input: { name: string; leaveTypeId: string; rules: PolicyRules }, meta: RequestMeta) {
      if (!canManagePolicies(actor)) throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave policies.', 403);
      const { data: policy, error } = await supabase
        .from('leave_policies')
        .insert({ name: input.name, leave_type_id: input.leaveTypeId })
        .select('id')
        .single();
      if (error || !policy) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'A policy already exists for this leave type.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create leave policy.', 500);
      }
      const { data: version, error: versionError } = await supabase
        .from('leave_policy_versions')
        .insert({ policy_id: policy.id, version_number: 1, status: 'draft' })
        .select('id')
        .single();
      if (versionError || !version) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create policy version.', 500);
      const { error: rulesError } = await supabase
        .from('leave_policy_rules')
        .insert({ version_id: version.id, rules: serializePolicyRules(input.rules) });
      if (rulesError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save policy rules.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_policy.create',
        entityType: 'leave_policy',
        entityId: policy.id as string,
        newValues: { name: input.name },
        ...meta,
      });
      const list = await this.listPolicies();
      return list.find((item) => item.id === policy.id);
    },

    async addVersion(actor: RequestUser, policyId: string, rules: PolicyRules, meta: RequestMeta) {
      if (!canManagePolicies(actor)) throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave policies.', 403);
      const { data: latest } = await supabase
        .from('leave_policy_versions')
        .select('version_number')
        .eq('policy_id', policyId)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextNumber = (latest?.version_number as number | undefined ?? 0) + 1;
      const { data: version, error } = await supabase
        .from('leave_policy_versions')
        .insert({ policy_id: policyId, version_number: nextNumber, status: 'draft' })
        .select('id')
        .single();
      if (error || !version) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create policy version.', 500);
      await supabase.from('leave_policy_rules').insert({ version_id: version.id, rules: serializePolicyRules(rules) });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_policy.version',
        entityType: 'leave_policy',
        entityId: policyId,
        newValues: { versionNumber: nextNumber },
        ...meta,
      });
      const list = await this.listPolicies();
      return list.find((item) => item.id === policyId);
    },

    async publish(actor: RequestUser, policyId: string, meta: RequestMeta) {
      if (!canManagePolicies(actor)) throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave policies.', 403);
      const { data: draft } = await supabase
        .from('leave_policy_versions')
        .select('id, version_number')
        .eq('policy_id', policyId)
        .eq('status', 'draft')
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!draft) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No draft version to publish.', 400);
      const { error } = await supabase
        .from('leave_policy_versions')
        .update({ status: 'published', published_at: new Date().toISOString() })
        .eq('id', draft.id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to publish policy version.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_policy.publish',
        entityType: 'leave_policy',
        entityId: policyId,
        newValues: { versionId: draft.id },
        ...meta,
      });
      const list = await this.listPolicies();
      return list.find((item) => item.id === policyId);
    },

    async listHolidays() {
      const { data, error } = await supabase.from('holidays').select('*').order('holiday_date');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load holidays.', 500);
      return (data ?? []).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        date: row.holiday_date as string,
        type: row.type as string,
        region: row.region as string,
        optional: Boolean(row.optional),
      }));
    },

    async createHoliday(
      actor: RequestUser,
      input: { name: string; date: string; type?: string; region?: string; optional?: boolean },
      meta: RequestMeta,
    ) {
      if (!actor.permissions.includes(PERMISSIONS.HOLIDAYS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage holidays.', 403);
      }
      assertGmDomainOwner(actor, 'manage holidays');
      const { data, error } = await supabase
        .from('holidays')
        .insert({
          name: input.name,
          holiday_date: input.date,
          type: input.type ?? 'public',
          region: input.region ?? 'IN',
          optional: input.optional ?? false,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'A holiday already exists on this date.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create holiday.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'holiday.create',
        entityType: 'holiday',
        entityId: data.id as string,
        newValues: { name: input.name, date: input.date },
        ...meta,
      });
      const createdHoliday = {
        id: data.id as string,
        name: data.name as string,
        date: data.holiday_date as string,
        type: data.type as string,
        region: data.region as string,
        optional: Boolean(data.optional),
      };
      await notifyStaff(supabase, await listActiveStaff(supabase), {
        type: 'holiday',
        title: 'Holiday calendar updated',
        message: `${createdHoliday.name} on ${createdHoliday.date} was added to the holiday calendar.`,
        referenceType: 'holiday',
        referenceId: createdHoliday.id,
        eyebrow: 'Holiday',
        paragraphs: [
          `A holiday was added to the organisation calendar: ${createdHoliday.name} on ${createdHoliday.date}.`,
          createdHoliday.optional ? 'This holiday is optional.' : 'This is a public holiday.',
        ],
        details: [
          { label: 'Holiday', value: createdHoliday.name },
          { label: 'Date', value: createdHoliday.date },
        ],
        ctaLabel: 'Open holiday calendar',
        ctaHref: portalUrl('/gm/holidays'),
      });
      return createdHoliday;
    },

    async updateHoliday(
      actor: RequestUser,
      id: string,
      input: { name?: string; date?: string; type?: string; region?: string; optional?: boolean },
      meta: RequestMeta,
    ) {
      if (!actor.permissions.includes(PERMISSIONS.HOLIDAYS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage holidays.', 403);
      }
      assertGmDomainOwner(actor, 'manage holidays');
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.date !== undefined) patch.holiday_date = input.date;
      if (input.type !== undefined) patch.type = input.type;
      if (input.region !== undefined) patch.region = input.region;
      if (input.optional !== undefined) patch.optional = input.optional;
      const { data, error } = await supabase.from('holidays').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        if (error.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'A holiday already exists on this date.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update holiday.', 500);
      }
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Holiday not found.', 404);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'holiday.update',
        entityType: 'holiday',
        entityId: id,
        newValues: { name: data.name, date: data.holiday_date },
        ...meta,
      });
      const updatedHoliday = {
        id: data.id as string,
        name: data.name as string,
        date: data.holiday_date as string,
        type: data.type as string,
        region: data.region as string,
        optional: Boolean(data.optional),
      };
      await notifyStaff(supabase, await listActiveStaff(supabase), {
        type: 'holiday',
        title: 'Holiday calendar updated',
        message: `${updatedHoliday.name} on ${updatedHoliday.date} was updated.`,
        referenceType: 'holiday',
        referenceId: updatedHoliday.id,
        eyebrow: 'Holiday',
        paragraphs: [
          `The holiday calendar was updated: ${updatedHoliday.name} is now on ${updatedHoliday.date}.`,
        ],
        details: [
          { label: 'Holiday', value: updatedHoliday.name },
          { label: 'Date', value: updatedHoliday.date },
        ],
        ctaLabel: 'Open holiday calendar',
        ctaHref: portalUrl('/gm/holidays'),
      });
      return updatedHoliday;
    },

    async listAllocations(actor: RequestUser, filters?: { employeeId?: string }) {
      const canManageAll =
        canWriteDirectoryAllocations(actor) || actor.permissions.includes(PERMISSIONS.USERS_VIEW);
      const canReadOwn = actor.permissions.includes(PERMISSIONS.LEAVE_VIEW);

      if (!canManageAll && !canReadOwn) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view leave allocations.', 403);
      }

      let query = supabase
        .from('leave_allocations')
        .select('*, employees (full_name), leave_types (code, name)')
        .order('period', { ascending: false });

      if (canManageAll) {
        if (filters?.employeeId) {
          query = query.eq('employee_id', filters.employeeId);
        }
      } else {
        if (filters?.employeeId && filters.employeeId !== actor.employeeId) {
          throw new AppError(
            API_ERROR_CODES.FORBIDDEN,
            'You can only view your own leave allocations.',
            403,
          );
        }
        query = query.eq('employee_id', actor.employeeId);
      }

      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load allocations.', 500);
      return (data ?? []).map(mapAllocation);
    },

    async createAllocation(
      actor: RequestUser,
      input: { employeeId: string; leaveTypeId: string; allocated: number; period?: string },
      meta: RequestMeta,
    ) {
      if (!canWriteDirectoryAllocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave allocations.', 403);
      }
      await assertCanStaffDirectoryTarget(supabase, actor, input.employeeId);
      const period = input.period ?? currentPeriod();
      const { data, error } = await supabase
        .from('leave_allocations')
        .insert({
          employee_id: input.employeeId,
          leave_type_id: input.leaveTypeId,
          period,
          allocated: input.allocated,
          available: input.allocated,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'Allocation already exists for this period.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create allocation.', 500);
      }
      await supabase.from('leave_ledger').insert({
        employee_id: input.employeeId,
        leave_type_id: input.leaveTypeId,
        allocation_id: data.id,
        transaction_type: 'ALLOCATION',
        quantity: input.allocated,
        reference_type: 'period',
      });
      await supabase.rpc('recompute_leave_allocation', { p_allocation_id: data.id });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_allocation.create',
        entityType: 'leave_allocation',
        entityId: data.id as string,
        newValues: { allocated: input.allocated, leaveTypeId: input.leaveTypeId, period },
        ...meta,
      });
      const { data: full, error: loadError } = await supabase
        .from('leave_allocations')
        .select('*, employees (full_name), leave_types (code, name)')
        .eq('id', data.id)
        .single();
      if (loadError || !full) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Allocation created but could not be loaded.', 500);
      }
      const created = mapAllocation(full);
      const typeLabel = created.leaveTypeName ?? 'leave';
      await notifyStaff(supabase, await loadStaffById(supabase, created.employeeId), {
        type: 'leave',
        title: 'Leave balance updated',
        message: `${typeLabel}: ${created.allocated} day(s) allocated for ${created.period}.`,
        referenceType: 'leave_allocation',
        referenceId: created.id,
        eyebrow: 'Leave',
        paragraphs: [
          `An administrator allocated ${created.allocated} day(s) of ${typeLabel} for ${created.period}.`,
          'Sign in to review your leave balance.',
        ],
        details: [
          { label: 'Leave type', value: typeLabel },
          { label: 'Period', value: created.period },
          { label: 'Days allocated', value: String(created.allocated) },
        ],
        ctaLabel: 'View leave balance',
      });
      return created;
    },

    async setAllocated(actor: RequestUser, id: string, allocated: number, meta: RequestMeta) {
      if (!canWriteDirectoryAllocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave allocations.', 403);
      }
      const { data: allocation, error } = await supabase.from('leave_allocations').select('*').eq('id', id).maybeSingle();
      if (error || !allocation) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Allocation not found.', 404);
      await assertCanStaffDirectoryTarget(supabase, actor, allocation.employee_id as string);
      const current = Number(allocation.allocated);
      const used = Number(allocation.used);
      if (allocated < used) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocated days cannot be less than days already used.', 400);
      }
      const delta = allocated - current;
      if (delta === 0) {
        const { data: full } = await supabase
          .from('leave_allocations')
          .select('*, employees (full_name), leave_types (code, name)')
          .eq('id', id)
          .single();
        return mapAllocation(full as Record<string, unknown>);
      }
      await supabase.from('leave_ledger').insert({
        employee_id: allocation.employee_id,
        leave_type_id: allocation.leave_type_id,
        allocation_id: id,
        transaction_type: 'ALLOCATION',
        quantity: delta,
        reference_type: 'leave_allocation',
        reference_id: id,
      });
      await supabase.rpc('recompute_leave_allocation', { p_allocation_id: id });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_allocation.update',
        entityType: 'leave_allocation',
        entityId: id,
        newValues: { allocated },
        ...meta,
      });
      const { data: full, error: loadError } = await supabase
        .from('leave_allocations')
        .select('*, employees (full_name), leave_types (code, name)')
        .eq('id', id)
        .single();
      if (loadError || !full) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Allocation updated but could not be loaded.', 500);
      const updated = mapAllocation(full);
      const typeLabel = updated.leaveTypeName ?? 'leave';
      await notifyStaff(supabase, await loadStaffById(supabase, updated.employeeId), {
        type: 'leave',
        title: 'Leave balance updated',
        message: `${typeLabel}: allocation is now ${updated.allocated} day(s) for ${updated.period}.`,
        referenceType: 'leave_allocation',
        referenceId: updated.id,
        eyebrow: 'Leave',
        paragraphs: [
          `An administrator updated your ${typeLabel} allocation for ${updated.period} to ${updated.allocated} day(s).`,
          'Sign in to review your leave balance.',
        ],
        details: [
          { label: 'Leave type', value: typeLabel },
          { label: 'Period', value: updated.period },
          { label: 'Days allocated', value: String(updated.allocated) },
        ],
        ctaLabel: 'View leave balance',
      });
      return updated;
    },

    async deleteAllocation(actor: RequestUser, id: string, meta: RequestMeta) {
      if (!canWriteDirectoryAllocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave allocations.', 403);
      }
      const { data: allocation, error } = await supabase.from('leave_allocations').select('*').eq('id', id).maybeSingle();
      if (error || !allocation) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Allocation not found.', 404);
      await assertCanStaffDirectoryTarget(supabase, actor, allocation.employee_id as string);
      if (Number(allocation.used) > 0) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This leave type has been used and cannot be removed.', 409);
      }
      const { count } = await supabase
        .from('leave_applications')
        .select('id', { count: 'exact', head: true })
        .eq('employee_id', allocation.employee_id)
        .eq('leave_type_id', allocation.leave_type_id)
        .in('status', ['PENDING', 'APPROVED']);
      if ((count ?? 0) > 0) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This leave type has an open or approved application.', 409);
      }
      await supabase.from('leave_ledger').delete().eq('allocation_id', id);
      const { error: deleteError } = await supabase.from('leave_allocations').delete().eq('id', id);
      if (deleteError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to remove allocation.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_allocation.delete',
        entityType: 'leave_allocation',
        entityId: id,
        oldValues: { leaveTypeId: allocation.leave_type_id, period: allocation.period },
        ...meta,
      });
      const { data: typeRow } = await supabase
        .from('leave_types')
        .select('name')
        .eq('id', allocation.leave_type_id)
        .maybeSingle();
      const typeLabel = (typeRow?.name as string | undefined) ?? 'leave';
      await notifyStaff(supabase, await loadStaffById(supabase, allocation.employee_id as string), {
        type: 'leave',
        title: 'Leave type removed',
        message: `${typeLabel} for ${allocation.period as string} was removed from your allocations.`,
        referenceType: 'leave_allocation',
        referenceId: id,
        eyebrow: 'Leave',
        paragraphs: [
          `An administrator removed ${typeLabel} from your leave allocations for ${allocation.period as string}.`,
        ],
        ctaLabel: 'View leave balance',
      });
    },

    async adjustAllocation(actor: RequestUser, id: string, adjustedDelta: number, meta: RequestMeta) {
      if (!canWriteDirectoryAllocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage leave allocations.', 403);
      }
      const { data: allocation, error } = await supabase.from('leave_allocations').select('*').eq('id', id).maybeSingle();
      if (error || !allocation) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Allocation not found.', 404);
      await assertCanStaffDirectoryTarget(supabase, actor, allocation.employee_id as string);
      await supabase.from('leave_ledger').insert({
        employee_id: allocation.employee_id,
        leave_type_id: allocation.leave_type_id,
        allocation_id: id,
        transaction_type: 'ADMIN_ADJUSTMENT',
        quantity: adjustedDelta,
        reference_type: 'leave_allocation',
        reference_id: id,
      });
      await supabase.rpc('recompute_leave_allocation', { p_allocation_id: id });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'leave_allocation.adjust',
        entityType: 'leave_allocation',
        entityId: id,
        newValues: { delta: adjustedDelta },
        ...meta,
      });
      return id;
    },
  };
}

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function mapType(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    name: row.name as string,
    code: row.code as string,
    description: (row.description as string) ?? '',
    active: Boolean(row.active),
    requiresApproval: Boolean(row.requires_approval),
    requiresHandover: Boolean(row.requires_handover),
    requiresAttachment: Boolean(row.requires_attachment),
    allowHalfDay: Boolean(row.allow_half_day),
    allowMultipleDays: Boolean(row.allow_multiple_days),
    paid: row.paid === undefined ? true : Boolean(row.paid),
  };
}

function mapPolicy(row: Record<string, unknown>) {
  const type = row.leave_types as { name: string; code: string } | { name: string; code: string }[] | null;
  const versionsRaw = (row.leave_policy_versions ?? []) as Record<string, unknown>[];
  const versions = versionsRaw.map((version) => {
    const rulesRow = version.leave_policy_rules as { rules: unknown } | { rules: unknown }[] | null;
    const raw = Array.isArray(rulesRow) ? rulesRow[0]?.rules : rulesRow?.rules;
    return {
      id: version.id as string,
      versionNumber: version.version_number as number,
      status: version.status as string,
      publishedAt: (version.published_at as string | null) ?? null,
      rules: parsePolicyRules(raw),
    };
  });
  const published = [...versions].filter((item) => item.status === 'published').sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
  const typeRow = Array.isArray(type) ? type[0] : type;
  return {
    id: row.id as string,
    name: row.name as string,
    leaveTypeId: row.leave_type_id as string,
    leaveTypeName: typeRow?.name ?? null,
    leaveTypeCode: typeRow?.code ?? null,
    versions,
    activeVersion: published,
  };
}

function mapAllocation(row: Record<string, unknown>) {
  const employee = row.employees as { full_name: string } | { full_name: string }[] | null;
  const type = row.leave_types as { code: string; name: string } | { code: string; name: string }[] | null;
  const employeeRow = Array.isArray(employee) ? employee[0] : employee;
  const typeRow = Array.isArray(type) ? type[0] : type;
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    employeeName: employeeRow?.full_name ?? null,
    leaveTypeId: row.leave_type_id as string,
    leaveTypeCode: typeRow?.code ?? null,
    leaveTypeName: typeRow?.name ?? null,
    period: row.period as string,
    allocated: Number(row.allocated),
    carriedForward: Number(row.carried_forward),
    adjusted: Number(row.adjusted),
    used: Number(row.used),
    available: Number(row.available),
  };
}
