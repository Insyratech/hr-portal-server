import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl } from '../notifications/mail';
import { skipsWorkApprovalLoop } from './approval';
import { formatIsoDateInZone } from './ist-clock';
import { createPptConcernsService } from './ppt-concerns';
import {
  isWeeklyPptLate,
  pptWeekBounds,
  readWeeklyPptTiming,
  saturdayOfPptWeek,
  sundayOfPptWeek,
  WEEKLY_PPT_LAST_HOUR,
  WEEKLY_PPT_WINDOW_OPEN_HOUR,
  weeklyPptTiming,
  type WeeklyPptTiming,
} from './ppt-week';
import {
  JC_PPT_BUCKET,
  JC_PPT_MAX_BYTES,
  JC_PPT_MAX_UPLOADS,
  JC_PPT_MIME,
  buildJcPptSystemFileName,
  pptExtension,
  type JcPptStatus,
} from './jc-ppt';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type JcRow = {
  id: string;
  employee_id: string;
  storage_path: string | null;
  original_file_name: string;
  system_file_name: string;
  content_type: string;
  size_bytes: number;
  status: JcPptStatus;
  paper_title: string;
  doi_url: string;
  week_start: string;
  week_end: string;
  upload_count: number;
  submission_timing: string | null;
  late: boolean;
  uploaded_at: string;
  transferred_at: string | null;
  transferred_by: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  email_recipient: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  jc_ppt_id: string;
  actor_id: string | null;
  event_type: string;
  note: string;
  created_at: string;
};

function normalizePaperTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (title.length < 3) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'Enter the research paper name (at least 3 characters).',
      400,
    );
  }
  if (title.length > 500) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Paper name must be 500 characters or fewer.', 400);
  }
  return title;
}

function normalizeDoiUrl(raw: string): string {
  const value = raw.trim();
  if (value.length < 5) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a DOI or paper link.', 400);
  }
  if (value.length > 500) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'DOI / link must be 500 characters or fewer.', 400);
  }
  if (/^10\.\d{4,}\/\S+$/i.test(value)) {
    return `https://doi.org/${value}`;
  }
  if (/^doi:\s*10\.\d{4,}\/\S+$/i.test(value)) {
    return `https://doi.org/${value.replace(/^doi:\s*/i, '')}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('bad protocol');
    }
    return url.toString();
  } catch {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'DOI must be a link (https://…) or a DOI like 10.1234/example.',
      400,
    );
  }
}

export function mapJcPptItem(
  row: JcRow,
  extras?: { employeeName?: string; transferredByName?: string | null; consumedByName?: string | null },
) {
  const timing = readWeeklyPptTiming(row) as WeeklyPptTiming;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: extras?.employeeName,
    originalFileName: row.original_file_name,
    systemFileName: row.system_file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    paperTitle: row.paper_title ?? '',
    doiUrl: row.doi_url ?? '',
    weekStart: String(row.week_start).slice(0, 10),
    weekEnd: String(row.week_end).slice(0, 10),
    uploadCount: row.upload_count ?? 1,
    timing,
    late: Boolean(row.late) || timing === 'late',
    /** Employee/CSO may view only while pending with CSO (before transfer to GM). */
    fileAvailable: Boolean(row.storage_path) && row.status === 'uploaded',
    uploadedAt: row.uploaded_at,
    transferredAt: row.transferred_at,
    transferredBy: row.transferred_by,
    transferredByName: extras?.transferredByName ?? null,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    consumedByName: extras?.consumedByName ?? null,
    emailRecipient: row.email_recipient,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow, actorName?: string | null) {
  return {
    id: row.id,
    jcPptId: row.jc_ppt_id,
    actorId: row.actor_id,
    actorName: actorName ?? null,
    eventType: row.event_type,
    note: row.note,
    createdAt: row.created_at,
  };
}

function assertWorkLoop(actor: RequestUser): void {
  if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot upload a JC PPT.', 403);
  }
  if (skipsWorkApprovalLoop(actor.roles)) {
    throw new AppError(
      API_ERROR_CODES.FORBIDDEN,
      'JC PPT uploads are for employees on the work loop. Managerial hats skip this.',
      403,
    );
  }
}

export function createJcPptsService(supabase: SupabaseClient) {
  async function loadEmployeeName(employeeId: string): Promise<string> {
    const { data } = await supabase.from('employees').select('full_name').eq('id', employeeId).maybeSingle();
    return (data?.full_name as string) || 'Employee';
  }

  async function insertEvent(
    jcPptId: string,
    actorId: string,
    eventType: 'uploaded' | 'replaced' | 'transferred_to_gm' | 'downloaded' | 'emailed',
    note = '',
  ) {
    await supabase.from('jc_ppt_events').insert({
      jc_ppt_id: jcPptId,
      actor_id: actorId,
      event_type: eventType,
      note,
    });
  }

  async function loadEvents(jcPptIds: string[]) {
    if (jcPptIds.length === 0) return [];
    const { data, error } = await supabase
      .from('jc_ppt_events')
      .select('*')
      .in('jc_ppt_id', jcPptIds)
      .order('created_at', { ascending: false });
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC audit events.', 500);
    return (data ?? []) as EventRow[];
  }

  async function namesForIds(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map<string, string>();
    const { data } = await supabase.from('employees').select('id, full_name').in('id', unique);
    return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
  }

  async function loadWeekRow(employeeId: string, weekStart: string): Promise<JcRow | null> {
    const { data, error } = await supabase
      .from('jc_ppts')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC PPT for this week.', 500);
    return (data as JcRow | null) ?? null;
  }

  return {
    async getBoard(actor: RequestUser) {
      assertWorkLoop(actor);
      const today = formatIsoDateInZone(new Date());
      const week = pptWeekBounds(today);
      const deadlineDate = sundayOfPptWeek(week.start);
      const windowOpenDate = saturdayOfPptWeek(week.start);

      const { data, error } = await supabase
        .from('jc_ppts')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .order('uploaded_at', { ascending: false })
        .limit(100);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC PPTs.', 500);
      const rows = (data ?? []) as JcRow[];
      const current = rows.find((row) => String(row.week_start).slice(0, 10) === week.start) ?? null;
      const pending = current && current.status === 'uploaded' ? current : null;
      const events = await loadEvents(rows.map((row) => row.id));
      const nameById = await namesForIds([
        ...(rows.map((r) => r.transferred_by).filter(Boolean) as string[]),
        ...(rows.map((r) => r.consumed_by).filter(Boolean) as string[]),
        ...(events.map((e) => e.actor_id).filter(Boolean) as string[]),
      ]);

      const mapRow = (row: JcRow) =>
        mapJcPptItem(row, {
          transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
          consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
        });

      const uploadsRemaining = (() => {
        if (!current) return JC_PPT_MAX_UPLOADS;
        if (current.status !== 'uploaded') return 0;
        return Math.max(0, JC_PPT_MAX_UPLOADS - (current.upload_count ?? 1));
      })();

      return {
        week: {
          start: week.start,
          end: week.end,
          deadlineDate,
          windowOpenDate,
          deadlineLabel: `Sunday ${deadlineDate} 23:59 IST`,
          windowOpenLabel: `Saturday ${windowOpenDate} ${WEEKLY_PPT_WINDOW_OPEN_HOUR}:00 IST`,
          lastHourAfterLabel: `Sunday ${deadlineDate} ${WEEKLY_PPT_LAST_HOUR}:00 IST`,
        },
        maxBytes: JC_PPT_MAX_BYTES,
        maxUploads: JC_PPT_MAX_UPLOADS,
        uploadsRemaining,
        current: current ? mapRow(current) : null,
        pending: pending ? mapRow(pending) : null,
        items: rows.map(mapRow),
        events: events.map((event) => mapEvent(event, event.actor_id ? nameById.get(event.actor_id) ?? null : null)),
      };
    },

    async createUploadSession(
      actor: RequestUser,
      input: {
        fileName: string;
        contentType: string;
        sizeBytes: number;
        paperTitle: string;
        doiUrl: string;
      },
      meta: RequestMeta,
    ) {
      assertWorkLoop(actor);
      const extension = pptExtension(input.fileName);
      if (!extension) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Upload a .ppt or .pptx file only.', 400);
      }
      if (input.sizeBytes <= 0 || input.sizeBytes > JC_PPT_MAX_BYTES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'File must be 15 MB or smaller.', 400);
      }
      const contentType = (input.contentType || '').trim() || 'application/octet-stream';
      if (contentType && !JC_PPT_MIME.has(contentType)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'File type must be PowerPoint (.ppt or .pptx).',
          400,
        );
      }

      const paperTitle = normalizePaperTitle(input.paperTitle ?? '');
      const doiUrl = normalizeDoiUrl(input.doiUrl ?? '');

      const now = new Date();
      const today = formatIsoDateInZone(now);
      const week = pptWeekBounds(today);
      const concerns = createPptConcernsService(supabase);
      const gate = await concerns.assertUploadAllowed({
        now,
        weekStart: week.start,
        employeeId: actor.employeeId,
        kind: 'jc',
      });

      const existing = await loadWeekRow(actor.employeeId, week.start);
      if (existing && existing.status !== 'uploaded') {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'This week’s JC PPT was already transferred. You cannot replace it.',
          409,
        );
      }
      if (existing && (existing.upload_count ?? 1) >= JC_PPT_MAX_UPLOADS) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          `You already used all ${JC_PPT_MAX_UPLOADS} JC uploads for this week. Raise a concern if you need help.`,
          409,
        );
      }

      const fullName = await loadEmployeeName(actor.employeeId);
      const systemFileName = buildJcPptSystemFileName(fullName, extension);
      const storagePath = `${actor.employeeId}/${week.start}/${crypto.randomUUID()}-${systemFileName}`;
      const timing = weeklyPptTiming(now, week.start);
      const late = isWeeklyPptLate(timing) || gate.timingIsLate;

      const { data: signed, error: signError } = await supabase.storage
        .from(JC_PPT_BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          'Failed to create upload URL. Ensure the jc-ppt-uploads bucket exists.',
          500,
        );
      }

      let mapped;
      if (existing) {
        if (existing.storage_path) {
          await supabase.storage.from(JC_PPT_BUCKET).remove([existing.storage_path]);
        }
        const { data, error } = await supabase
          .from('jc_ppts')
          .update({
            storage_path: storagePath,
            original_file_name: input.fileName,
            system_file_name: systemFileName,
            content_type: contentType,
            size_bytes: input.sizeBytes,
            paper_title: paperTitle,
            doi_url: doiUrl,
            week_start: week.start,
            week_end: week.end,
            upload_count: (existing.upload_count ?? 1) + 1,
            submission_timing: timing,
            late,
            uploaded_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to replace JC PPT.', 500);
        }
        mapped = mapJcPptItem(data as JcRow);
        await insertEvent(mapped.id, actor.employeeId, 'replaced', 'Employee replaced pending JC PPT.');
      } else {
        const { data, error } = await supabase
          .from('jc_ppts')
          .insert({
            employee_id: actor.employeeId,
            storage_path: storagePath,
            original_file_name: input.fileName,
            system_file_name: systemFileName,
            content_type: contentType,
            size_bytes: input.sizeBytes,
            paper_title: paperTitle,
            doi_url: doiUrl,
            week_start: week.start,
            week_end: week.end,
            upload_count: 1,
            submission_timing: timing,
            late,
            status: 'uploaded',
            uploaded_at: new Date().toISOString(),
          })
          .select('*')
          .single();
        if (error || !data) {
          if (error?.code === '23505') {
            throw new AppError(
              API_ERROR_CODES.CONFLICT,
              'A JC PPT already exists for this week. Refresh and try again.',
              409,
            );
          }
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to register JC PPT.', 500);
        }
        mapped = mapJcPptItem(data as JcRow);
        await insertEvent(mapped.id, actor.employeeId, 'uploaded', 'Employee uploaded JC PPT.');
      }

      if (gate.reopenConcernId) {
        await concerns.consumeApprovedReopen(gate.reopenConcernId);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: existing ? 'jc_ppt.replace' : 'jc_ppt.create',
        entityType: 'jc_ppt',
        entityId: mapped.id,
        newValues: mapped,
        ...meta,
      });

      const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
      const employee = await loadStaffById(supabase, actor.employeeId);
      if (csoStaff.length > 0) {
        await notifyStaff(supabase, csoStaff, {
          type: 'work',
          title: existing ? 'JC PPT replaced' : 'New JC PPT uploaded',
          message: `${employee?.fullName ?? 'An employee'} ${existing ? 'replaced' : 'uploaded'} a JC PPT.`,
          referenceType: 'jc_ppt',
          referenceId: mapped.id,
          eyebrow: 'Team JC',
          paragraphs: [
            `${employee?.fullName ?? 'An employee'} ${existing ? 'replaced their pending' : 'uploaded a'} JC PPT.`,
            `Paper: ${paperTitle}`,
            'Open Team JC to review and transfer it to General Manager when ready.',
          ],
          details: [
            { label: 'Employee', value: employee?.fullName ?? 'Employee' },
            { label: 'Paper', value: paperTitle },
            { label: 'DOI / link', value: doiUrl },
            { label: 'File', value: mapped.systemFileName },
            { label: 'Week', value: `${week.start} → ${week.end}` },
            ...(late ? [{ label: 'Timing', value: 'Late (approved reopen)' }] : []),
          ],
          ctaLabel: 'Open Team JC',
          ctaHref: portalUrl('/cso/work/jc'),
        });
      }

      return {
        item: mapped,
        uploadUrl: signed.signedUrl,
        token: signed.token,
        path: storagePath,
        bucket: JC_PPT_BUCKET,
      };
    },

    async getDownloadUrl(actor: RequestUser, id: string) {
      assertWorkLoop(actor);
      const { data, error } = await supabase
        .from('jc_ppts')
        .select('id, employee_id, storage_path, system_file_name, status')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      if (data.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot download this JC PPT.', 403);
      }
      if (!data.storage_path || data.status !== 'uploaded') {
        throw new AppError(
          API_ERROR_CODES.NOT_FOUND,
          data.status === 'with_gm'
            ? 'This JC PPT was transferred to General Manager. View is no longer available; history remains on this page.'
            : 'File is no longer available. Audit history remains on this page.',
          404,
        );
      }
      const { data: signed, error: signError } = await supabase.storage
        .from(JC_PPT_BUCKET)
        .createSignedUrl(data.storage_path as string, 60 * 30);
      if (signError || !signed) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create download URL.', 500);
      }
      return { url: signed.signedUrl, fileName: data.system_file_name as string };
    },
  };
}
