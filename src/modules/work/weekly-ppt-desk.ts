import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { assertCsoDomainOwner, assertGmDomainOwner, isCsoDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl, sendMail } from '../notifications/mail';
import { listActiveStaff, listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { skipsWorkApprovalLoop } from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { formatIsoDateInZone } from './ist-clock';
import { WEEKLY_PPT_BUCKET, pptWeekBounds, sundayOfPptWeek } from './ppt-week';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type FileRemovedReason = 'downloaded' | 'emailed' | 'deleted';

type UpdateRow = {
  id: string;
  employee_id: string;
  week_start: string;
  week_end: string;
  storage_path: string | null;
  original_file_name: string;
  system_file_name: string;
  content_type: string;
  size_bytes: number;
  upload_count: number;
  submitted_at: string;
  late: boolean;
  file_removed_at: string | null;
  file_removed_by: string | null;
  file_removed_reason: FileRemovedReason | null;
  email_recipient: string | null;
  created_at: string;
  updated_at: string;
};

function mapUpdate(row: UpdateRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    originalFileName: row.original_file_name,
    systemFileName: row.system_file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadCount: row.upload_count,
    submittedAt: row.submitted_at,
    late: row.late,
    fileAvailable: Boolean(row.storage_path),
    fileRemovedAt: row.file_removed_at,
    fileRemovedBy: row.file_removed_by,
    fileRemovedReason: row.file_removed_reason,
    emailRecipient: row.email_recipient,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function assertCsoDesk(actor: RequestUser): void {
  assertCsoDomainOwner(actor, 'manage weekly work updates');
  if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot open the weekly PPT desk.', 403);
  }
}

export function createWeeklyPptDeskService(supabase: SupabaseClient) {
  async function signedDownload(storagePath: string, fileName: string) {
    const { data: signed, error: signError } = await supabase.storage
      .from(WEEKLY_PPT_BUCKET)
      .createSignedUrl(storagePath, 60 * 30);
    if (signError || !signed) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create download URL.', 500);
    }
    return { url: signed.signedUrl, fileName };
  }

  async function downloadBytes(storagePath: string): Promise<Uint8Array> {
    const { data, error } = await supabase.storage.from(WEEKLY_PPT_BUCKET).download(storagePath);
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to read weekly PPT from storage.', 500);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async function assertShareContains(shareId: string, updateId: string) {
    const { data: item } = await supabase
      .from('weekly_ppt_share_items')
      .select('share_id')
      .eq('share_id', shareId)
      .eq('update_id', updateId)
      .maybeSingle();
    if (!item) {
      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'That file was not included in this share.', 403);
    }
  }

  async function consumeSharedFile(
    actor: RequestUser,
    updateId: string,
    shareId: string,
    mode: FileRemovedReason,
    emailRecipient: string | null,
    meta: RequestMeta,
  ) {
    assertGmDomainOwner(actor, 'manage shared weekly updates');
    await assertShareContains(shareId, updateId);

    const { data, error } = await supabase.from('weekly_work_updates').select('*').eq('id', updateId).maybeSingle();
    if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Weekly update not found.', 404);
    const row = data as UpdateRow;
    if (!row.storage_path) {
      throw new AppError(
        API_ERROR_CODES.CONFLICT,
        'File is no longer available. Audit history remains on this page.',
        409,
      );
    }

    const fileName = row.system_file_name;
    const contentType = row.content_type || 'application/octet-stream';
    let bytes: Uint8Array | null = null;
    if (mode === 'downloaded' || mode === 'emailed') {
      bytes = await downloadBytes(row.storage_path);
    }

    if (mode === 'emailed') {
      if (!emailRecipient || !isValidEmail(emailRecipient)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a valid recipient email address.', 400);
      }
      try {
        const mail = await sendMail({
          to: [emailRecipient],
          subject: `Weekly PPT: ${fileName}`,
          text: `Attached is the weekly work-update PowerPoint "${fileName}" from the HR Portal.`,
          html: `<p>Attached is the weekly work-update PowerPoint <strong>${fileName}</strong> from the HR Portal.</p>`,
          attachments: [{ name: fileName, content: Buffer.from(bytes!).toString('base64') }],
        });
        if (!mail.sent) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            'Email delivery is not configured. File was not removed.',
            502,
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to email the weekly PPT. File was not removed.', 502);
      }
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from('weekly_work_updates')
      .update({
        storage_path: null,
        file_removed_at: now,
        file_removed_by: actor.employeeId,
        file_removed_reason: mode,
        email_recipient: mode === 'emailed' ? emailRecipient : null,
      })
      .eq('id', updateId)
      .not('storage_path', 'is', null)
      .select('*')
      .maybeSingle();
    if (updateError || !updated) {
      throw new AppError(API_ERROR_CODES.CONFLICT, 'Weekly PPT was already removed.', 409);
    }

    await supabase.storage.from(WEEKLY_PPT_BUCKET).remove([row.storage_path]);
    await writeAuditLog(supabase, {
      actorId: actor.employeeId,
      action:
        mode === 'emailed'
          ? 'weekly_work_update.email'
          : mode === 'downloaded'
            ? 'weekly_work_update.download_remove'
            : 'weekly_work_update.delete',
      entityType: 'weekly_work_update',
      entityId: updateId,
      newValues: { fileRemovedReason: mode, emailRecipient, shareId },
      ...meta,
    });

    return {
      update: mapUpdate(updated as UpdateRow),
      download:
        mode === 'downloaded' && bytes
          ? {
              fileName,
              contentType,
              contentBase64: Buffer.from(bytes).toString('base64'),
            }
          : null,
    };
  }

  return {
    async getAdminBoard(actor: RequestUser, weekStart?: string) {
      assertCsoDesk(actor);
      const today = formatIsoDateInZone(new Date());
      const week = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? pptWeekBounds(weekStart) : pptWeekBounds(today);
      const deadlineDate = sundayOfPptWeek(week.start);
      const staff = await listActiveStaff(supabase);
      const rolesByEmployee = await loadEmployeeRoleMap(supabase);
      const loop = staff.filter((person) => !skipsWorkApprovalLoop(rolesByEmployee.get(person.id) ?? []));

      const { data: updates, error } = await supabase
        .from('weekly_work_updates')
        .select('*')
        .eq('week_start', week.start);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly updates.', 500);
      const byEmployee = new Map(((updates ?? []) as UpdateRow[]).map((row) => [row.employee_id, row]));

      const people = loop.map((person) => {
        const row = byEmployee.get(person.id) ?? null;
        let status: 'on_time' | 'late' | 'missing' | 'pending';
        if (row) {
          status = row.late ? 'late' : 'on_time';
        } else if (today > deadlineDate) {
          status = 'missing';
        } else {
          status = 'pending';
        }
        return {
          employeeId: person.id,
          fullName: person.fullName,
          email: person.email,
          status,
          update: row ? mapUpdate(row) : null,
        };
      });

      people.sort((a, b) => a.fullName.localeCompare(b.fullName));

      const { data: shares } = await supabase
        .from('weekly_ppt_shares')
        .select('id, week_start, week_end, shared_by, shared_at, file_count, note')
        .eq('week_start', week.start)
        .order('shared_at', { ascending: false });

      const shareList = shares ?? [];
      const sharerIds = [...new Set(shareList.map((row) => row.shared_by as string))];
      const { data: sharers } = sharerIds.length
        ? await supabase.from('employees').select('id, full_name').in('id', sharerIds)
        : { data: [] };
      const sharerName = new Map((sharers ?? []).map((row) => [row.id as string, row.full_name as string]));

      return {
        week: {
          start: week.start,
          end: week.end,
          deadlineDate,
          deadlineLabel: `Sunday ${deadlineDate} 23:59 IST`,
          lateAfterLabel: `Sunday ${deadlineDate} 18:00 IST`,
        },
        counts: {
          expected: people.length,
          onTime: people.filter((p) => p.status === 'on_time').length,
          late: people.filter((p) => p.status === 'late').length,
          missing: people.filter((p) => p.status === 'missing').length,
          pending: people.filter((p) => p.status === 'pending').length,
          submitted: people.filter((p) => p.update).length,
        },
        people,
        shares: shareList.map((row) => ({
          id: row.id as string,
          weekStart: row.week_start as string,
          weekEnd: row.week_end as string,
          sharedBy: row.shared_by as string,
          sharedByName: sharerName.get(row.shared_by as string) ?? 'CSO',
          sharedAt: row.shared_at as string,
          fileCount: row.file_count as number,
          note: row.note as string,
        })),
      };
    },

    async shareWeekToGm(actor: RequestUser, weekStart: string | undefined, meta: RequestMeta) {
      assertCsoDesk(actor);
      const today = formatIsoDateInZone(new Date());
      const week =
        weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? pptWeekBounds(weekStart) : pptWeekBounds(today);

      const { data: updates, error } = await supabase
        .from('weekly_work_updates')
        .select('*')
        .eq('week_start', week.start);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly updates.', 500);
      const rows = (updates ?? []) as UpdateRow[];
      if (rows.length === 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'No weekly PPTs submitted for this week yet. Nothing to share.',
          400,
        );
      }

      const { data: share, error: shareError } = await supabase
        .from('weekly_ppt_shares')
        .insert({
          week_start: week.start,
          week_end: week.end,
          shared_by: actor.employeeId,
          file_count: rows.length,
          note: '',
        })
        .select('id, week_start, week_end, shared_at, file_count')
        .single();
      if (shareError || !share) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create the share package.', 500);
      }

      const { error: itemsError } = await supabase.from('weekly_ppt_share_items').insert(
        rows.map((row) => ({ share_id: share.id, update_id: row.id })),
      );
      if (itemsError) {
        await supabase.from('weekly_ppt_shares').delete().eq('id', share.id);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to attach files to the share.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_ppt_share.create',
        entityType: 'weekly_ppt_share',
        entityId: share.id as string,
        newValues: { weekStart: week.start, fileCount: rows.length },
        ...meta,
      });

      const cso = await loadStaffById(supabase, actor.employeeId);
      const gmStaff = await listStaffByRole(supabase, ROLE_CODES.GENERAL_MANAGER);
      const href = portalUrl(`/gm/weekly-updates?shareId=${encodeURIComponent(share.id as string)}`);
      const fileLines = rows
        .slice(0, 12)
        .map((row) => row.system_file_name)
        .join('; ');
      await notifyStaff(supabase, gmStaff, {
        type: 'work',
        title: 'CSO shared this week’s work-update PPTs',
        message: `${cso?.fullName ?? 'CSO'} shared ${rows.length} weekly PPT${rows.length === 1 ? '' : 's'} for ${week.start} – ${week.end}.`,
        referenceType: 'weekly_ppt_share',
        referenceId: share.id as string,
        eyebrow: 'Weekly updates',
        paragraphs: [
          `${cso?.fullName ?? 'CSO'} shared the weekly work-update deck package for ${week.start} – ${week.end}.`,
          `Files included: ${rows.length}. Open Shared weekly updates to download.`,
          fileLines ? `Sample names: ${fileLines}${rows.length > 12 ? '…' : ''}` : '',
        ].filter(Boolean),
        details: [
          { label: 'Week', value: `${week.start} – ${week.end}` },
          { label: 'Files', value: String(rows.length) },
          { label: 'Shared by', value: cso?.fullName ?? 'CSO' },
        ],
        ctaLabel: 'Open shared PPTs',
        ctaHref: href,
      });

      return {
        share: {
          id: share.id as string,
          weekStart: share.week_start as string,
          weekEnd: share.week_end as string,
          sharedAt: share.shared_at as string,
          fileCount: share.file_count as number,
        },
        recipients: gmStaff.length,
      };
    },

    async listGmShares(actor: RequestUser) {
      assertGmDomainOwner(actor, 'view shared weekly updates');
      const { data: shares, error } = await supabase
        .from('weekly_ppt_shares')
        .select('id, week_start, week_end, shared_by, shared_at, file_count, note')
        .order('shared_at', { ascending: false })
        .limit(40);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shared packages.', 500);

      const list = shares ?? [];
      const sharerIds = [...new Set(list.map((row) => row.shared_by as string))];
      const { data: sharers } = sharerIds.length
        ? await supabase.from('employees').select('id, full_name').in('id', sharerIds)
        : { data: [] };
      const sharerName = new Map((sharers ?? []).map((row) => [row.id as string, row.full_name as string]));

      const shareIds = list.map((row) => row.id as string);
      const { data: items } = shareIds.length
        ? await supabase.from('weekly_ppt_share_items').select('share_id, update_id').in('share_id', shareIds)
        : { data: [] };
      const updateIds = [...new Set((items ?? []).map((row) => row.update_id as string))];
      const { data: updateRows } = updateIds.length
        ? await supabase
            .from('weekly_work_updates')
            .select(
              'id, system_file_name, late, employee_id, storage_path, file_removed_at, file_removed_reason, email_recipient',
            )
            .in('id', updateIds)
        : { data: [] };
      const employeeIds = [...new Set((updateRows ?? []).map((row) => row.employee_id as string))];
      const { data: employees } = employeeIds.length
        ? await supabase.from('employees').select('id, full_name').in('id', employeeIds)
        : { data: [] };
      const nameById = new Map((employees ?? []).map((row) => [row.id as string, row.full_name as string]));
      const updateById = new Map(
        (updateRows ?? []).map((row) => [
          row.id as string,
          {
            updateId: row.id as string,
            systemFileName: row.system_file_name as string,
            late: Boolean(row.late),
            employeeName: nameById.get(row.employee_id as string) ?? 'Employee',
            fileAvailable: Boolean(row.storage_path),
            fileRemovedAt: (row.file_removed_at as string | null) ?? null,
            fileRemovedReason: (row.file_removed_reason as FileRemovedReason | null) ?? null,
            emailRecipient: (row.email_recipient as string | null) ?? null,
          },
        ]),
      );

      const filesByShare = new Map<
        string,
        {
          updateId: string;
          systemFileName: string;
          late: boolean;
          employeeName: string;
          fileAvailable: boolean;
          fileRemovedAt: string | null;
          fileRemovedReason: FileRemovedReason | null;
          emailRecipient: string | null;
        }[]
      >();
      for (const item of items ?? []) {
        const file = updateById.get(item.update_id as string);
        if (!file) continue;
        const bucket = filesByShare.get(item.share_id as string) ?? [];
        bucket.push(file);
        filesByShare.set(item.share_id as string, bucket);
      }

      return {
        count: list.length,
        shares: list.map((row) => {
          const files = filesByShare.get(row.id as string) ?? [];
          return {
            id: row.id as string,
            weekStart: row.week_start as string,
            weekEnd: row.week_end as string,
            sharedBy: row.shared_by as string,
            sharedByName: sharerName.get(row.shared_by as string) ?? 'CSO',
            sharedAt: row.shared_at as string,
            fileCount: row.file_count as number,
            note: row.note as string,
            availableCount: files.filter((file) => file.fileAvailable).length,
            files,
          };
        }),
      };
    },

    async getDownloadUrl(actor: RequestUser, updateId: string, shareId?: string) {
      const { data, error } = await supabase
        .from('weekly_work_updates')
        .select('id, employee_id, storage_path, system_file_name')
        .eq('id', updateId)
        .maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Weekly update not found.', 404);
      if (!data.storage_path) {
        throw new AppError(
          API_ERROR_CODES.NOT_FOUND,
          'File is no longer available. Audit history remains on this page.',
          404,
        );
      }

      if (data.employee_id === actor.employeeId) {
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      if (isCsoDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.WORK_VIEW)) {
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      if (shareId) {
        assertGmDomainOwner(actor, 'download shared weekly updates');
        await assertShareContains(shareId, updateId);
        // Preview-only signed URL. GM consume/download-remove uses dedicated endpoints.
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot download this weekly update.', 403);
    },

    async gmDownload(actor: RequestUser, updateId: string, shareId: string, meta: RequestMeta) {
      return consumeSharedFile(actor, updateId, shareId, 'downloaded', null, meta);
    },

    async gmEmail(
      actor: RequestUser,
      updateId: string,
      shareId: string,
      recipientEmail: string,
      meta: RequestMeta,
    ) {
      return consumeSharedFile(actor, updateId, shareId, 'emailed', recipientEmail.trim().toLowerCase(), meta);
    },

    async gmDelete(actor: RequestUser, updateId: string, shareId: string, meta: RequestMeta) {
      return consumeSharedFile(actor, updateId, shareId, 'deleted', null, meta);
    },

    async gmDeleteAllInShare(actor: RequestUser, shareId: string, meta: RequestMeta) {
      assertGmDomainOwner(actor, 'manage shared weekly updates');
      const { data: items, error } = await supabase
        .from('weekly_ppt_share_items')
        .select('update_id')
        .eq('share_id', shareId);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load share files.', 500);
      const updateIds = (items ?? []).map((row) => row.update_id as string);
      if (updateIds.length === 0) return { removed: 0 };

      const { data: updates, error: updatesError } = await supabase
        .from('weekly_work_updates')
        .select('id')
        .in('id', updateIds)
        .not('storage_path', 'is', null);
      if (updatesError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly PPTs.', 500);

      let removed = 0;
      for (const row of updates ?? []) {
        await consumeSharedFile(actor, row.id as string, shareId, 'deleted', null, meta);
        removed += 1;
      }
      return { removed };
    },
  };
}
