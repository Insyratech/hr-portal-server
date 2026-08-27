import type { SupabaseClient } from '@supabase/supabase-js';
import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';
import { loadWorkingDays } from '../leave/support';
import { portalUrl } from '../notifications/mail';
import { listActiveStaff, listStaffByRole, notifyStaff, type StaffContact } from '../notifications/notify-staff';
import { skipsWorkApprovalLoop } from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { loadDayContext } from './day-context';
import {
  DEFAULT_DAILY_REMINDER_HOUR,
  DEFAULT_SECOND_DAILY_REMINDER_HOUR,
  MONDAY_PRIORITY_REMINDER_HOUR,
  WORK_TIMEZONE,
  formatIsoDateInZone,
  hourInZone,
  zonedClock,
} from './ist-clock';
import { ensureWeeklyPlan } from './plans';
import { isPastWeeklyPptReminderGate, pptWeekBounds, saturdayOfPptWeek } from './ppt-week';
import { matchingReminderSlot } from './retention';
import type { DayContext } from './types';
import { weekBounds } from './week-bounds';
import { ROLE_CODES } from '../../shared/constants/permissions';

export const REMINDER_KINDS = [
  'monday_priorities',
  'daily_update',
  'daily_update_second',
  'carry_forward',
  'weekly_ppt',
  'weekly_ppt_second',
  'weekly_ppt_cso_digest',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

const CLOSED_PRIORITY = new Set(['COMPLETED', 'CANCELLED', 'CARRIED_FORWARD']);
const SUBMITTED_APPROVAL = new Set(['SUBMITTED', 'APPROVED']);

export function shouldMailDailyUpdate(context: DayContext): boolean {
  return context.required && !context.submitted && !context.onApprovedLeave;
}

/** Monday 16:00 IST is a reminder only — never a submit cutoff. Skip leave / not-expected days. */
export function shouldSkipMondayPriorityReminder(
  context: Pick<DayContext, 'onApprovedLeave' | 'required'>,
): boolean {
  return context.onApprovedLeave || !context.required;
}

export type ReminderHours = { primary: number; second: number | null; timeZone: string };

export async function loadReminderHours(supabase: SupabaseClient): Promise<ReminderHours> {
  const { data } = await supabase
    .from('organization_settings')
    .select('work_update_reminder_hour, work_update_second_reminder_hour')
    .limit(1)
    .maybeSingle();
  const primary = Number(data?.work_update_reminder_hour);
  const secondRaw = data?.work_update_second_reminder_hour;
  const second = secondRaw == null ? DEFAULT_SECOND_DAILY_REMINDER_HOUR : Number(secondRaw);
  return {
    primary:
      Number.isInteger(primary) && primary >= 0 && primary <= 23 ? primary : DEFAULT_DAILY_REMINDER_HOUR,
    second:
      second != null && Number.isInteger(second) && second >= 0 && second <= 23
        ? second
        : DEFAULT_SECOND_DAILY_REMINDER_HOUR,
    timeZone: WORK_TIMEZONE,
  };
}

/** @deprecated Prefer loadReminderHours — kept for callers that only need the primary hour. */
export async function loadReminderHour(supabase: SupabaseClient): Promise<number> {
  return (await loadReminderHours(supabase)).primary;
}

async function claimReminder(
  supabase: SupabaseClient,
  employeeId: string,
  workDate: string,
  kind: ReminderKind,
): Promise<boolean> {
  const { error } = await supabase.from('work_reminder_log').insert({
    employee_id: employeeId,
    work_date: workDate,
    reminder_kind: kind,
  });
  if (error?.code === '23505') return false;
  if (error) return false;
  return true;
}

function inWorkReminderLoop(roles: string[] | undefined): boolean {
  return !skipsWorkApprovalLoop(roles ?? []);
}

/** True when the employee has already submitted at least one priority for CSO review this week. */
async function hasSubmittedPrioritiesForApproval(supabase: SupabaseClient, planId: string): Promise<boolean> {
  const { data } = await supabase
    .from('weekly_priorities')
    .select('id, approval_status, status')
    .eq('plan_id', planId);
  for (const row of data ?? []) {
    if (CLOSED_PRIORITY.has(row.status as string)) continue;
    if (SUBMITTED_APPROVAL.has((row.approval_status as string) ?? 'DRAFT')) return true;
  }
  return false;
}

async function prioritiesReadyForDaily(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
  workingDays: string[],
): Promise<boolean> {
  const week = weekBounds(isoDate, workingDays);
  const { data: plan } = await supabase
    .from('weekly_plans')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('week_start', week.start)
    .maybeSingle();
  if (!plan?.id) return false;
  const { data } = await supabase
    .from('weekly_priorities')
    .select('status, approval_status')
    .eq('plan_id', plan.id);
  const active = (data ?? []).filter((row) => !CLOSED_PRIORITY.has(row.status as string));
  if (active.length === 0) return false;
  return active.every((row) => ((row.approval_status as string) ?? 'DRAFT') === 'APPROVED');
}

async function openPriorities(supabase: SupabaseClient, planId: string) {
  const { data } = await supabase
    .from('weekly_priorities')
    .select('id, title, status, priority_type')
    .eq('plan_id', planId)
    .order('created_at');
  const rows = data ?? [];
  return {
    all: rows,
    open: rows.filter((row) => !CLOSED_PRIORITY.has(row.status as string)),
  };
}

export async function markMissingIfNeeded(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<boolean> {
  const context = await loadDayContext(supabase, employeeId, isoDate);
  if (!context.required || context.submitted) return false;
  const { data: existing } = await supabase
    .from('daily_work_days')
    .select('id, submitted_at')
    .eq('employee_id', employeeId)
    .eq('work_date', isoDate)
    .maybeSingle();
  if (existing?.submitted_at) return false;
  if (existing?.id) {
    await supabase.from('daily_work_days').update({ status: 'MISSING' }).eq('id', existing.id);
  } else {
    await supabase.from('daily_work_days').insert({
      employee_id: employeeId,
      work_date: isoDate,
      status: 'MISSING',
    });
  }
  return true;
}

export async function runCloseMissingDays(
  supabase: SupabaseClient,
  isoDate: string,
): Promise<{ date: string; marked: number; snapshots: number }> {
  const workingDays = await loadWorkingDays(supabase);
  const week = weekBounds(isoDate, workingDays);
  const lastWorkingDay = isoDate === week.end;
  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let marked = 0;
  let snapshots = 0;
  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    if (await markMissingIfNeeded(supabase, person.id, isoDate)) marked += 1;
    if (lastWorkingDay && (await writeWeekSnapshot(supabase, person.id, week))) snapshots += 1;
  }
  return { date: isoDate, marked, snapshots };
}

export type MondayReminderResult = {
  date: string;
  weekStart: string;
  hour: number;
  reminderHour: number;
  timeZone: string;
  plans: number;
  sent: number;
  skipped: boolean;
  skipReason: string | null;
};

export async function runMondayPriorityReminders(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<MondayReminderResult> {
  const clock = zonedClock(now);
  const today = clock.isoDate;
  const workingDays = await loadWorkingDays(supabase);
  const week = weekBounds(today, workingDays);
  const base = {
    date: today,
    weekStart: week.start,
    hour: clock.hour,
    reminderHour: MONDAY_PRIORITY_REMINDER_HOUR,
    timeZone: WORK_TIMEZONE,
    plans: 0,
    sent: 0,
  };

  if (today !== week.start) {
    return { ...base, skipped: true, skipReason: 'not_week_start' };
  }
  if (clock.hour !== MONDAY_PRIORITY_REMINDER_HOUR) {
    return { ...base, skipped: true, skipReason: 'outside_ist_hour' };
  }

  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let sent = 0;
  let plans = 0;

  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    const planId = await ensureWeeklyPlan(supabase, person.id, week.start, week.end);
    plans += 1;
    if (await hasSubmittedPrioritiesForApproval(supabase, planId)) continue;
    const context = await loadDayContext(supabase, person.id, today);
    if (shouldSkipMondayPriorityReminder(context)) continue;
    if (!(await claimReminder(supabase, person.id, today, 'monday_priorities'))) continue;
    await notifyStaff(supabase, person, {
      type: 'work_week_priorities',
      title: 'Submit this week’s priorities',
      message: `Plan your week (${week.start} – ${week.end}) and submit for CSO approval before end of Monday.`,
      referenceType: 'weekly_plan',
      referenceId: planId,
      eyebrow: 'Work & Priorities',
      paragraphs: [
        'Add at least one work goal (R&D project or regular work). Skill development is optional.',
        'Submit everything together for CSO approval before end of Monday. If you are on leave today, submit when you are back.',
        'Daily updates unlock after every priority line is approved.',
      ],
      details: [
        { label: 'This week', value: `${week.start} – ${week.end}` },
        { label: 'Reminder', value: `${MONDAY_PRIORITY_REMINDER_HOUR}:00 IST` },
      ],
      ctaLabel: 'Open my priorities',
      ctaHref: portalUrl('/work/priorities'),
    });
    sent += 1;
  }

  return { ...base, plans, sent, skipped: false, skipReason: null };
}

async function remindDailyUpdate(
  supabase: SupabaseClient,
  person: StaffContact,
  today: string,
  kind: 'daily_update' | 'daily_update_second',
): Promise<boolean> {
  const context = await loadDayContext(supabase, person.id, today);
  if (!shouldMailDailyUpdate(context)) return false;
  if (!(await claimReminder(supabase, person.id, today, kind))) return false;
  const isSecond = kind === 'daily_update_second';
  await notifyStaff(supabase, person, {
    type: isSecond ? 'work_daily_update_second' : 'work_daily_update',
    title: isSecond ? 'Reminder: log today’s work' : 'Log today’s work',
    message: 'Tick what you did and add a short note. It takes a minute or two.',
    referenceType: 'daily_work_day',
    referenceId: person.id,
    eyebrow: 'Work & Priorities',
    paragraphs: [
      'A short update is enough: what you finished, and if anything is stuck.',
      isSecond
        ? 'This is the evening follow-up (10:00 pm IST). You will not get another reminder today once you save.'
        : 'Reminders go out at 8:00 pm and 10:00 pm IST on working days if today’s update is still missing.',
    ],
    ctaLabel: 'Log today',
    ctaHref: portalUrl('/work'),
  });
  return true;
}

async function writeWeekSnapshot(
  supabase: SupabaseClient,
  employeeId: string,
  week: { start: string; end: string },
): Promise<boolean> {
  const planId = await ensureWeeklyPlan(supabase, employeeId, week.start, week.end);
  const { data: plan } = await supabase.from('weekly_plans').select('id, snapshot_at').eq('id', planId).maybeSingle();
  if (!plan || plan.snapshot_at) return false;
  const { all, open } = await openPriorities(supabase, planId);
  await supabase
    .from('weekly_plans')
    .update({
      snapshot: {
        takenAt: new Date().toISOString(),
        week,
        priorities: all.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          type: row.priority_type,
        })),
        openCount: open.length,
        total: all.length,
      },
      snapshot_at: new Date().toISOString(),
    })
    .eq('id', planId);
  return true;
}

async function snapshotAndCarryPrompt(
  supabase: SupabaseClient,
  person: StaffContact,
  today: string,
  week: { start: string; end: string },
): Promise<{ snapshot: boolean; carryMail: boolean }> {
  const snapshot = await writeWeekSnapshot(supabase, person.id, week);
  const planId = await ensureWeeklyPlan(supabase, person.id, week.start, week.end);
  const { open } = await openPriorities(supabase, planId);
  const context = await loadDayContext(supabase, person.id, today);
  if (!context.required) return { snapshot, carryMail: false };
  if (open.length === 0) return { snapshot, carryMail: false };
  if (!(await claimReminder(supabase, person.id, today, 'carry_forward'))) {
    return { snapshot, carryMail: false };
  }
  await notifyStaff(supabase, person, {
    type: 'work_carry_forward',
    title: 'Carry unfinished work to next week',
    message: `You still have ${open.length} open ${open.length === 1 ? 'priority' : 'priorities'}. Carry them forward if they continue.`,
    referenceType: 'weekly_plan',
    referenceId: planId,
    eyebrow: 'Work & Priorities',
    paragraphs: [
      'Today is the last working day of the week.',
      'Open My priorities and choose Carry to next week for anything that is not done.',
    ],
    details: [{ label: 'Still open', value: String(open.length) }],
    ctaLabel: 'Review my week',
    ctaHref: portalUrl('/work/priorities'),
  });
  return { snapshot, carryMail: true };
}

export type EveningWorkResult = {
  date: string;
  hour: number;
  reminderHour: number;
  secondReminderHour: number | null;
  timeZone: string;
  slot: 'primary' | 'second' | null;
  skipped: boolean;
  dailyReminders: number;
  carryForwardMails: number;
  snapshots: number;
};

export async function runWorkEveningReminders(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<EveningWorkResult> {
  const clock = zonedClock(now);
  const today = clock.isoDate;
  const hours = await loadReminderHours(supabase);
  const hour = clock.hour;
  const slot = matchingReminderSlot(hour, hours.primary, hours.second);
  const empty: EveningWorkResult = {
    date: today,
    hour,
    reminderHour: hours.primary,
    secondReminderHour: hours.second,
    timeZone: WORK_TIMEZONE,
    slot,
    skipped: true,
    dailyReminders: 0,
    carryForwardMails: 0,
    snapshots: 0,
  };
  if (!slot) return empty;

  const workingDays = await loadWorkingDays(supabase);
  const week = weekBounds(today, workingDays);
  const lastWorkingDay = today === week.end;
  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let dailyReminders = 0;
  let carryForwardMails = 0;
  let snapshots = 0;
  const kind = slot === 'second' ? 'daily_update_second' : 'daily_update';

  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    const canUpdate = await prioritiesReadyForDaily(supabase, person.id, today, workingDays);
    if (!canUpdate) continue;
    if (await remindDailyUpdate(supabase, person, today, kind)) dailyReminders += 1;
    if (slot === 'primary' && lastWorkingDay) {
      const result = await snapshotAndCarryPrompt(supabase, person, today, week);
      if (result.snapshot) snapshots += 1;
      if (result.carryMail) carryForwardMails += 1;
    }
  }

  return {
    date: today,
    hour,
    reminderHour: hours.primary,
    secondReminderHour: hours.second,
    timeZone: WORK_TIMEZONE,
    slot,
    skipped: false,
    dailyReminders,
    carryForwardMails,
    snapshots,
  };
}

export type WeeklyPptReminderResult = {
  date: string;
  hour: number;
  timeZone: string;
  weekStart: string;
  saturday: string;
  slot: 'primary' | 'second' | null;
  skipped: boolean;
  skipReason: string | null;
  sent: number;
};

export async function runWeeklyPptReminders(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<WeeklyPptReminderResult> {
  const clock = zonedClock(now);
  const hours = await loadReminderHours(supabase);
  const slot = matchingReminderSlot(clock.hour, hours.primary, hours.second);
  const week = pptWeekBounds(clock.isoDate);
  const saturday = saturdayOfPptWeek(week.start);
  const base = {
    date: clock.isoDate,
    hour: clock.hour,
    timeZone: WORK_TIMEZONE,
    weekStart: week.start,
    saturday,
    slot,
    sent: 0,
  };

  if (clock.isoDate !== saturday) {
    return { ...base, skipped: true, skipReason: 'not_saturday' };
  }
  if (!slot) {
    return { ...base, skipped: true, skipReason: 'outside_ist_hour' };
  }
  if (!isPastWeeklyPptReminderGate(now, week.start)) {
    return { ...base, skipped: true, skipReason: 'before_18_ist' };
  }

  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let sent = 0;
  const kind = slot === 'second' ? 'weekly_ppt_second' : 'weekly_ppt';

  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    const { data: existing } = await supabase
      .from('weekly_work_updates')
      .select('id')
      .eq('employee_id', person.id)
      .eq('week_start', week.start)
      .maybeSingle();
    if (existing?.id) continue;
    if (!(await claimReminder(supabase, person.id, saturday, kind))) continue;
    const isSecond = kind === 'weekly_ppt_second';
    await notifyStaff(supabase, person, {
      type: isSecond ? 'work_weekly_ppt_second' : 'work_weekly_ppt',
      title: isSecond ? 'Reminder: upload this week’s PPT' : 'Upload this week’s work update PPT',
      message: `Please upload your weekly wrap PPT for ${week.start} – ${week.end} (deadline Saturday 23:59 IST).`,
      referenceType: 'weekly_work_update',
      referenceId: week.start,
      eyebrow: 'Weekly update',
      paragraphs: [
        'Drag and drop your .ppt / .pptx (max 1 MB) on Weekly update.',
        'Submit by Saturday 23:59 IST. Uploads after 6:00 pm IST are marked late.',
        isSecond
          ? 'This is the 10:00 pm IST follow-up. You will not get another PPT reminder this week once you upload.'
          : 'Reminders go out at 8:00 pm and 10:00 pm IST on Saturday only if the deck is still missing.',
      ],
      details: [
        { label: 'Week', value: `${week.start} – ${week.end}` },
        { label: 'Deadline', value: `Saturday ${saturday} 23:59 IST` },
      ],
      ctaLabel: 'Upload weekly PPT',
      ctaHref: portalUrl('/work/weekly-update'),
    });
    sent += 1;
  }

  return { ...base, sent, skipped: false, skipReason: null };
}

export type WeeklyPptCsoDigestResult = {
  date: string;
  hour: number;
  timeZone: string;
  weekStart: string;
  skipped: boolean;
  skipReason: string | null;
  sent: number;
  onTime: number;
  late: number;
  missing: number;
  expected: number;
};

export async function runWeeklyPptCsoDigest(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<WeeklyPptCsoDigestResult> {
  const clock = zonedClock(now);
  const week = pptWeekBounds(clock.isoDate);
  const saturday = saturdayOfPptWeek(week.start);
  const base = {
    date: clock.isoDate,
    hour: clock.hour,
    timeZone: WORK_TIMEZONE,
    weekStart: week.start,
    onTime: 0,
    late: 0,
    missing: 0,
    expected: 0,
    sent: 0,
  };

  if (clock.isoDate !== saturday) {
    return { ...base, skipped: true, skipReason: 'not_saturday' };
  }
  if (clock.hour !== DEFAULT_SECOND_DAILY_REMINDER_HOUR) {
    return { ...base, skipped: true, skipReason: 'outside_digest_hour' };
  }

  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  const loop = staff.filter((person) => !skipsWorkApprovalLoop(rolesByEmployee.get(person.id) ?? []));
  const { data: updates } = await supabase.from('weekly_work_updates').select('employee_id, late').eq('week_start', week.start);
  const byEmployee = new Map((updates ?? []).map((row) => [row.employee_id as string, row]));

  let onTime = 0;
  let late = 0;
  let missing = 0;
  const lateNames: string[] = [];
  const missingNames: string[] = [];
  for (const person of loop) {
    const row = byEmployee.get(person.id);
    if (!row) {
      missing += 1;
      if (missingNames.length < 8) missingNames.push(person.fullName);
      continue;
    }
    if (row.late) {
      late += 1;
      if (lateNames.length < 8) lateNames.push(person.fullName);
    } else {
      onTime += 1;
    }
  }

  const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
  let sent = 0;
  for (const cso of csoStaff) {
    if (!(await claimReminder(supabase, cso.id, saturday, 'weekly_ppt_cso_digest'))) continue;
    await notifyStaff(supabase, cso, {
      type: 'work',
      title: 'Saturday weekly PPT digest',
      message: `This week: ${onTime} on time, ${late} late, ${missing} missing (of ${loop.length}).`,
      referenceType: 'weekly_ppt_desk',
      referenceId: week.start,
      eyebrow: 'Weekly updates',
      paragraphs: [
        `Weekly wrap PPT status for ${week.start} – ${week.end}.`,
        `On time: ${onTime}. Late: ${late}. Missing: ${missing}. Expected: ${loop.length}.`,
        lateNames.length ? `Late: ${lateNames.join(', ')}${late > lateNames.length ? '…' : ''}` : '',
        missingNames.length
          ? `Missing: ${missingNames.join(', ')}${missing > missingNames.length ? '…' : ''}`
          : '',
        'Open Weekly work updates to download or share with General Manager.',
      ].filter(Boolean),
      details: [
        { label: 'Week', value: `${week.start} – ${week.end}` },
        { label: 'On time', value: String(onTime) },
        { label: 'Late', value: String(late) },
        { label: 'Missing', value: String(missing) },
      ],
      ctaLabel: 'Open weekly PPT desk',
      ctaHref: portalUrl('/cso/work/weekly-updates'),
    });
    sent += 1;
  }

  return {
    ...base,
    onTime,
    late,
    missing,
    expected: loop.length,
    sent,
    skipped: false,
    skipReason: null,
  };
}

export function previousIsoDate(isoDate: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(isoDate), -1));
}

/** Today’s calendar date in the company work timezone (IST). */
export function workTodayIso(now = new Date()): string {
  return formatIsoDateInZone(now);
}

/** Current hour in the company work timezone (IST). */
export function workHourNow(now = new Date()): number {
  return hourInZone(now);
}
