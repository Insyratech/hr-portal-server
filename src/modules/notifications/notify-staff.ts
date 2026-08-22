import type { SupabaseClient } from '@supabase/supabase-js';
import { portalLoginUrl, sendPortalMail } from './mail';
import { notifyUser } from './notify-user';

export type StaffContact = {
  id: string;
  userId: string | null;
  email: string;
  fullName: string;
};

function mailAddress(email: string | null, notificationEmail?: string | null): string | null {
  const preferred = notificationEmail?.trim();
  if (preferred && preferred.includes('@')) return preferred;
  if (email && email.includes('@')) return email;
  return null;
}

function mapStaff(row: {
  id: string;
  user_id: string | null;
  email: string | null;
  full_name: string | null;
  notification_email?: string | null;
}): StaffContact | null {
  if (!row.id) return null;
  return {
    id: row.id,
    userId: row.user_id,
    email: mailAddress(row.email, row.notification_email) ?? '',
    fullName: row.full_name || 'there',
  };
}

const STAFF_SELECT = 'id, user_id, email, full_name, notification_email';
const STAFF_SELECT_LEGACY = 'id, user_id, email, full_name';

export async function listActiveStaff(supabase: SupabaseClient): Promise<StaffContact[]> {
  const primary = await supabase.from('employees').select(STAFF_SELECT).eq('status', 'active');
  const fallback = primary.error
    ? await supabase.from('employees').select(STAFF_SELECT_LEGACY).eq('status', 'active')
    : null;
  const rows = (fallback ?? primary).error ? [] : ((fallback ?? primary).data ?? []);
  const people: StaffContact[] = [];
  for (const row of rows) {
    const mapped = mapStaff({
      id: String(row.id),
      user_id: (row.user_id as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      full_name: (row.full_name as string | null) ?? null,
      notification_email: 'notification_email' in row ? ((row.notification_email as string | null) ?? null) : null,
    });
    if (mapped) people.push(mapped);
  }
  return people;
}

export async function loadStaffById(supabase: SupabaseClient, employeeId: string): Promise<StaffContact | null> {
  const primary = await supabase.from('employees').select(STAFF_SELECT).eq('id', employeeId).maybeSingle();
  const fallback = primary.error
    ? await supabase.from('employees').select(STAFF_SELECT_LEGACY).eq('id', employeeId).maybeSingle()
    : null;
  const data = !(fallback ?? primary).error ? (fallback ?? primary).data : null;
  if (!data) return null;
  return mapStaff({
    id: String(data.id),
    user_id: (data.user_id as string | null) ?? null,
    email: (data.email as string | null) ?? null,
    full_name: (data.full_name as string | null) ?? null,
    notification_email: 'notification_email' in data ? ((data.notification_email as string | null) ?? null) : null,
  });
}

export async function notifyStaff(
  supabase: SupabaseClient,
  people: StaffContact | StaffContact[] | null,
  input: {
    type: string;
    title: string;
    message: string;
    referenceType: string;
    referenceId: string;
    eyebrow?: string;
    paragraphs: string[];
    details?: { label: string; value: string }[];
    ctaLabel?: string;
    ctaHref?: string;
  },
): Promise<void> {
  const list = people == null ? [] : Array.isArray(people) ? people : [people];
  const href = input.ctaHref ?? portalLoginUrl();
  for (const person of list) {
    try {
      await notifyUser(supabase, {
        userId: person.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      });
      if (person.email.includes('@')) {
        await sendPortalMail({
          to: [person.email],
          subject: input.title,
          eyebrow: input.eyebrow,
          title: input.title,
          greeting: `Hi ${person.fullName},`,
          paragraphs: input.paragraphs,
          details: input.details,
          cta: { label: input.ctaLabel ?? 'Open HR Portal', href },
        });
      }
    } catch {
      /* Writes must succeed even if mail or in-app notify fails. */
    }
  }
}
