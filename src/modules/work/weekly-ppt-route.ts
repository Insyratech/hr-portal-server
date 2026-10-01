import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { portalUrl } from '../notifications/mail';
import { listStaffByRole, notifyStaff } from '../notifications/notify-staff';

/** Marks the per-week GM inbox package that collects employee uploads directly (no CSO share step). */
export const WEEKLY_PPT_DIRECT_TO_GM_NOTE = 'direct_to_gm';

export type RouteWeeklyPptToGmInput = {
  updateId: string;
  weekStart: string;
  weekEnd: string;
  employeeId: string;
  employeeName: string;
  systemFileName: string;
  isReplace: boolean;
};

/**
 * Attach a weekly work-update PPT to the week's GM inbox package and notify GM.
 * JC PPT transfer is unchanged — only weekly updates use this path.
 */
export async function routeWeeklyPptToGm(
  supabase: SupabaseClient,
  input: RouteWeeklyPptToGmInput,
): Promise<{ shareId: string; newlyAdded: boolean }> {
  const { data: existingShares, error: findError } = await supabase
    .from('weekly_ppt_shares')
    .select('id')
    .eq('week_start', input.weekStart)
    .eq('note', WEEKLY_PPT_DIRECT_TO_GM_NOTE)
    .order('shared_at', { ascending: false })
    .limit(1);
  if (findError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to resolve the weekly GM package.', 500);
  }

  let shareId = (existingShares?.[0]?.id as string | undefined) ?? null;
  if (!shareId) {
    const { data: share, error: createError } = await supabase
      .from('weekly_ppt_shares')
      .insert({
        week_start: input.weekStart,
        week_end: input.weekEnd,
        shared_by: input.employeeId,
        file_count: 0,
        note: WEEKLY_PPT_DIRECT_TO_GM_NOTE,
      })
      .select('id')
      .single();
    if (createError || !share) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to open the weekly GM package.', 500);
    }
    shareId = share.id as string;
  }

  const { data: existingItem } = await supabase
    .from('weekly_ppt_share_items')
    .select('update_id')
    .eq('share_id', shareId)
    .eq('update_id', input.updateId)
    .maybeSingle();

  let newlyAdded = false;
  if (!existingItem) {
    const { error: itemError } = await supabase.from('weekly_ppt_share_items').insert({
      share_id: shareId,
      update_id: input.updateId,
    });
    if (itemError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to route the weekly PPT to General Manager.', 500);
    }
    newlyAdded = true;
  }

  const { count } = await supabase
    .from('weekly_ppt_share_items')
    .select('*', { count: 'exact', head: true })
    .eq('share_id', shareId);
  await supabase
    .from('weekly_ppt_shares')
    .update({
      file_count: count ?? 0,
      shared_at: new Date().toISOString(),
    })
    .eq('id', shareId);

  const gmStaff = await listStaffByRole(supabase, ROLE_CODES.GENERAL_MANAGER);
  if (gmStaff.length > 0) {
    const href = portalUrl(`/gm/weekly-updates?shareId=${encodeURIComponent(shareId)}`);
    const action = input.isReplace ? 'replaced' : 'uploaded';
    await notifyStaff(supabase, gmStaff, {
      type: 'work',
      title: input.isReplace ? 'Weekly PPT replaced' : 'Weekly PPT uploaded',
      message: `${input.employeeName} ${action} a weekly wrap PPT for ${input.weekStart} – ${input.weekEnd}.`,
      referenceType: 'weekly_ppt_share',
      referenceId: shareId,
      eyebrow: 'Weekly updates',
      paragraphs: [
        `${input.employeeName} ${action} ${input.systemFileName}.`,
        `Week ${input.weekStart} – ${input.weekEnd}. Open Weekly updates to download, email, or delete.`,
      ],
      details: [
        { label: 'Week', value: `${input.weekStart} – ${input.weekEnd}` },
        { label: 'Employee', value: input.employeeName },
        { label: 'File', value: input.systemFileName },
      ],
      ctaLabel: 'Open weekly updates',
      ctaHref: href,
    });
  }

  return { shareId, newlyAdded };
}

/**
 * Ensure every submitted weekly PPT for a week is in the GM direct package (backfill / sync).
 */
export async function syncWeekWeeklyPptsToGm(
  supabase: SupabaseClient,
  input: { weekStart: string; weekEnd: string; actorEmployeeId: string },
): Promise<{ shareId: string; added: number; total: number }> {
  const { data: updates, error } = await supabase
    .from('weekly_work_updates')
    .select('id')
    .eq('week_start', input.weekStart);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly updates.', 500);
  }
  const rows = updates ?? [];
  if (rows.length === 0) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'No weekly PPTs submitted for this week yet. Nothing to sync.',
      400,
    );
  }

  const { data: existingShares } = await supabase
    .from('weekly_ppt_shares')
    .select('id')
    .eq('week_start', input.weekStart)
    .eq('note', WEEKLY_PPT_DIRECT_TO_GM_NOTE)
    .order('shared_at', { ascending: false })
    .limit(1);

  let shareId = (existingShares?.[0]?.id as string | undefined) ?? null;
  if (!shareId) {
    const { data: share, error: createError } = await supabase
      .from('weekly_ppt_shares')
      .insert({
        week_start: input.weekStart,
        week_end: input.weekEnd,
        shared_by: input.actorEmployeeId,
        file_count: 0,
        note: WEEKLY_PPT_DIRECT_TO_GM_NOTE,
      })
      .select('id')
      .single();
    if (createError || !share) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to open the weekly GM package.', 500);
    }
    shareId = share.id as string;
  }

  const { data: existingItems } = await supabase
    .from('weekly_ppt_share_items')
    .select('update_id')
    .eq('share_id', shareId);
  const already = new Set((existingItems ?? []).map((row) => row.update_id as string));
  const toAdd = rows.filter((row) => !already.has(row.id as string));

  if (toAdd.length > 0) {
    const { error: itemsError } = await supabase.from('weekly_ppt_share_items').insert(
      toAdd.map((row) => ({ share_id: shareId, update_id: row.id })),
    );
    if (itemsError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to sync weekly PPTs to General Manager.', 500);
    }
  }

  const { count } = await supabase
    .from('weekly_ppt_share_items')
    .select('*', { count: 'exact', head: true })
    .eq('share_id', shareId);
  await supabase
    .from('weekly_ppt_shares')
    .update({
      file_count: count ?? 0,
      shared_at: new Date().toISOString(),
    })
    .eq('id', shareId);

  if (toAdd.length > 0) {
    const gmStaff = await listStaffByRole(supabase, ROLE_CODES.GENERAL_MANAGER);
    const href = portalUrl(`/gm/weekly-updates?shareId=${encodeURIComponent(shareId)}`);
    await notifyStaff(supabase, gmStaff, {
      type: 'work',
      title: 'Weekly PPTs synced to General Manager',
      message: `${toAdd.length} weekly PPT${toAdd.length === 1 ? '' : 's'} for ${input.weekStart} – ${input.weekEnd} are now in your inbox.`,
      referenceType: 'weekly_ppt_share',
      referenceId: shareId,
      eyebrow: 'Weekly updates',
      paragraphs: [
        `${toAdd.length} file${toAdd.length === 1 ? '' : 's'} synced for ${input.weekStart} – ${input.weekEnd}.`,
        'Open Weekly updates to download, email, or delete.',
      ],
      details: [
        { label: 'Week', value: `${input.weekStart} – ${input.weekEnd}` },
        { label: 'Added', value: String(toAdd.length) },
        { label: 'Total in package', value: String(count ?? 0) },
      ],
      ctaLabel: 'Open weekly updates',
      ctaHref: href,
    });
  }

  return { shareId, added: toAdd.length, total: count ?? 0 };
}
