import type { SupabaseClient } from '@supabase/supabase-js';
import type { RequestUser } from '../../shared/types/request-user';
import { formatIsoDate } from '../leave/day-count';
import { loadWorkingDays } from '../leave/support';
import { loadDayContext } from './day-context';
import { targetEmployeeId } from './access';
import { calendarWeek, datesInRange, showWeekWrapUp, weekBounds } from './week-bounds';

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export function completionPct(statuses: string[]): number {
  const countable = statuses.filter((status) => status !== 'CANCELLED');
  return percent(
    countable.filter((status) => status === 'COMPLETED').length,
    countable.length,
  );
}

export function compliancePct(days: { required: boolean; submitted: boolean; isoDate: string }[], today: string): number {
  const due = days.filter((day) => day.required && day.isoDate <= today);
  return percent(
    due.filter((day) => day.submitted).length,
    due.length,
  );
}

type PriorityBits = { status: string; title: string; carriedFromId: string | null };
type EntryBits = { category: string; description: string };
type BlockerBits = { description: string };

export function buildFridaySummary(input: {
  priorities: PriorityBits[];
  entries: EntryBits[];
  blockers: BlockerBits[];
}) {
  const active = input.priorities.filter((row) => row.status !== 'CANCELLED');
  const done = active.filter((row) => row.status === 'COMPLETED').length;
  const unplanned = input.entries.filter((row) => row.category === 'UNPLANNED').map((row) => row.description);
  return {
    done,
    total: active.length,
    unplanned,
    blockers: input.blockers.map((row) => row.description),
    carried: input.priorities.filter((row) => row.status === 'CARRIED_FORWARD').length,
  };
}

export function createWorkOverviewService(supabase: SupabaseClient) {
  async function weekRecords(employeeId: string, start: string, end: string) {
    const { data: plan } = await supabase
      .from('weekly_plans')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('week_start', start)
      .maybeSingle();
    const { data: priorities } = plan?.id
      ? await supabase
          .from('weekly_priorities')
          .select('id, title, status, carried_from_id')
          .eq('plan_id', plan.id)
      : { data: [] };
    const { data: days } = await supabase
      .from('daily_work_days')
      .select('id, work_date, submitted_at, daily_work_entries ( category, description ), work_blockers ( description, resolved_at )')
      .eq('employee_id', employeeId)
      .gte('work_date', start)
      .lte('work_date', end);
    const entries: EntryBits[] = [];
    const blockers: BlockerBits[] = [];
    for (const day of days ?? []) {
      for (const entry of (day.daily_work_entries ?? []) as EntryBits[]) entries.push(entry);
      for (const blocker of (day.work_blockers ?? []) as { description: string; resolved_at: string | null }[]) {
        if (!blocker.resolved_at) blockers.push({ description: blocker.description });
      }
    }
    return {
      planId: (plan?.id as string | undefined) ?? null,
      priorities: ((priorities ?? []) as { status: string; title: string; carried_from_id: string | null }[]).map((row) => ({
        status: row.status,
        title: row.title,
        carriedFromId: row.carried_from_id,
      })),
      entries,
      blockers,
    };
  }

  return {
    async getOverview(actor: RequestUser, employeeId?: string) {
      const target = targetEmployeeId(actor, employeeId);
      const today = formatIsoDate(new Date());
      const workingDays = await loadWorkingDays(supabase);
      const planning = weekBounds(today, workingDays);
      const calendar = calendarWeek(today, workingDays);
      const wrapUp = showWeekWrapUp(today, calendar, planning);
      const indicatorWeek = wrapUp ? calendar : planning;

      const contexts = [];
      for (const isoDate of datesInRange(indicatorWeek.start, indicatorWeek.end)) {
        contexts.push(await loadDayContext(supabase, target, isoDate));
      }
      const todayContext = contexts.find((row) => row.isoDate === today) ?? (await loadDayContext(supabase, target, today));
      const records = await weekRecords(target, indicatorWeek.start, indicatorWeek.end);
      const plannedCount = records.entries.filter((row) => row.category !== 'UNPLANNED').length;
      const unplannedCount = records.entries.filter((row) => row.category === 'UNPLANNED').length;
      const friday = wrapUp
        ? buildFridaySummary({
            priorities: records.priorities,
            entries: records.entries,
            blockers: records.blockers,
          })
        : null;

      const priorityCount = records.priorities.filter((row) => row.status !== 'CANCELLED').length;
      const setPriorities = !wrapUp && priorityCount === 0;
      const todayUpdate = Boolean(todayContext.required && !todayContext.submitted);

      return {
        today,
        planning,
        wrapUp,
        actions: {
          setPriorities,
          todayUpdate,
        },
        indicators: {
          completionPct: completionPct(records.priorities.map((row) => row.status)),
          compliancePct: compliancePct(contexts, today),
          plannedCount,
          unplannedCount,
          carryForwardCount: records.priorities.filter((row) => row.status === 'CARRIED_FORWARD' || row.carriedFromId).length,
        },
        friday,
        blockers: records.blockers,
      };
    },
  };
}
