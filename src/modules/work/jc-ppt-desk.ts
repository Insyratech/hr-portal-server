import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { assertCsoDomainOwner, assertGmDomainOwner, isCsoDomainOwner, isGmDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { sendMail, portalUrl } from '../notifications/mail';
import { listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { JC_PPT_BUCKET, type JcPptStatus } from './jc-ppt';

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

function mapJc(
  row: JcRow,
  extras?: { employeeName?: string; transferredByName?: string | null; consumedByName?: string | null },
) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: extras?.employeeName ?? 'Employee',
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

function assertCsoDesk(actor: RequestUser): void {
  assertCsoDomainOwner(actor, 'manage Team JC');
  if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot open Team JC.', 403);
  }
}

function assertGmDesk(actor: RequestUser): void {
  assertGmDomainOwner(actor, 'manage Team JC');
  if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot open Team JC.', 403);
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function createJcPptDeskService(supabase: SupabaseClient) {
  async function insertEvent(
    jcPptId: string,
    actorId: string,
    eventType: 'uploaded' | 'replaced' | 'transferred_to_gm' | 'downloaded' | 'emailed' | 'deleted',
    note = '',
  ) {
    await supabase.from('jc_ppt_events').insert({
      jc_ppt_id: jcPptId,
      actor_id: actorId,
      event_type: eventType,
      note,
    });
  }

  async function namesForIds(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map<string, string>();
    const { data } = await supabase.from('employees').select('id, full_name').in('id', unique);
    return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
  }

  async function loadEvents(jcPptIds: string[]) {
    if (jcPptIds.length === 0) return [];
    const { data, error } = await supabase
      .from('jc_ppt_events')
      .select('*')
      .in('jc_ppt_id', jcPptIds)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC audit events.', 500);
    return (data ?? []) as EventRow[];
  }

  async function signedPreview(storagePath: string, fileName: string) {
    const { data: signed, error: signError } = await supabase.storage
      .from(JC_PPT_BUCKET)
      .createSignedUrl(storagePath, 60 * 30);
    if (signError || !signed) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create download URL.', 500);
    }
    return { url: signed.signedUrl, fileName };
  }

  async function downloadBytes(storagePath: string): Promise<Uint8Array> {
    const { data, error } = await supabase.storage.from(JC_PPT_BUCKET).download(storagePath);
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to read JC PPT from storage.', 500);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async function consumeFile(
    row: JcRow,
    actor: RequestUser,
    mode: 'downloaded' | 'emailed' | 'deleted',
    emailRecipient: string | null,
    meta: RequestMeta,
  ) {
    if (!row.storage_path || row.status !== 'with_gm') {
      throw new AppError(
        API_ERROR_CODES.CONFLICT,
        'This JC PPT is not available for General Manager action.',
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
          subject: `JC PPT: ${fileName}`,
          text: `Attached is the JC PowerPoint "${fileName}" transferred from the HR Portal.`,
          html: `<p>Attached is the JC PowerPoint <strong>${fileName}</strong> transferred from the HR Portal.</p>`,
          attachments: [{ name: fileName, content: Buffer.from(bytes!).toString('base64') }],
        });
        if (!mail.sent) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            'Email delivery is not configured. File was not removed.',
            502,
          );
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to email the JC PPT. File was not removed.', 502);
      }
    }

    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('jc_ppts')
      .update({
        status: mode,
        storage_path: null,
        consumed_at: now,
        consumed_by: actor.employeeId,
        email_recipient: mode === 'emailed' ? emailRecipient : null,
      })
      .eq('id', row.id)
      .eq('status', 'with_gm')
      .select('*')
      .maybeSingle();
    if (error || !updated) {
      throw new AppError(API_ERROR_CODES.CONFLICT, 'JC PPT was already processed.', 409);
    }

    await supabase.storage.from(JC_PPT_BUCKET).remove([row.storage_path]);
    const note =
      mode === 'emailed'
        ? `Emailed to ${emailRecipient}.`
        : mode === 'downloaded'
          ? 'Downloaded locally; file removed from portal storage.'
          : 'Deleted from portal storage by General Manager.';
    await insertEvent(row.id, actor.employeeId, mode, note);

    await writeAuditLog(supabase, {
      actorId: actor.employeeId,
      action: mode === 'emailed' ? 'jc_ppt.email' : mode === 'downloaded' ? 'jc_ppt.download' : 'jc_ppt.delete',
      entityType: 'jc_ppt',
      entityId: row.id,
      newValues: { status: mode, emailRecipient },
      ...meta,
    });

    const employee = await loadStaffById(supabase, row.employee_id);
    const gm = await loadStaffById(supabase, actor.employeeId);
    const watchers = [
      ...(employee ? [employee] : []),
      ...(await listStaffByRole(supabase, ROLE_CODES.CSO)),
    ];
    const title =
      mode === 'emailed'
        ? 'JC PPT emailed by General Manager'
        : mode === 'downloaded'
          ? 'JC PPT downloaded by General Manager'
          : 'JC PPT deleted by General Manager';
    const message =
      mode === 'emailed'
        ? `${gm?.fullName ?? 'General Manager'} emailed ${fileName} to ${emailRecipient}. File removed from portal storage.`
        : mode === 'downloaded'
          ? `${gm?.fullName ?? 'General Manager'} downloaded ${fileName}. File removed from portal storage.`
          : `${gm?.fullName ?? 'General Manager'} deleted ${fileName} from portal storage.`;
    await notifyStaff(supabase, watchers, {
      type: 'work',
      title,
      message,
      referenceType: 'jc_ppt',
      referenceId: row.id,
      eyebrow: 'Team JC',
      paragraphs: [
        message,
        'The file has been removed from portal storage. Audit history remains available.',
      ],
      details: [
        { label: 'Employee', value: employee?.fullName ?? 'Employee' },
        { label: 'File', value: fileName },
        ...(mode === 'emailed' && emailRecipient ? [{ label: 'Recipient', value: emailRecipient }] : []),
      ],
      ctaLabel: 'View JC history',
      ctaHref: portalUrl('/work/jc'),
    });

    return {
      item: mapJc(updated as JcRow, { employeeName: employee?.fullName }),
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
    async getCsoBoard(actor: RequestUser) {
      assertCsoDesk(actor);
      const { data, error } = await supabase
        .from('jc_ppts')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .limit(200);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load Team JC.', 500);
      const rows = (data ?? []) as JcRow[];
      const events = await loadEvents(rows.map((row) => row.id));
      const nameById = await namesForIds([
        ...rows.map((r) => r.employee_id),
        ...rows.map((r) => r.transferred_by).filter(Boolean) as string[],
        ...rows.map((r) => r.consumed_by).filter(Boolean) as string[],
        ...events.map((e) => e.actor_id).filter(Boolean) as string[],
      ]);

      const pending = rows.filter((row) => row.status === 'uploaded');
      const withGm = rows.filter((row) => row.status === 'with_gm');
      const history = rows.filter(
        (row) => row.status === 'downloaded' || row.status === 'emailed' || row.status === 'deleted',
      );

      return {
        counts: {
          pending: pending.length,
          withGm: withGm.length,
          completed: history.length,
          total: rows.length,
        },
        pending: pending.map((row) =>
          mapJc(row, {
            employeeName: nameById.get(row.employee_id) ?? 'Employee',
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        withGm: withGm.map((row) =>
          mapJc(row, {
            employeeName: nameById.get(row.employee_id) ?? 'Employee',
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        history: history.map((row) =>
          mapJc(row, {
            employeeName: nameById.get(row.employee_id) ?? 'Employee',
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        events: events.map((event) => mapEvent(event, event.actor_id ? nameById.get(event.actor_id) ?? null : null)),
      };
    },

    async getGmBoard(actor: RequestUser) {
      assertGmDesk(actor);
      const { data, error } = await supabase
        .from('jc_ppts')
        .select('*')
        .in('status', ['with_gm', 'downloaded', 'emailed', 'deleted'])
        .order('uploaded_at', { ascending: false })
        .limit(200);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load Team JC.', 500);
      const rows = (data ?? []) as JcRow[];
      const events = await loadEvents(rows.map((row) => row.id));
      const nameById = await namesForIds([
        ...rows.map((r) => r.employee_id),
        ...rows.map((r) => r.transferred_by).filter(Boolean) as string[],
        ...rows.map((r) => r.consumed_by).filter(Boolean) as string[],
        ...events.map((e) => e.actor_id).filter(Boolean) as string[],
      ]);

      const inbox = rows.filter((row) => row.status === 'with_gm');
      const history = rows.filter(
        (row) => row.status === 'downloaded' || row.status === 'emailed' || row.status === 'deleted',
      );

      return {
        counts: {
          inbox: inbox.length,
          completed: history.length,
          total: rows.length,
        },
        inbox: inbox.map((row) =>
          mapJc(row, {
            employeeName: nameById.get(row.employee_id) ?? 'Employee',
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        history: history.map((row) =>
          mapJc(row, {
            employeeName: nameById.get(row.employee_id) ?? 'Employee',
            transferredByName: row.transferred_by ? nameById.get(row.transferred_by) ?? null : null,
            consumedByName: row.consumed_by ? nameById.get(row.consumed_by) ?? null : null,
          }),
        ),
        events: events.map((event) => mapEvent(event, event.actor_id ? nameById.get(event.actor_id) ?? null : null)),
      };
    },

    async transferToGm(actor: RequestUser, id: string, meta: RequestMeta) {
      assertCsoDesk(actor);
      const { data, error } = await supabase.from('jc_ppts').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      const row = data as JcRow;
      if (row.status !== 'uploaded' || !row.storage_path) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Only pending JC PPTs can be transferred to General Manager.', 409);
      }

      const now = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from('jc_ppts')
        .update({
          status: 'with_gm',
          transferred_at: now,
          transferred_by: actor.employeeId,
        })
        .eq('id', id)
        .eq('status', 'uploaded')
        .select('*')
        .maybeSingle();
      if (updateError || !updated) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'JC PPT was already transferred.', 409);
      }

      await insertEvent(id, actor.employeeId, 'transferred_to_gm', 'CSO transferred JC PPT to General Manager.');
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'jc_ppt.transfer_to_gm',
        entityType: 'jc_ppt',
        entityId: id,
        newValues: { status: 'with_gm' },
        ...meta,
      });

      const employee = await loadStaffById(supabase, row.employee_id);
      const cso = await loadStaffById(supabase, actor.employeeId);
      const gmStaff = await listStaffByRole(supabase, ROLE_CODES.GENERAL_MANAGER);
      await notifyStaff(supabase, [...gmStaff, ...(employee ? [employee] : [])], {
        type: 'work',
        title: 'JC PPT transferred to General Manager',
        message: `${cso?.fullName ?? 'CSO'} transferred ${row.system_file_name} to General Manager.`,
        referenceType: 'jc_ppt',
        referenceId: id,
        eyebrow: 'Team JC',
        paragraphs: [
          `${cso?.fullName ?? 'CSO'} transferred the JC PPT from ${employee?.fullName ?? 'an employee'} to General Manager.`,
          'General Manager can download it locally or email it to a recipient. After that, the file is removed from portal storage.',
        ],
        details: [
          { label: 'Employee', value: employee?.fullName ?? 'Employee' },
          { label: 'File', value: row.system_file_name },
          { label: 'Transferred by', value: cso?.fullName ?? 'CSO' },
        ],
        ctaLabel: 'Open Team JC',
        ctaHref: portalUrl('/gm/jc'),
      });

      return {
        item: mapJc(updated as JcRow, {
          employeeName: employee?.fullName,
          transferredByName: cso?.fullName ?? null,
        }),
        recipients: gmStaff.length,
      };
    },

    async getPreviewDownload(actor: RequestUser, id: string) {
      if (isCsoDomainOwner(actor)) {
        assertCsoDesk(actor);
      } else if (isGmDomainOwner(actor)) {
        assertGmDesk(actor);
      } else {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot download this JC PPT.', 403);
      }

      const { data, error } = await supabase.from('jc_ppts').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      const row = data as JcRow;

      if (isGmDomainOwner(actor) && row.status !== 'with_gm') {
        throw new AppError(
          API_ERROR_CODES.NOT_FOUND,
          'File is no longer available. Use audit history for the record.',
          404,
        );
      }
      if (isCsoDomainOwner(actor) && row.status !== 'uploaded' && row.status !== 'with_gm') {
        throw new AppError(
          API_ERROR_CODES.NOT_FOUND,
          'File is no longer available. Use audit history for the record.',
          404,
        );
      }
      if (!row.storage_path) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'File is no longer available.', 404);
      }

      // CSO preview does not consume. GM should use download/email endpoints that remove the file.
      if (isGmDomainOwner(actor) && !isCsoDomainOwner(actor)) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'General Manager must use Download or Email so the file is removed after delivery.',
          403,
        );
      }

      return signedPreview(row.storage_path, row.system_file_name);
    },

    async gmDownload(actor: RequestUser, id: string, meta: RequestMeta) {
      assertGmDesk(actor);
      const { data, error } = await supabase.from('jc_ppts').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      return consumeFile(data as JcRow, actor, 'downloaded', null, meta);
    },

    async gmEmail(actor: RequestUser, id: string, recipientEmail: string, meta: RequestMeta) {
      assertGmDesk(actor);
      const { data, error } = await supabase.from('jc_ppts').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      return consumeFile(data as JcRow, actor, 'emailed', recipientEmail.trim().toLowerCase(), meta);
    },

    async gmDelete(actor: RequestUser, id: string, meta: RequestMeta) {
      assertGmDesk(actor);
      const { data, error } = await supabase.from('jc_ppts').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'JC PPT not found.', 404);
      return consumeFile(data as JcRow, actor, 'deleted', null, meta);
    },

    async gmDeleteAll(actor: RequestUser, meta: RequestMeta) {
      assertGmDesk(actor);
      const { data, error } = await supabase
        .from('jc_ppts')
        .select('*')
        .eq('status', 'with_gm')
        .not('storage_path', 'is', null);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load Team JC inbox.', 500);
      const rows = (data ?? []) as JcRow[];
      let removed = 0;
      for (const row of rows) {
        await consumeFile(row, actor, 'deleted', null, meta);
        removed += 1;
      }
      return { removed };
    },
  };
}
