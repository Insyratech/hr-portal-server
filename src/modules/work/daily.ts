import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';
import { loadWorkingDays } from '../leave/support';
import { loadDayContext } from './day-context';
import { targetEmployeeId } from './access';
import { dailyPrioritiesGate, skipsWorkApprovalLoop } from './approval';
import type { DayContext, WorkDayStatus } from './types';
import { weekBounds } from './week-bounds';

const BLOCKERS = ['DEPENDENCY', 'APPROVAL', 'TECHNICAL', 'PRIORITY_CHANGE', 'TIME', 'URGENT_ASSIGNMENT', 'OTHER'] as const;
const SKIP_PRIORITY = new Set(['CANCELLED', 'CARRIED_FORWARD']);

export type DailySubmitInput = {
  planned: { priorityId: string; description: string }[];
  unplanned?: { description: string }[];
  blocker?: { category: string; description: string } | null;
  tomorrow?: string;
};

type PriorityLite = {
  id: string;
  title: string;
  type: string;
  projectId: string | null;
  projectName: string | null;
  status: string;
  approvalStatus: string;
};

function eachDate(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = parseIsoDate(start);
  const last = parseIsoDate(end);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(formatIsoDate(cursor));
    cursor = addUtcDays(cursor, 1);
  }
  return dates;
}

export function skipMessage(context: DayContext): string | null {
  if (context.status === 'ON_LEAVE') return 'You are on leave today. No update needed.';
  if (context.status === 'HOLIDAY') return 'Today is a holiday. No update needed.';
  if (context.status === 'WEEKEND') return 'Today is not a working day.';
  if (context.status === 'NOT_REQUIRED') return 'No work update is required today.';
  return null;
}

export function historyMark(context: DayContext, today: string): string {
  if (context.status === 'COMPLETED') return '✓';
  if (context.status === 'ON_LEAVE') return 'L';
  if (context.status === 'HOLIDAY') return 'H';
  if (context.status === 'MISSING' && context.isoDate <= today) return 'M';
  return '';
}

export async function syncEmployeeWorkDays(
  supabase: SupabaseClient,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  for (const isoDate of eachDate(startDate, endDate)) {
    const context = await loadDayContext(supabase, employeeId, isoDate);
    const { data: existing } = await supabase
      .from('daily_work_days')
      .select('id, submitted_at')
      .eq('employee_id', employeeId)
      .eq('work_date', isoDate)
      .maybeSingle();

    if (existing?.submitted_at) {
      const status: WorkDayStatus = context.required ? 'COMPLETED' : context.status;
      await supabase.from('daily_work_days').update({ status }).eq('id', existing.id);
      continue;
    }

    if (!context.required) {
      if (existing?.id) {
        await supabase.from('daily_work_days').update({ status: context.status }).eq('id', existing.id);
      } else {
        await supabase.from('daily_work_days').insert({
          employee_id: employeeId,
          work_date: isoDate,
          status: context.status,
        });
      }
      continue;
    }

    if (existing?.id) {
      await supabase.from('daily_work_days').delete().eq('id', existing.id);
    }
  }
}

async function loadWeekPriorities(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<{ week: { start: string; end: string }; priorities: PriorityLite[] }> {
  const workingDays = await loadWorkingDays(supabase);
  const week = weekBounds(isoDate, workingDays);
  const { data: plan } = await supabase
    .from('weekly_plans')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('week_start', week.start)
    .maybeSingle();
  if (!plan?.id) return { week, priorities: [] };
  const { data, error } = await supabase
    .from('weekly_priorities')
    .select('id, title, priority_type, project_id, status, approval_status, projects ( name )')
    .eq('plan_id', plan.id)
    .order('created_at');
  if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load this week’s priorities.', 500);
  const priorities: PriorityLite[] = [];
  for (const row of data ?? []) {
    if (SKIP_PRIORITY.has(row.status as string)) continue;
    const project = row.projects as { name?: string } | { name?: string }[] | null;
    const name = Array.isArray(project) ? project[0]?.name : project?.name;
    priorities.push({
      id: row.id as string,
      title: row.title as string,
      type: row.priority_type as string,
      projectId: (row.project_id as string | null) ?? null,
      projectName: name ?? null,
      status: row.status as string,
      approvalStatus: (row.approval_status as string) ?? 'DRAFT',
    });
  }
  return { week, priorities };
}

async function loadSubmitted(supabase: SupabaseClient, employeeId: string, isoDate: string) {
  const { data: day, error } = await supabase
    .from('daily_work_days')
    .select('id, status, submitted_at')
    .eq('employee_id', employeeId)
    .eq('work_date', isoDate)
    .maybeSingle();
  if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load today’s update.', 500);
  if (!day?.id || !day.submitted_at) return null;
  const { data: entries } = await supabase
    .from('daily_work_entries')
    .select('id, category, priority_id, project_id, description, next_action')
    .eq('day_id', day.id)
    .order('created_at');
  const { data: blockers } = await supabase
    .from('work_blockers')
    .select('id, category, description, priority_id')
    .eq('day_id', day.id)
    .is('resolved_at', null)
    .limit(1);
  const list = entries ?? [];
  return {
    dayId: day.id as string,
    entries: list.map((row) => ({
      id: row.id as string,
      category: row.category as string,
      priorityId: (row.priority_id as string | null) ?? null,
      projectId: (row.project_id as string | null) ?? null,
      description: row.description as string,
    })),
    tomorrow: list.map((row) => row.next_action as string).find((text) => text.trim()) ?? '',
    blocker: blockers?.[0]
      ? {
          id: blockers[0].id as string,
          category: blockers[0].category as string,
          description: blockers[0].description as string,
          priorityId: (blockers[0].priority_id as string | null) ?? null,
        }
      : null,
  };
}

export function createDailyWorkService(supabase: SupabaseClient) {
  return {
    async getDay(actor: RequestUser, isoDate: string, employeeId?: string) {
      const target = targetEmployeeId(actor, employeeId);
      const context = await loadDayContext(supabase, target, isoDate);
      if (!context.required) {
        await syncEmployeeWorkDays(supabase, target, isoDate, isoDate);
      }
      const { week, priorities } = await loadWeekPriorities(supabase, target, isoDate);
      const submitted = await loadSubmitted(supabase, target, isoDate);
      const own = target === actor.employeeId;
      const exempt = skipsWorkApprovalLoop(actor.roles);
      const gate =
        own && !exempt
          ? dailyPrioritiesGate(priorities)
          : { ok: true as const, reason: null };
      const dayRequired = context.required;
      return {
        context,
        formOpen: own && dayRequired && gate.ok,
        skipReason: skipMessage(context),
        approvalBlockReason: own && dayRequired && !gate.ok ? gate.reason : null,
        prioritiesApproved: gate.ok,
        week,
        priorities,
        submitted,
      };
    },

    async submitDay(actor: RequestUser, isoDate: string, input: DailySubmitInput) {
      const context = await loadDayContext(supabase, actor.employeeId, isoDate);
      if (!context.required) {
        throw new AppError(API_ERROR_CODES.CONFLICT, skipMessage(context) ?? 'No update is needed today.', 409);
      }
      const planned = (input.planned ?? []).filter((row) => row.priorityId && row.description.trim());
      const unplanned = (input.unplanned ?? []).filter((row) => row.description.trim());
      if (planned.length + unplanned.length === 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a short note on at least one thing you did.', 400);
      }
      const { priorities } = await loadWeekPriorities(supabase, actor.employeeId, isoDate);
      if (!skipsWorkApprovalLoop(actor.roles)) {
        const gate = dailyPrioritiesGate(priorities);
        if (!gate.ok) {
          throw new AppError(API_ERROR_CODES.CONFLICT, gate.reason ?? 'Waiting for CSO approval on priorities.', 409);
        }
      }
      const byId = new Map(priorities.map((item) => [item.id, item]));
      const tomorrow = input.tomorrow?.trim() ?? '';

      const { data: day, error: dayError } = await supabase
        .from('daily_work_days')
        .upsert(
          {
            employee_id: actor.employeeId,
            work_date: isoDate,
            status: 'COMPLETED',
            submitted_at: new Date().toISOString(),
          },
          { onConflict: 'employee_id,work_date' },
        )
        .select('id')
        .single();
      if (dayError || !day) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save today’s update.', 500);
      const dayId = day.id as string;

      await supabase.from('daily_work_entries').delete().eq('day_id', dayId);
      await supabase.from('work_blockers').delete().eq('day_id', dayId);

      const rows: Record<string, unknown>[] = [];
      for (const item of planned) {
        const priority = byId.get(item.priorityId);
        if (!priority) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'That priority is not on this week’s plan.', 400);
        }
        rows.push({
          day_id: dayId,
          category: priority.type === 'SKILL' ? 'SKILL' : 'PLANNED',
          priority_id: priority.id,
          project_id: priority.projectId,
          description: item.description.trim(),
          next_action: tomorrow,
        });
      }
      for (const item of unplanned) {
        rows.push({
          day_id: dayId,
          category: 'UNPLANNED',
          priority_id: null,
          project_id: null,
          description: item.description.trim(),
          next_action: tomorrow,
        });
      }
      const { error: entryError } = await supabase.from('daily_work_entries').insert(rows);
      if (entryError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save what you did today.', 500);

      if (input.blocker?.description.trim()) {
        const category = BLOCKERS.includes(input.blocker.category as (typeof BLOCKERS)[number])
          ? input.blocker.category
          : 'OTHER';
        const { error: blockerError } = await supabase.from('work_blockers').insert({
          employee_id: actor.employeeId,
          day_id: dayId,
          category,
          description: input.blocker.description.trim(),
          impact: 'MEDIUM',
        });
        if (blockerError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save the blocker.', 500);
      }

      return this.getDay(actor, isoDate);
    },

    async getHistory(actor: RequestUser, month: string, employeeId?: string) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a month as YYYY-MM.', 400);
      }
      const target = targetEmployeeId(actor, employeeId);
      const start = `${month}-01`;
      const startDate = parseIsoDate(start);
      const endDate = formatIsoDate(new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0)));
      const today = formatIsoDate(new Date());
      const days = [];
      for (const isoDate of eachDate(start, endDate)) {
        const context = await loadDayContext(supabase, target, isoDate);
        days.push({
          isoDate,
          status: context.status,
          required: context.required,
          mark: historyMark(context, today),
        });
      }
      const { data: submitted } = await supabase
        .from('daily_work_days')
        .select('id, work_date, status, submitted_at, daily_work_entries ( category, description, priority_id )')
        .eq('employee_id', target)
        .gte('work_date', start)
        .lte('work_date', endDate)
        .not('submitted_at', 'is', null)
        .order('work_date', { ascending: false });
      const list = (submitted ?? []).map((row) => {
        const children = (row.daily_work_entries ?? []) as {
          category: string;
          description: string;
          priority_id: string | null;
        }[];
        return {
          date: row.work_date as string,
          status: row.status as string,
          entries: children.map((entry) => ({
            category: entry.category,
            description: entry.description,
            priorityId: entry.priority_id,
          })),
        };
      });
      return { month, days, submitted: list };
    },
  };
}
