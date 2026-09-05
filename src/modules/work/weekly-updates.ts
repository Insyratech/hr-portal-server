import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';
import { skipsWorkApprovalLoop } from './approval';
import { formatIsoDateInZone } from './ist-clock';
import {
  WEEKLY_PPT_BUCKET,
  WEEKLY_PPT_MAX_BYTES,
  WEEKLY_PPT_MAX_UPLOADS,
  WEEKLY_PPT_MIME,
  buildWeeklyPptSystemFileName,
  isWeeklyPptLate,
  pptExtension,
  pptWeekBounds,
  sundayOfPptWeek,
} from './ppt-week';

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

function assertWorkLoop(actor: RequestUser): void {
  if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot upload a weekly work update.', 403);
  }
  if (skipsWorkApprovalLoop(actor.roles)) {
    throw new AppError(
      API_ERROR_CODES.FORBIDDEN,
      'Weekly PPT updates are for employees on the work loop. Managerial hats skip this.',
      403,
    );
  }
}

export function createWeeklyUpdatesService(supabase: SupabaseClient) {
  async function loadEmployeeName(employeeId: string): Promise<string> {
    const { data } = await supabase.from('employees').select('full_name').eq('id', employeeId).maybeSingle();
    return (data?.full_name as string) || 'Employee';
  }

  async function loadCurrent(employeeId: string, weekStart: string): Promise<UpdateRow | null> {
    const { data, error } = await supabase
      .from('weekly_work_updates')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly update.', 500);
    return (data as UpdateRow | null) ?? null;
  }

  return {
    async getBoard(actor: RequestUser) {
      assertWorkLoop(actor);
      const today = formatIsoDateInZone(new Date());
      const week = pptWeekBounds(today);
      const deadlineDate = sundayOfPptWeek(week.start);
      const current = await loadCurrent(actor.employeeId, week.start);
      const { data: historyRows, error } = await supabase
        .from('weekly_work_updates')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .order('week_start', { ascending: false })
        .limit(16);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly update history.', 500);

      const history = ((historyRows ?? []) as UpdateRow[]).map(mapUpdate);

      const weeks: {
        weekStart: string;
        weekEnd: string;
        status: 'on_time' | 'late' | 'missing' | 'pending';
        update: ReturnType<typeof mapUpdate> | null;
      }[] = [];
      for (let i = 0; i < 8; i += 1) {
        const ref = formatIsoDate(addUtcDays(parseIsoDate(week.start), -7 * i));
        const bounds = pptWeekBounds(ref);
        const deadline = sundayOfPptWeek(bounds.start);
        const row = history.find((item) => item.weekStart === bounds.start) ?? null;
        let status: 'on_time' | 'late' | 'missing' | 'pending';
        if (row) {
          status = row.late ? 'late' : 'on_time';
        } else if (today > deadline) {
          status = 'missing';
        } else {
          status = 'pending';
        }
        weeks.push({
          weekStart: bounds.start,
          weekEnd: bounds.end,
          status,
          update: row,
        });
      }

      const onTime = weeks.filter((w) => w.status === 'on_time').length;
      const late = weeks.filter((w) => w.status === 'late').length;
      const missing = weeks.filter((w) => w.status === 'missing').length;

      return {
        week: {
          start: week.start,
          end: week.end,
          deadlineDate,
          deadlineLabel: `Sunday ${deadlineDate} 23:59 IST`,
          lateAfterLabel: `Sunday ${deadlineDate} 18:00 IST`,
        },
        current: current ? mapUpdate(current) : null,
        uploadsRemaining: current ? Math.max(0, WEEKLY_PPT_MAX_UPLOADS - current.upload_count) : WEEKLY_PPT_MAX_UPLOADS,
        maxUploads: WEEKLY_PPT_MAX_UPLOADS,
        maxBytes: WEEKLY_PPT_MAX_BYTES,
        stats: { onTime, late, missing, weeksTracked: weeks.length },
        weeks,
      };
    },

    async createUploadSession(
      actor: RequestUser,
      input: { fileName: string; contentType: string; sizeBytes: number },
      meta: RequestMeta,
    ) {
      assertWorkLoop(actor);
      const extension = pptExtension(input.fileName);
      if (!extension) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Upload a .ppt or .pptx file only.', 400);
      }
      if (input.sizeBytes <= 0 || input.sizeBytes > WEEKLY_PPT_MAX_BYTES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'File must be 1 MB or smaller.', 400);
      }
      const contentType = (input.contentType || '').trim() || 'application/octet-stream';
      if (contentType && !WEEKLY_PPT_MIME.has(contentType)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'File type must be PowerPoint (.ppt or .pptx).',
          400,
        );
      }

      const today = formatIsoDateInZone(new Date());
      const week = pptWeekBounds(today);
      const existing = await loadCurrent(actor.employeeId, week.start);
      if (existing && existing.upload_count >= WEEKLY_PPT_MAX_UPLOADS) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'You already used both uploads for this week. Contact CSO if you need a change.',
          409,
        );
      }

      const fullName = await loadEmployeeName(actor.employeeId);
      const systemFileName = buildWeeklyPptSystemFileName(fullName, week.start, week.end, extension);
      const storagePath = `${actor.employeeId}/${week.start}/${crypto.randomUUID()}-${systemFileName}`;
      const late = isWeeklyPptLate(new Date(), week.start);

      const { data: signed, error: signError } = await supabase.storage
        .from(WEEKLY_PPT_BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          'Failed to create upload URL. Ensure the weekly-work-updates bucket exists.',
          500,
        );
      }

      let mapped;
      if (existing) {
        await supabase.storage.from(WEEKLY_PPT_BUCKET).remove([existing.storage_path]);
        const { data, error } = await supabase
          .from('weekly_work_updates')
          .update({
            storage_path: storagePath,
            original_file_name: input.fileName,
            system_file_name: systemFileName,
            content_type: contentType,
            size_bytes: input.sizeBytes,
            upload_count: existing.upload_count + 1,
            submitted_at: new Date().toISOString(),
            late,
          })
          .eq('id', existing.id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to replace weekly update.', 500);
        }
        mapped = mapUpdate(data as UpdateRow);
      } else {
        const { data, error } = await supabase
          .from('weekly_work_updates')
          .insert({
            employee_id: actor.employeeId,
            week_start: week.start,
            week_end: week.end,
            storage_path: storagePath,
            original_file_name: input.fileName,
            system_file_name: systemFileName,
            content_type: contentType,
            size_bytes: input.sizeBytes,
            upload_count: 1,
            submitted_at: new Date().toISOString(),
            late,
          })
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to register weekly update.', 500);
        }
        mapped = mapUpdate(data as UpdateRow);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: existing ? 'weekly_work_update.replace' : 'weekly_work_update.create',
        entityType: 'weekly_work_update',
        entityId: mapped.id,
        newValues: mapped,
        ...meta,
      });

      return {
        update: mapped,
        uploadUrl: signed.signedUrl,
        token: signed.token,
        path: storagePath,
        bucket: WEEKLY_PPT_BUCKET,
      };
    },
  };
}
