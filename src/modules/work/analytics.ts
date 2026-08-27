import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { listWorkWeekRows } from '../attendance/work-week';
import { addUtcDays, formatIsoDate, parseIsoDate, patternOnDate } from '../leave/day-count';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import { canViewOthersWork } from './access';
import { dayContext } from './day-context';
import { percent } from './overview';
import { datesInRange, weekBounds } from './week-bounds';

export const ATTENTION_RULES = {
  complianceBelowPct: 70,
  minRequiredDays: 3,
  heavyCarryMin: 2,
} as const;

export type AttentionLabel = {
  code: 'LOW_COMPLIANCE' | 'NO_WEEK_PLAN' | 'OPEN_BLOCKER' | 'PRIORITIES_BLOCKED' | 'HEAVY_CARRY';
  label: string;
  detail: string;
};

export type PersonAttentionInput = {
  requiredDays: number;
  submittedDays: number;
  weeksTotal: number;
  weeksWithPlan: number;
  openBlockers: number;
  blocked: number;
  completed: number;
  carriedForward: number;
};

export function unplannedSharePct(planned: number, unplanned: number): number {
  return percent(unplanned, planned + unplanned);
}

export function monthKeysInclusive(fromMonth: string, toMonth: string): string[] {
  const keys: string[] = [];
  let [year, month] = fromMonth.split('-').map(Number);
  const [endYear, endMonth] = toMonth.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [year, mon] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = formatIsoDate(new Date(Date.UTC(year, mon, 0)));
  return { start, end };
}

/** Mondays whose Mon–Sun block overlaps [from, to]. */
export function mondaysOverlapping(from: string, to: string): string[] {
  const first = parseIsoDate(from);
  const day = first.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  let monday = addUtcDays(first, offset);
  const last = parseIsoDate(to);
  const out: string[] = [];
  while (monday.getTime() <= last.getTime()) {
    const start = formatIsoDate(monday);
    const end = formatIsoDate(addUtcDays(monday, 6));
    if (end >= from && start <= to) out.push(start);
    monday = addUtcDays(monday, 7);
  }
  return out;
}

export function defaultMonthRange(today: string, monthsBack = 6): { from: string; to: string } {
  const end = today.slice(0, 7);
  const date = parseIsoDate(`${end}-01`);
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - (monthsBack - 1), 1));
  return { from: formatIsoDate(startDate).slice(0, 7), to: end };
}

export function buildAttentionLabels(input: PersonAttentionInput): AttentionLabel[] {
  const labels: AttentionLabel[] = [];
  const compliance = percent(input.submittedDays, input.requiredDays);
  if (input.requiredDays >= ATTENTION_RULES.minRequiredDays && compliance < ATTENTION_RULES.complianceBelowPct) {
    labels.push({
      code: 'LOW_COMPLIANCE',
      label: 'Missing updates',
      detail: `Submitted ${input.submittedDays} of ${input.requiredDays} expected days (leave and holidays excluded).`,
    });
  }
  const weeksWithoutPlan = input.weeksTotal - input.weeksWithPlan;
  if (weeksWithoutPlan > 0) {
    labels.push({
      code: 'NO_WEEK_PLAN',
      label: 'No week plan',
      detail:
        weeksWithoutPlan === 1
          ? '1 week with no priorities set.'
          : `${weeksWithoutPlan} weeks with no priorities set.`,
    });
  }
  if (input.openBlockers > 0) {
    labels.push({
      code: 'OPEN_BLOCKER',
      label: 'Open blocker',
      detail: input.openBlockers === 1 ? '1 open blocker.' : `${input.openBlockers} open blockers.`,
    });
  }
  if (input.blocked > 0) {
    labels.push({
      code: 'PRIORITIES_BLOCKED',
      label: 'Priorities blocked',
      detail: input.blocked === 1 ? '1 priority marked blocked.' : `${input.blocked} priorities marked blocked.`,
    });
  }
  if (
    input.carriedForward >= ATTENTION_RULES.heavyCarryMin &&
    input.carriedForward >= Math.max(1, input.completed)
  ) {
    labels.push({
      code: 'HEAVY_CARRY',
      label: 'Heavy carry-forward',
      detail: `${input.carriedForward} carried forward vs ${input.completed} completed.`,
    });
  }
  return labels;
}

type Bucket = {
  requiredDays: number;
  submittedDays: number;
  weeksTotal: number;
  weeksWithPlan: number;
  completed: number;
  carriedForward: number;
  blocked: number;
  plannedEntries: number;
  unplannedEntries: number;
  skillEntries: number;
  skillCompleted: number;
  skillTotal: number;
};

function emptyBucket(): Bucket {
  return {
    requiredDays: 0,
    submittedDays: 0,
    weeksTotal: 0,
    weeksWithPlan: 0,
    completed: 0,
    carriedForward: 0,
    blocked: 0,
    plannedEntries: 0,
    unplannedEntries: 0,
    skillEntries: 0,
    skillCompleted: 0,
    skillTotal: 0,
  };
}

function addBucket(target: Bucket, source: Bucket) {
  target.requiredDays += source.requiredDays;
  target.submittedDays += source.submittedDays;
  target.weeksTotal += source.weeksTotal;
  target.weeksWithPlan += source.weeksWithPlan;
  target.completed += source.completed;
  target.carriedForward += source.carriedForward;
  target.blocked += source.blocked;
  target.plannedEntries += source.plannedEntries;
  target.unplannedEntries += source.unplannedEntries;
  target.skillEntries += source.skillEntries;
  target.skillCompleted += source.skillCompleted;
  target.skillTotal += source.skillTotal;
}

function snapshotFromBucket(bucket: Bucket) {
  return {
    compliancePct: percent(bucket.submittedDays, bucket.requiredDays),
    weeksWithPlanPct: percent(bucket.weeksWithPlan, bucket.weeksTotal),
    weeksWithPlan: bucket.weeksWithPlan,
    weeksTotal: bucket.weeksTotal,
    requiredDays: bucket.requiredDays,
    submittedDays: bucket.submittedDays,
    completed: bucket.completed,
    carriedForward: bucket.carriedForward,
    blocked: bucket.blocked,
    plannedEntries: bucket.plannedEntries,
    unplannedEntries: bucket.unplannedEntries,
    unplannedSharePct: unplannedSharePct(bucket.plannedEntries, bucket.unplannedEntries),
    skillEntries: bucket.skillEntries,
    skillPrioritiesCompleted: bucket.skillCompleted,
    skillPrioritiesTotal: bucket.skillTotal,
  };
}

export type WorkAnalyticsFilters = {
  from?: string;
  to?: string;
  months?: number;
  departmentId?: string;
  employeeId?: string;
};

function assertMonth(value: string | undefined, fallback: string): string {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;
  return fallback;
}

export function createWorkAnalyticsService(supabase: SupabaseClient) {
  return {
    async getAnalytics(actor: RequestUser, filters: WorkAnalyticsFilters = {}) {
      const teamView = canViewOthersWork(actor);
      if (!teamView && !actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view work analytics.', 403);
      }

      const today = formatIsoDate(new Date());
      const defaults = defaultMonthRange(today, Math.min(Math.max(filters.months ?? 6, 1), 12));
      const fromMonth = assertMonth(filters.from, defaults.from);
      const toMonth = assertMonth(filters.to, defaults.to);
      if (fromMonth > toMonth) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a from month on or before the to month.', 400);
      }

      const months = monthKeysInclusive(fromMonth, toMonth);
      const rangeStart = monthBounds(fromMonth).start;
      const rangeEnd = monthBounds(toMonth).end;
      const attentionMonth = toMonth;

      let peopleQuery = supabase
        .from('employees')
        .select('id, full_name, department_id, departments ( name )')
        .eq('status', 'active')
        .order('full_name');
      if (filters.departmentId) peopleQuery = peopleQuery.eq('department_id', filters.departmentId);
      if (teamView && filters.employeeId) {
        peopleQuery = peopleQuery.eq('id', filters.employeeId);
      } else if (!teamView) {
        if (!actor.employeeId) {
          throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Link an employee profile to view your analytics.', 403);
        }
        peopleQuery = peopleQuery.eq('id', actor.employeeId);
      }
      const { data: peopleRows, error: peopleError } = await peopleQuery;
      if (peopleError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load people for analytics.', 500);

      const people = (peopleRows ?? []).map((row) => {
        const dept = row.departments as { name?: string } | { name?: string }[] | null;
        const departmentName = Array.isArray(dept) ? dept[0]?.name : dept?.name;
        return {
          id: row.id as string,
          name: row.full_name as string,
          departmentName: departmentName ?? null,
        };
      });
      const ids = people.map((row) => row.id);
      if (ids.length === 0) {
        return {
          range: { from: fromMonth, to: toMonth, start: rangeStart, end: rangeEnd },
          attentionMonth,
          note: 'Indicators for context, not a score. Unplanned work is context, not a penalty. Leave and holidays are excluded from update compliance.',
          reliability: {
            compliancePct: 0,
            weeksWithPlanPct: 0,
            weeksWithPlan: 0,
            weeksTotal: 0,
            requiredDays: 0,
            submittedDays: 0,
          },
          execution: { completed: 0, carriedForward: 0, blocked: 0 },
          adaptability: { plannedEntries: 0, unplannedEntries: 0, unplannedSharePct: 0 },
          development: { skillEntries: 0, skillPrioritiesCompleted: 0, skillPrioritiesTotal: 0 },
          trends: months.map((month) => ({
            month,
            ...snapshotFromBucket(emptyBucket()),
          })),
          needsAttention: [] as {
            employeeId: string;
            employeeName: string;
            departmentName: string | null;
            labels: AttentionLabel[];
          }[],
        };
      }

      const [workingDays, holidayDates, workWeeks, leaveRes, daysRes, plansRes, blockersRes] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase),
        supabase
          .from('leave_applications')
          .select('employee_id, start_date, end_date')
          .eq('status', 'APPROVED')
          .lte('start_date', rangeEnd)
          .gte('end_date', rangeStart)
          .in('employee_id', ids),
        supabase
          .from('daily_work_days')
          .select('employee_id, work_date, submitted_at, daily_work_entries ( category )')
          .in('employee_id', ids)
          .gte('work_date', rangeStart)
          .lte('work_date', rangeEnd),
        supabase
          .from('weekly_plans')
          .select('id, employee_id, week_start')
          .in('employee_id', ids)
          .gte('week_start', rangeStart)
          .lte('week_start', rangeEnd),
        supabase.from('work_blockers').select('employee_id').in('employee_id', ids).is('resolved_at', null),
      ]);
      if (leaveRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave for analytics.', 500);
      if (daysRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load daily updates for analytics.', 500);
      if (plansRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly plans for analytics.', 500);
      if (blockersRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load blockers for analytics.', 500);

      const leaveByEmployee = new Map<string, { start: string; end: string }[]>();
      for (const row of leaveRes.data ?? []) {
        const employeeId = row.employee_id as string;
        const list = leaveByEmployee.get(employeeId) ?? [];
        list.push({ start: String(row.start_date).slice(0, 10), end: String(row.end_date).slice(0, 10) });
        leaveByEmployee.set(employeeId, list);
      }
      const onLeave = (employeeId: string, isoDate: string) =>
        (leaveByEmployee.get(employeeId) ?? []).some((span) => span.start <= isoDate && span.end >= isoDate);

      const submitted = new Set<string>();
      const entriesByMonth = new Map<string, { planned: number; unplanned: number; skill: number }>();
      for (const day of daysRes.data ?? []) {
        const employeeId = day.employee_id as string;
        const workDate = String(day.work_date).slice(0, 10);
        if (day.submitted_at) submitted.add(`${employeeId}|${workDate}`);
        const month = workDate.slice(0, 7);
        const bucket = entriesByMonth.get(`${employeeId}|${month}`) ?? { planned: 0, unplanned: 0, skill: 0 };
        for (const entry of (day.daily_work_entries ?? []) as { category: string }[]) {
          if (entry.category === 'UNPLANNED') bucket.unplanned += 1;
          else if (entry.category === 'SKILL') {
            bucket.skill += 1;
            bucket.planned += 1;
          } else {
            bucket.planned += 1;
          }
        }
        entriesByMonth.set(`${employeeId}|${month}`, bucket);
      }

      const planIds = (plansRes.data ?? []).map((row) => row.id as string);
      const planMeta = new Map(
        (plansRes.data ?? []).map((row) => [
          row.id as string,
          { employeeId: row.employee_id as string, weekStart: String(row.week_start).slice(0, 10) },
        ]),
      );
      const { data: priorityRows, error: priorityError } = planIds.length
        ? await supabase
            .from('weekly_priorities')
            .select('plan_id, status, priority_type')
            .in('plan_id', planIds)
        : { data: [], error: null };
      if (priorityError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load priorities for analytics.', 500);

      type PriorityAgg = { completed: number; carriedForward: number; blocked: number; skillCompleted: number; skillTotal: number; hasPlan: boolean };
      const prioritiesByWeek = new Map<string, PriorityAgg>();
      for (const row of priorityRows ?? []) {
        const meta = planMeta.get(row.plan_id as string);
        if (!meta) continue;
        const key = `${meta.employeeId}|${meta.weekStart}`;
        const agg = prioritiesByWeek.get(key) ?? {
          completed: 0,
          carriedForward: 0,
          blocked: 0,
          skillCompleted: 0,
          skillTotal: 0,
          hasPlan: false,
        };
        const status = row.status as string;
        if (status === 'CANCELLED') {
          prioritiesByWeek.set(key, agg);
          continue;
        }
        agg.hasPlan = true;
        if (status === 'COMPLETED') agg.completed += 1;
        if (status === 'CARRIED_FORWARD') agg.carriedForward += 1;
        if (status === 'BLOCKED') agg.blocked += 1;
        if (row.priority_type === 'SKILL') {
          agg.skillTotal += 1;
          if (status === 'COMPLETED') agg.skillCompleted += 1;
        }
        prioritiesByWeek.set(key, agg);
      }

      const openBlockersByEmployee = new Map<string, number>();
      for (const row of blockersRes.data ?? []) {
        const employeeId = row.employee_id as string;
        openBlockersByEmployee.set(employeeId, (openBlockersByEmployee.get(employeeId) ?? 0) + 1);
      }

      const monthBuckets = new Map<string, Bucket>(months.map((month) => [month, emptyBucket()]));
      const personAttention = new Map<string, PersonAttentionInput>();
      const weekStarts = mondaysOverlapping(rangeStart, rangeEnd);

      for (const person of people) {
        const attention = {
          requiredDays: 0,
          submittedDays: 0,
          weeksTotal: 0,
          weeksWithPlan: 0,
          openBlockers: openBlockersByEmployee.get(person.id) ?? 0,
          blocked: 0,
          completed: 0,
          carriedForward: 0,
        };

        for (const month of months) {
          const bounds = monthBounds(month);
          const bucket = emptyBucket();
          for (const isoDate of datesInRange(bounds.start, bounds.end)) {
            if (isoDate > today) continue;
            const context = dayContext({
              isoDate,
              workingDays,
              holidayDates,
              weekPattern: patternOnDate(workWeeks, person.id, isoDate),
              onApprovedLeave: onLeave(person.id, isoDate),
              submitted: submitted.has(`${person.id}|${isoDate}`),
            });
            if (!context.required) continue;
            bucket.requiredDays += 1;
            if (context.submitted) bucket.submittedDays += 1;
          }

          for (const monday of weekStarts) {
            const week = weekBounds(monday, workingDays);
            // Attribute each planning week to the month of its week_start (first working day).
            if (week.start.slice(0, 7) !== month) continue;
            if (week.end < bounds.start || week.start > bounds.end) continue;
            bucket.weeksTotal += 1;
            const agg = prioritiesByWeek.get(`${person.id}|${week.start}`);
            if (agg?.hasPlan) bucket.weeksWithPlan += 1;
            if (agg) {
              bucket.completed += agg.completed;
              bucket.carriedForward += agg.carriedForward;
              bucket.blocked += agg.blocked;
              bucket.skillCompleted += agg.skillCompleted;
              bucket.skillTotal += agg.skillTotal;
            }
          }

          const entries = entriesByMonth.get(`${person.id}|${month}`) ?? { planned: 0, unplanned: 0, skill: 0 };
          bucket.plannedEntries += entries.planned;
          bucket.unplannedEntries += entries.unplanned;
          bucket.skillEntries += entries.skill;

          addBucket(monthBuckets.get(month)!, bucket);

          if (month === attentionMonth) {
            attention.requiredDays += bucket.requiredDays;
            attention.submittedDays += bucket.submittedDays;
            attention.weeksTotal += bucket.weeksTotal;
            attention.weeksWithPlan += bucket.weeksWithPlan;
            attention.blocked += bucket.blocked;
            attention.completed += bucket.completed;
            attention.carriedForward += bucket.carriedForward;
          }
        }
        personAttention.set(person.id, attention);
      }

      const totals = emptyBucket();
      for (const month of months) addBucket(totals, monthBuckets.get(month)!);

      const needsAttention = people
        .map((person) => {
          const labels = buildAttentionLabels(personAttention.get(person.id) ?? {
            requiredDays: 0,
            submittedDays: 0,
            weeksTotal: 0,
            weeksWithPlan: 0,
            openBlockers: 0,
            blocked: 0,
            completed: 0,
            carriedForward: 0,
          });
          return {
            employeeId: person.id,
            employeeName: person.name,
            departmentName: person.departmentName,
            labels,
          };
        })
        .filter((row) => row.labels.length > 0)
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

      const snap = snapshotFromBucket(totals);
      return {
        range: { from: fromMonth, to: toMonth, start: rangeStart, end: rangeEnd },
        attentionMonth,
        note: 'Indicators for context, not a score. Unplanned work is context, not a penalty. Leave and holidays are excluded from update compliance.',
        reliability: {
          compliancePct: snap.compliancePct,
          weeksWithPlanPct: snap.weeksWithPlanPct,
          weeksWithPlan: snap.weeksWithPlan,
          weeksTotal: snap.weeksTotal,
          requiredDays: snap.requiredDays,
          submittedDays: snap.submittedDays,
        },
        execution: {
          completed: snap.completed,
          carriedForward: snap.carriedForward,
          blocked: snap.blocked,
        },
        adaptability: {
          plannedEntries: snap.plannedEntries,
          unplannedEntries: snap.unplannedEntries,
          unplannedSharePct: snap.unplannedSharePct,
        },
        development: {
          skillEntries: snap.skillEntries,
          skillPrioritiesCompleted: snap.skillPrioritiesCompleted,
          skillPrioritiesTotal: snap.skillPrioritiesTotal,
        },
        trends: months.map((month) => ({
          month,
          ...snapshotFromBucket(monthBuckets.get(month) ?? emptyBucket()),
        })),
        needsAttention: teamView ? needsAttention : needsAttention.filter((row) => row.employeeId === actor.employeeId),
      };
    },
  };
}
