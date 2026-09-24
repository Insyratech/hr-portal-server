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
  DEFAULT_THIRD_DAILY_REMINDER_HOUR,
  MONDAY_PRIORITY_REMINDER_HOUR,
  WORK_TIMEZONE,
  formatIsoDateInZone,
  formatWorkHour,
  formatWorkHourList,
  hourInZone,
  zonedClock,
} from './ist-clock';
import { ensureWeeklyPlan } from './plans';
import {
  WEEKLY_PPT_CSO_DIGEST_HOUR,
  WEEKLY_PPT_LAST_HOUR,
  WEEKLY_PPT_REMINDER_HOURS,
  pptWeekBounds,
  readWeeklyPptTiming,
  sundayOfPptWeek,
} from './ppt-week';
import { dueReminderSlot, normalizeReminderHours } from './retention';
import type { DayContext } from './types';
import { weekBounds } from './week-bounds';
import { ROLE_CODES } from '../../shared/constants/permissions';

export const REMINDER_KINDS = [
  'monday_priorities',
  'daily_update',
  'daily_update_second',
  'daily_update_third',
  'carry_forward',
  'weekly_ppt',
  'weekly_ppt_second',
  'weekly_ppt_third',
  'weekly_ppt_cso_digest',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** One kind per daily slot, in the same order as the configured reminder hours. */
const DAILY_REMINDER_KINDS = ['daily_update', 'daily_update_second', 'daily_update_third'] as const;
type DailyReminderKind = (typeof DAILY_REMINDER_KINDS)[number];

/** One kind per Sunday PPT slot, in the same order as WEEKLY_PPT_REMINDER_HOURS. */
const WEEKLY_PPT_REMINDER_KINDS = ['weekly_ppt', 'weekly_ppt_second', 'weekly_ppt_third'] as const;
type WeeklyPptReminderKind = (typeof WEEKLY_PPT_REMINDER_KINDS)[number];

/** Clamped so an extra configured hour still maps to a real kind instead of undefined. */
function slotKind<T>(kinds: readonly T[], slot: number | null): T | null {
  if (slot == null) return null;
  return kinds[Math.min(slot, kinds.length - 1)];
}

/** Reminder kind for the daily slot due at this hour, or null before the first slot. */
export function dailyReminderKindForSlot(slot: number | null): DailyReminderKind | null {
  return slotKind(DAILY_REMINDER_KINDS, slot);
}

/** Reminder kind for the Sunday PPT slot due at this hour, or null before 18:00 IST. */
export function weeklyPptReminderKindForSlot(slot: number | null): WeeklyPptReminderKind | null {
  return slotKind(WEEKLY_PPT_REMINDER_KINDS, slot);
}

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

/** Configured daily reminder hours (IST), ascending. Defaults to 17 / 20 / 23. */
export type ReminderHours = { hours: number[]; timeZone: string };

export async function loadReminderHours(supabase: SupabaseClient): Promise<ReminderHours> {
  const { data, error } = await supabase
    .from('organization_settings')
    .select('work_update_reminder_hour, work_update_second_reminder_hour, work_update_third_reminder_hour')
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Work reminder hours could not be read; using IST defaults.', error);
  }
  const hours = normalizeReminderHours([
    data?.work_update_reminder_hour == null
      ? DEFAULT_DAILY_REMINDER_HOUR
      : Number(data.work_update_reminder_hour),
    data?.work_update_second_reminder_hour == null
      ? DEFAULT_SECOND_DAILY_REMINDER_HOUR
      : Number(data.work_update_second_reminder_hour),
    data?.work_update_third_reminder_hour == null
      ? DEFAULT_THIRD_DAILY_REMINDER_HOUR
      : Number(data.work_update_third_reminder_hour),
  ]);
  return {
    hours: hours.length
      ? hours
      : [
          DEFAULT_DAILY_REMINDER_HOUR,
          DEFAULT_SECOND_DAILY_REMINDER_HOUR,
          DEFAULT_THIRD_DAILY_REMINDER_HOUR,
        ],
    timeZone: WORK_TIMEZONE,
  };
}

/** Reserves one reminder slot for one person per day. A duplicate key means it already went out. */
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
  if (!error) return true;
  if (error.code === '23505') return false;
  console.error('Work reminder claim failed', kind, employeeId, workDate, error);
  return false;
}

/** Frees a claimed slot after a delivery failure so the next run can retry it. */
async function releaseReminder(
  supabase: SupabaseClient,
  employeeId: string,
  workDate: string,
  kind: ReminderKind,
): Promise<void> {
  const { error } = await supabase
    .from('work_reminder_log')
    .delete()
    .eq('employee_id', employeeId)
    .eq('work_date', workDate)
    .eq('reminder_kind', kind);
  if (error) {
    console.error('Work reminder release failed', kind, employeeId, workDate, error);
  }
}

/**
 * Claims the slot, sends it, and rolls the claim back when mail was attempted and rejected.
 * A skip (no address on file, or mail not configured) keeps the claim so the in-app
 * notification is not duplicated on every run.
 */
async function deliverReminder(
  supabase: SupabaseClient,
  person: StaffContact,
  workDate: string,
  kind: ReminderKind,
  input: Parameters<typeof notifyStaff>[2],
): Promise<boolean> {
  if (!(await claimReminder(supabase, person.id, workDate, kind))) return false;
  const result = await notifyStaff(supabase, person, input);
  if (result.mailFailed > 0) {
    await releaseReminder(supabase, person.id, workDate, kind);
    return false;
  }
  return true;
}

function inWorkReminderLoop(roles: string[] | undefined): boolean {
  return !skipsWorkApprovalLoop(roles ?? []);
}

/** True when the employee has already submitted at least one priority for project lead review this week. */
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
  return active.some((row) => ((row.approval_status as string) ?? 'DRAFT') === 'APPROVED');
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
    const delivered = await deliverReminder(supabase, person, today, 'monday_priorities', {
      type: 'work_week_priorities',
      title: 'Submit this week’s priorities',
      message: `Plan your week (${week.start} – ${week.end}) and submit for project lead approval before end of Monday.`,
      referenceType: 'weekly_plan',
      referenceId: planId,
      eyebrow: 'Work & Priorities',
      paragraphs: [
        'Add at least one work goal (R&D project or regular work). Skill development is optional.',
        'Submit everything together for project lead approval before end of Monday. If you are on leave today, submit when you are back.',
        'Daily updates unlock for each approved priority — you do not have to wait for every line.',
      ],
      details: [
        { label: 'This week', value: `${week.start} – ${week.end}` },
        { label: 'Reminder', value: `${formatWorkHour(MONDAY_PRIORITY_REMINDER_HOUR)} IST` },
      ],
      ctaLabel: 'Open my priorities',
      ctaHref: portalUrl('/work/priorities'),
    });
    if (delivered) sent += 1;
  }

  return { ...base, plans, sent, skipped: false, skipReason: null };
}

async function remindDailyUpdate(
  supabase: SupabaseClient,
  person: StaffContact,
  today: string,
  kind: DailyReminderKind,
  hours: number[],
): Promise<boolean> {
  const context = await loadDayContext(supabase, person.id, today);
  if (!shouldMailDailyUpdate(context)) return false;
  const isFirst = kind === 'daily_update';
  const isLast = kind === DAILY_REMINDER_KINDS[DAILY_REMINDER_KINDS.length - 1];
  return deliverReminder(supabase, person, today, kind, {
    type: isFirst ? 'work_daily_update' : 'work_daily_update_second',
    title: isFirst ? 'Log today’s work' : 'Reminder: log today’s work',
    message: 'Tick what you did and add a short note. It takes a minute or two.',
    referenceType: 'daily_work_day',
    referenceId: person.id,
    eyebrow: 'Work & Priorities',
    paragraphs: [
      'A short update is enough: what you finished, and if anything is stuck.',
      isLast
        ? 'This is the last reminder for today. Save your update before the day closes.'
        : `Reminders go out at ${formatWorkHourList(hours)} IST on working days if today’s update is still missing.`,
    ],
    ctaLabel: 'Log today',
    ctaHref: portalUrl('/work'),
  });
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
  const carryMail = await deliverReminder(supabase, person, today, 'carry_forward', {
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
  return { snapshot, carryMail };
}

export type EveningWorkResult = {
  date: string;
  hour: number;
  reminderHours: number[];
  timeZone: string;
  /** Zero-based index into reminderHours, or null before the first slot of the day. */
  slot: number | null;
  reminderKind: DailyReminderKind | null;
  skipped: boolean;
  skipReason: string | null;
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
  const { hours } = await loadReminderHours(supabase);
  const hour = clock.hour;
  const slot = dueReminderSlot(hour, hours);
  const kind = dailyReminderKindForSlot(slot);
  const base = {
    date: today,
    hour,
    reminderHours: hours,
    timeZone: WORK_TIMEZONE,
    slot,
    reminderKind: kind,
    dailyReminders: 0,
    carryForwardMails: 0,
    snapshots: 0,
  };
  if (kind == null) {
    return { ...base, skipped: true, skipReason: 'before_first_reminder_hour' };
  }

  const workingDays = await loadWorkingDays(supabase);
  const week = weekBounds(today, workingDays);
  const lastWorkingDay = today === week.end;
  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let dailyReminders = 0;
  let carryForwardMails = 0;
  let snapshots = 0;

  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    const canUpdate = await prioritiesReadyForDaily(supabase, person.id, today, workingDays);
    if (!canUpdate) continue;
    if (await remindDailyUpdate(supabase, person, today, kind, hours)) dailyReminders += 1;
    if (lastWorkingDay) {
      const result = await snapshotAndCarryPrompt(supabase, person, today, week);
      if (result.snapshot) snapshots += 1;
      if (result.carryMail) carryForwardMails += 1;
    }
  }

  return { ...base, skipped: false, skipReason: null, dailyReminders, carryForwardMails, snapshots };
}

export type WeeklyPptReminderResult = {
  date: string;
  hour: number;
  timeZone: string;
  weekStart: string;
  deadlineDate: string;
  reminderHours: number[];
  /** Zero-based index into WEEKLY_PPT_REMINDER_HOURS, or null before the 6 pm slot. */
  slot: number | null;
  reminderKind: WeeklyPptReminderKind | null;
  skipped: boolean;
  skipReason: string | null;
  sent: number;
};

export async function runWeeklyPptReminders(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<WeeklyPptReminderResult> {
  const clock = zonedClock(now);
  const hours = [...WEEKLY_PPT_REMINDER_HOURS];
  const slot = dueReminderSlot(clock.hour, hours);
  const kind = weeklyPptReminderKindForSlot(slot);
  const week = pptWeekBounds(clock.isoDate);
  const deadlineDate = sundayOfPptWeek(week.start);
  const base = {
    date: clock.isoDate,
    hour: clock.hour,
    timeZone: WORK_TIMEZONE,
    weekStart: week.start,
    deadlineDate,
    reminderHours: hours,
    slot,
    reminderKind: kind,
    sent: 0,
  };

  if (clock.isoDate !== deadlineDate) {
    return { ...base, skipped: true, skipReason: 'not_deadline_day' };
  }
  if (kind == null) {
    return { ...base, skipped: true, skipReason: 'before_first_reminder_hour' };
  }

  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  let sent = 0;
  const isFirst = kind === 'weekly_ppt';
  const isLast = kind === WEEKLY_PPT_REMINDER_KINDS[WEEKLY_PPT_REMINDER_KINDS.length - 1];

  for (const person of staff) {
    if (!inWorkReminderLoop(rolesByEmployee.get(person.id))) continue;
    const { data: existing } = await supabase
      .from('weekly_work_updates')
      .select('id')
      .eq('employee_id', person.id)
      .eq('week_start', week.start)
      .maybeSingle();
    if (existing?.id) continue;
    const delivered = await deliverReminder(supabase, person, deadlineDate, kind, {
      type: isFirst ? 'work_weekly_ppt' : 'work_weekly_ppt_second',
      title: isFirst ? 'Upload this week’s work update PPT' : 'Reminder: upload this week’s PPT',
      message: `Please upload your weekly wrap PPT for ${week.start} – ${week.end} (deadline Sunday 23:59 IST).`,
      referenceType: 'weekly_work_update',
      referenceId: week.start,
      eyebrow: 'Weekly update',
      paragraphs: [
        'Drag and drop your .ppt / .pptx (max 15 MB) on Weekly update.',
        `Submit by Sunday 23:59 IST. Uploads from ${formatWorkHour(WEEKLY_PPT_LAST_HOUR)} are tagged Last hour submission; anything after Sunday is late.`,
        isLast
          ? 'This is the last PPT reminder this week. Upload before Sunday ends.'
          : `Reminders go out at ${formatWorkHourList(hours)} IST on Sunday only if the deck is still missing.`,
      ],
      details: [
        { label: 'Week', value: `${week.start} – ${week.end}` },
        { label: 'Deadline', value: `Sunday ${deadlineDate} 23:59 IST` },
      ],
      ctaLabel: 'Upload weekly PPT',
      ctaHref: portalUrl('/work/weekly-update'),
    });
    if (delivered) sent += 1;
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
  lastHour: number;
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
  const deadlineDate = sundayOfPptWeek(week.start);
  const base = {
    date: clock.isoDate,
    hour: clock.hour,
    timeZone: WORK_TIMEZONE,
    weekStart: week.start,
    onTime: 0,
    lastHour: 0,
    late: 0,
    missing: 0,
    expected: 0,
    sent: 0,
  };

  if (clock.isoDate !== deadlineDate) {
    return { ...base, skipped: true, skipReason: 'not_deadline_day' };
  }
  if (clock.hour < WEEKLY_PPT_CSO_DIGEST_HOUR) {
    return { ...base, skipped: true, skipReason: 'before_digest_hour' };
  }

  const staff = await listActiveStaff(supabase);
  const rolesByEmployee = await loadEmployeeRoleMap(supabase);
  const loop = staff.filter((person) => !skipsWorkApprovalLoop(rolesByEmployee.get(person.id) ?? []));
  const { data: updates } = await supabase
    .from('weekly_work_updates')
    .select('employee_id, late, submission_timing')
    .eq('week_start', week.start);
  const timingByEmployee = new Map(
    (updates ?? []).map((row) => [row.employee_id as string, readWeeklyPptTiming(row)]),
  );

  let onTime = 0;
  let lastHour = 0;
  let late = 0;
  let missing = 0;
  const lateNames: string[] = [];
  const missingNames: string[] = [];
  for (const person of loop) {
    const timing = timingByEmployee.get(person.id);
    if (!timing) {
      missing += 1;
      if (missingNames.length < 8) missingNames.push(person.fullName);
      continue;
    }
    if (timing === 'late') {
      late += 1;
      if (lateNames.length < 8) lateNames.push(person.fullName);
    } else if (timing === 'last_hour') {
      lastHour += 1;
    } else {
      onTime += 1;
    }
  }

  const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
  let sent = 0;
  for (const cso of csoStaff) {
    const delivered = await deliverReminder(supabase, cso, deadlineDate, 'weekly_ppt_cso_digest', {
      type: 'work',
      title: 'Sunday weekly PPT digest',
      message: `This week: ${onTime + lastHour} submitted in time, ${late} late, ${missing} missing (of ${loop.length}).`,
      referenceType: 'weekly_ppt_desk',
      referenceId: week.start,
      eyebrow: 'Weekly updates',
      paragraphs: [
        `Weekly wrap PPT status for ${week.start} – ${week.end}.`,
        `On time: ${onTime}. Last hour: ${lastHour}. Late: ${late}. Missing: ${missing}. Expected: ${loop.length}.`,
        lateNames.length ? `Late: ${lateNames.join(', ')}${late > lateNames.length ? '…' : ''}` : '',
        missingNames.length
          ? `Missing: ${missingNames.join(', ')}${missing > missingNames.length ? '…' : ''}`
          : '',
        'Open Weekly work updates to download or share with General Manager.',
      ].filter(Boolean),
      details: [
        { label: 'Week', value: `${week.start} – ${week.end}` },
        { label: 'On time', value: String(onTime) },
        { label: 'Last hour', value: String(lastHour) },
        { label: 'Late', value: String(late) },
        { label: 'Missing', value: String(missing) },
      ],
      ctaLabel: 'Open weekly PPT desk',
      ctaHref: portalUrl('/cso/work/weekly-updates'),
    });
    if (delivered) sent += 1;
  }

  return {
    ...base,
    onTime,
    lastHour,
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
