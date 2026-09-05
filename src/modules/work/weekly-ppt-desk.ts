import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { assertCsoDomainOwner, assertGmDomainOwner, isCsoDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl } from '../notifications/mail';
import { listActiveStaff, listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { skipsWorkApprovalLoop } from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { formatIsoDateInZone } from './ist-clock';
import { WEEKLY_PPT_BUCKET, pptWeekBounds, sundayOfPptWeek } from './ppt-week';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type UpdateRow = {
  id: string;
  employee_id: string;
  week_start: string;
  week_end: string;
  storage_path: string;
  original_file_name: string;
  system_file_name: string;
  content_type: string;
  size_bytes: number;
  upload_count: number;
  submitted_at: string;
  late: boolean;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
            .select('id, system_file_name, late, employee_id')
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
          },
        ]),
      );

      const filesByShare = new Map<string, { updateId: string; systemFileName: string; late: boolean; employeeName: string }[]>();
      for (const item of items ?? []) {
        const file = updateById.get(item.update_id as string);
        if (!file) continue;
        const bucket = filesByShare.get(item.share_id as string) ?? [];
        bucket.push(file);
        filesByShare.set(item.share_id as string, bucket);
      }

      return {
        count: list.length,
        shares: list.map((row) => ({
          id: row.id as string,
          weekStart: row.week_start as string,
          weekEnd: row.week_end as string,
          sharedBy: row.shared_by as string,
          sharedByName: sharerName.get(row.shared_by as string) ?? 'CSO',
          sharedAt: row.shared_at as string,
          fileCount: row.file_count as number,
          note: row.note as string,
          files: filesByShare.get(row.id as string) ?? [],
        })),
      };
    },

    async getDownloadUrl(actor: RequestUser, updateId: string, shareId?: string) {
      const { data, error } = await supabase
        .from('weekly_work_updates')
        .select('id, employee_id, storage_path, system_file_name')
        .eq('id', updateId)
        .maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Weekly update not found.', 404);

      if (data.employee_id === actor.employeeId) {
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      if (isCsoDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.WORK_VIEW)) {
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      if (shareId) {
        assertGmDomainOwner(actor, 'download shared weekly updates');
        const { data: item } = await supabase
          .from('weekly_ppt_share_items')
          .select('share_id')
          .eq('share_id', shareId)
          .eq('update_id', updateId)
          .maybeSingle();
        if (!item) {
          throw new AppError(API_ERROR_CODES.FORBIDDEN, 'That file was not included in this share.', 403);
        }
        return signedDownload(data.storage_path as string, data.system_file_name as string);
      }

      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot download this weekly update.', 403);
    },
  };
}
