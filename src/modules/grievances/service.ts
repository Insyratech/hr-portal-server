import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { loadApproverStaff } from '../leave/support';
import { portalUrl, sendPortalMail } from '../notifications/mail';
import {
  assertTransition,
  type CommentVisibility,
  type GrievanceCategory,
  type GrievanceStatus,
} from './transitions';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

const BUCKET = 'grievance-attachments';

const GRIEVANCE_LIST_SELECT =
  'id, employee_id, category, subject, description, status, resolution, resolved_at, created_at, updated_at, employees!employee_id (full_name)';

function first<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function canManage(user: RequestUser): boolean {
  return user.permissions.includes(PERMISSIONS.GRIEVANCES_MANAGE);
}

function canSkip(user: RequestUser): boolean {
  return user.permissions.includes(PERMISSIONS.SYSTEM_MANAGE);
}

async function notifyUser(
  supabase: SupabaseClient,
  input: { userId: string; title: string; message: string; referenceId: string },
): Promise<void> {
  await supabase.from('notifications').insert({
    user_id: input.userId,
    type: 'grievance',
    title: input.title,
    message: input.message,
    reference_type: 'grievance',
    reference_id: input.referenceId,
  });
}

async function notifyManagers(
  supabase: SupabaseClient,
  input: { title: string; message: string; referenceId: string },
): Promise<void> {
  const staff = await loadApproverStaff(supabase);
  for (const person of staff) {
    await notifyUser(supabase, { userId: person.userId, ...input });
    const reviewPath =
      person.role === 'SUPER_ADMIN'
        ? `/super-admin/grievances?id=${input.referenceId}`
        : `/admin/grievances?id=${input.referenceId}`;
    await sendPortalMail({
      to: [person.email],
      subject: input.title,
      eyebrow: 'Grievance',
      title: input.title,
      greeting: `Hi ${person.name},`,
      paragraphs: [input.message, 'Open the case to reply, assign an investigator, or update the status.'],
      cta: { label: 'Review grievance', href: portalUrl(reviewPath) },
    });
  }
}

export function createGrievanceService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser, status?: string) {
      let query = supabase
        .from('grievances')
        .select(
          GRIEVANCE_LIST_SELECT,
        )
        .order('created_at', { ascending: false });

      if (!canManage(actor)) {
        if (!actor.permissions.includes(PERMISSIONS.GRIEVANCE_VIEW_OWN)) {
          throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view grievances.', 403);
        }
        query = query.eq('employee_id', actor.employeeId);
      }
      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          `Failed to load grievances. ${error.message}`,
          500,
        );
      }
      return (data ?? []).map(mapGrievanceSummary);
    },

    async get(actor: RequestUser, id: string) {
      const { data, error } = await supabase
        .from('grievances')
        .select(
          GRIEVANCE_LIST_SELECT,
        )
        .eq('id', id)
        .maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load grievance.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Grievance not found.', 404);

      const manage = canManage(actor);
      if (!manage && data.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this grievance.', 403);
      }

      let commentsQuery = supabase
        .from('grievance_comments')
        .select('id, author_id, body, visibility, created_at, employees!author_id (full_name)')
        .eq('grievance_id', id)
        .order('created_at', { ascending: true });
      if (!manage) {
        commentsQuery = commentsQuery.eq('visibility', 'EMPLOYEE');
      }

      const [{ data: comments }, { data: attachments }, { data: assignments }] = await Promise.all([
        commentsQuery,
        supabase
          .from('grievance_attachments')
          .select('id, file_name, content_type, size_bytes, storage_path, created_at, uploaded_by')
          .eq('grievance_id', id)
          .order('created_at', { ascending: true }),
        supabase
          .from('grievance_assignments')
          .select('id, assignee_id, assigned_by, active, created_at, assignee:employees!assignee_id (full_name)')
          .eq('grievance_id', id)
          .eq('active', true)
          .order('created_at', { ascending: false }),
      ]);

      return {
        ...mapGrievanceSummary(data),
        comments: (comments ?? []).map((row) => ({
          id: row.id as string,
          authorId: row.author_id as string,
          authorName: first(row.employees as { full_name: string } | { full_name: string }[] | null)?.full_name ?? null,
          body: row.body as string,
          visibility: row.visibility as CommentVisibility,
          createdAt: row.created_at as string,
        })),
        attachments: (attachments ?? []).map((row) => ({
          id: row.id as string,
          fileName: row.file_name as string,
          contentType: row.content_type as string,
          sizeBytes: row.size_bytes as number,
          createdAt: row.created_at as string,
        })),
        assignments: (assignments ?? []).map((row) => ({
          id: row.id as string,
          assigneeId: row.assignee_id as string,
          assigneeName:
            first(row.assignee as { full_name: string } | { full_name: string }[] | null)?.full_name ?? null,
          assignedBy: row.assigned_by as string,
          active: Boolean(row.active),
          createdAt: row.created_at as string,
        })),
      };
    },

    async create(
      actor: RequestUser,
      input: { category: GrievanceCategory; subject: string; description: string },
      meta: RequestMeta,
    ) {
      if (!actor.permissions.includes(PERMISSIONS.GRIEVANCE_CREATE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create a grievance.', 403);
      }
      const { data, error } = await supabase
        .from('grievances')
        .insert({
          employee_id: actor.employeeId,
          category: input.category,
          subject: input.subject.trim(),
          description: input.description.trim(),
          status: 'OPEN',
        })
        .select(
          GRIEVANCE_LIST_SELECT,
        )
        .single();
      if (error || !data) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          `Failed to create grievance.${error?.message ? ` ${error.message}` : ''}`,
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.create',
        entityType: 'grievance',
        entityId: data.id as string,
        newValues: mapGrievanceSummary(data),
        ...meta,
      });
      await notifyManagers(supabase, {
        title: 'New grievance',
        message: `${input.subject.trim()} was filed.`,
        referenceId: data.id as string,
      });
      return mapGrievanceSummary(data);
    },

    async addComment(
      actor: RequestUser,
      id: string,
      input: { body: string; visibility?: CommentVisibility },
      meta: RequestMeta,
    ) {
      const detail = await this.get(actor, id);
      const manage = canManage(actor);
      const visibility: CommentVisibility = manage ? (input.visibility ?? 'INTERNAL') : 'EMPLOYEE';
      if (!manage && visibility === 'INTERNAL') {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot post internal notes.', 403);
      }
      if (!manage && detail.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot comment on this grievance.', 403);
      }

      const { data, error } = await supabase
        .from('grievance_comments')
        .insert({
          grievance_id: id,
          author_id: actor.employeeId,
          body: input.body.trim(),
          visibility,
        })
        .select('id, author_id, body, visibility, created_at')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to add comment.', 500);

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.comment',
        entityType: 'grievance',
        entityId: id,
        newValues: { commentId: data.id, visibility },
        ...meta,
      });

      if (visibility === 'EMPLOYEE' && manage) {
        const { data: employee } = await supabase
          .from('employees')
          .select('user_id')
          .eq('id', detail.employeeId)
          .maybeSingle();
        if (employee?.user_id) {
          await notifyUser(supabase, {
            userId: employee.user_id as string,
            title: 'Grievance update',
            message: 'There is a new message on your concern.',
            referenceId: id,
          });
        }
      }

      if (!manage) {
        await notifyManagers(supabase, {
          title: 'Grievance reply',
          message: `${actor.fullName} added a message on “${detail.subject}”.`,
          referenceId: id,
        });
      }

      return this.get(actor, id);
    },

    async assign(actor: RequestUser, id: string, assigneeId: string, meta: RequestMeta) {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot assign grievances.', 403);
      }
      const existing = await this.get(actor, id);

      await supabase.from('grievance_assignments').update({ active: false }).eq('grievance_id', id).eq('active', true);

      const { data, error } = await supabase
        .from('grievance_assignments')
        .insert({
          grievance_id: id,
          assignee_id: assigneeId,
          assigned_by: actor.employeeId,
          active: true,
        })
        .select('id')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign investigator.', 500);

      if (existing.status === 'OPEN') {
        await supabase.from('grievances').update({ status: 'UNDER_REVIEW' }).eq('id', id);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.assign',
        entityType: 'grievance',
        entityId: id,
        newValues: { assigneeId, assignmentId: data.id },
        ...meta,
      });

      const { data: assignee } = await supabase.from('employees').select('user_id').eq('id', assigneeId).maybeSingle();
      if (assignee?.user_id) {
        await notifyUser(supabase, {
          userId: assignee.user_id as string,
          title: 'Grievance assigned',
          message: 'You were assigned as investigator.',
          referenceId: id,
        });
      }

      return this.get(actor, id);
    },

    async changeStatus(actor: RequestUser, id: string, to: string, meta: RequestMeta) {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot change grievance status.', 403);
      }
      const existing = await this.get(actor, id);
      try {
        assertTransition({ from: existing.status, to, allowSkip: canSkip(actor) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '';
        if (message === 'INVALID_STATUS_TRANSITION') {
          throw new AppError(
            API_ERROR_CODES.INVALID_STATUS_TRANSITION,
            `Cannot move from ${existing.status} to ${to}.`,
            400,
          );
        }
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid grievance status.', 400);
      }

      const { error } = await supabase.from('grievances').update({ status: to }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update status.', 500);

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.status',
        entityType: 'grievance',
        entityId: id,
        oldValues: { status: existing.status },
        newValues: { status: to },
        ...meta,
      });

      const { data: employee } = await supabase
        .from('employees')
        .select('user_id')
        .eq('id', existing.employeeId)
        .maybeSingle();
      if (employee?.user_id) {
        await notifyUser(supabase, {
          userId: employee.user_id as string,
          title: 'Grievance status updated',
          message: `Your concern is now ${to.replaceAll('_', ' ').toLowerCase()}.`,
          referenceId: id,
        });
      }

      return this.get(actor, id);
    },

    async resolve(actor: RequestUser, id: string, resolution: string, meta: RequestMeta) {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot resolve grievances.', 403);
      }
      const existing = await this.get(actor, id);
      if (existing.status === 'RESOLVED' || existing.status === 'CLOSED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Grievance is already resolved or closed.', 400);
      }
      try {
        assertTransition({ from: existing.status, to: 'RESOLVED', allowSkip: canSkip(actor) });
      } catch {
        throw new AppError(
          API_ERROR_CODES.INVALID_STATUS_TRANSITION,
          'Resolve is only allowed from INVESTIGATING (Super Admin may skip forward).',
          400,
        );
      }

      const { error } = await supabase
        .from('grievances')
        .update({
          status: 'RESOLVED',
          resolution: resolution.trim(),
          resolved_at: new Date().toISOString(),
          resolved_by: actor.employeeId,
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to resolve grievance.', 500);

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.resolve',
        entityType: 'grievance',
        entityId: id,
        newValues: { resolution: resolution.trim(), status: 'RESOLVED' },
        ...meta,
      });

      const { data: employee } = await supabase
        .from('employees')
        .select('user_id')
        .eq('id', existing.employeeId)
        .maybeSingle();
      if (employee?.user_id) {
        await notifyUser(supabase, {
          userId: employee.user_id as string,
          title: 'Grievance resolved',
          message: 'Your concern has a resolution.',
          referenceId: id,
        });
      }

      return this.get(actor, id);
    },

    async createAttachmentUpload(
      actor: RequestUser,
      id: string,
      input: { fileName: string; contentType: string; sizeBytes: number },
      meta: RequestMeta,
    ) {
      const detail = await this.get(actor, id);
      const manage = canManage(actor);
      if (!manage && detail.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot attach files to this grievance.', 403);
      }
      if (input.sizeBytes > 10 * 1024 * 1024) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Attachment must be 10MB or smaller.', 400);
      }

      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${id}/${crypto.randomUUID()}-${safeName}`;

      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          'Failed to create upload URL. Ensure the grievance-attachments bucket exists.',
          500,
        );
      }

      const { data, error } = await supabase
        .from('grievance_attachments')
        .insert({
          grievance_id: id,
          uploaded_by: actor.employeeId,
          file_name: input.fileName,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          storage_path: storagePath,
        })
        .select('id, file_name, content_type, size_bytes, created_at')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to register attachment.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'grievance.attachment',
        entityType: 'grievance',
        entityId: id,
        newValues: { attachmentId: data.id, fileName: input.fileName },
        ...meta,
      });

      return {
        attachment: {
          id: data.id as string,
          fileName: data.file_name as string,
          contentType: data.content_type as string,
          sizeBytes: data.size_bytes as number,
          createdAt: data.created_at as string,
        },
        uploadUrl: signed.signedUrl,
        token: signed.token,
        path: storagePath,
      };
    },

    async getAttachmentDownloadUrl(actor: RequestUser, grievanceId: string, attachmentId: string) {
      await this.get(actor, grievanceId);
      const { data, error } = await supabase
        .from('grievance_attachments')
        .select('storage_path')
        .eq('id', attachmentId)
        .eq('grievance_id', grievanceId)
        .maybeSingle();
      if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Attachment not found.', 404);

      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(data.storage_path as string, 60 * 10);
      if (signError || !signed) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create download URL.', 500);
      }
      return { url: signed.signedUrl };
    },
  };
}

function mapGrievanceSummary(row: Record<string, unknown>) {
  const employee = row.employees as { full_name: string } | { full_name: string }[] | null | undefined;
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    employeeName: (Array.isArray(employee) ? employee[0]?.full_name : employee?.full_name) ?? null,
    category: row.category as GrievanceCategory,
    subject: row.subject as string,
    description: row.description as string,
    status: row.status as GrievanceStatus,
    resolution: (row.resolution as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
