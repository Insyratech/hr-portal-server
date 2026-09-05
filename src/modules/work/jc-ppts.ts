import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl } from '../notifications/mail';
import { skipsWorkApprovalLoop } from './approval';
import {
  JC_PPT_BUCKET,
  JC_PPT_MAX_BYTES,
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

function mapJc(row: JcRow, extras?: { employeeName?: string; transferredByName?: string | null; consumedByName?: string | null }) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: extras?.employeeName,
    originalFileName: row.original_file_name,
    systemFileName: row.system_file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    fileAvailable: Boolean(row.storage_path) && (row.status === 'uploaded' || row.status === 'with_gm'),
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

  return {
    async getBoard(actor: RequestUser) {
      assertWorkLoop(actor);
      const { data, error } = await supabase
        .from('jc_ppts')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .order('uploaded_at', { ascending: false })
        .limit(100);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC PPTs.', 500);
      const rows = (data ?? []) as JcRow[];
      const pending = rows.find((row) => row.status === 'uploaded') ?? null;
      const events = await loadEvents(rows.map((row) => row.id));
      const nameById = await namesForIds([
        ...rows.map((r) => r.transferred_by).filter(Boolean) as string[],
        ...rows.map((r) => r.consumed_by).filter(Boolean) as string[],
        ...events.map((e) => e.actor_id).filter(Boolean) as string[],
      ]);

      return {
        maxBytes: JC_PPT_MAX_BYTES,
        pending: pending
          ? mapJc(pending, {
              transferredByName: pending.transferred_by ? nameById.get(pending.transferred_by) ?? null : null,
              consumedByName: pending.consumed_by ? nameById.get(pending.consumed_by) ?? null : null,
            })
          : null,
        items: rows.map((row) =>
          mapJc(row, {
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        events: events.map((event) => mapEvent(event, event.actor_id ? nameById.get(event.actor_id) ?? null : null)),
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

      const { data: pendingRows } = await supabase
        .from('jc_ppts')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .eq('status', 'uploaded')
        .order('uploaded_at', { ascending: false })
        .limit(1);
      const existing = ((pendingRows ?? [])[0] as JcRow | undefined) ?? null;

      const fullName = await loadEmployeeName(actor.employeeId);
      const systemFileName = buildJcPptSystemFileName(fullName, extension);
      const storagePath = `${actor.employeeId}/${crypto.randomUUID()}-${systemFileName}`;

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
            uploaded_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to replace JC PPT.', 500);
        }
        mapped = mapJc(data as JcRow);
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
            status: 'uploaded',
            uploaded_at: new Date().toISOString(),
          })
          .select('*')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to register JC PPT.', 500);
        }
        mapped = mapJc(data as JcRow);
        await insertEvent(mapped.id, actor.employeeId, 'uploaded', 'Employee uploaded JC PPT.');
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
            'Open Team JC to review and transfer it to General Manager when ready.',
          ],
          details: [
            { label: 'Employee', value: employee?.fullName ?? 'Employee' },
            { label: 'File', value: mapped.systemFileName },
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
      if (!data.storage_path || (data.status !== 'uploaded' && data.status !== 'with_gm')) {
        throw new AppError(
          API_ERROR_CODES.NOT_FOUND,
          'File is no longer available. Audit history remains on this page.',
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
