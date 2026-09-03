import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl } from '../notifications/mail';
import { listStaffByRole, notifyStaff } from '../notifications/notify-staff';

const MAX_BODY_LENGTH = 2000;

export const PROJECT_UPDATE_TOPICS = ['PROGRESS', 'RISK', 'BLOCKER', 'NEXT_STEPS', 'OTHER'] as const;
export type ProjectUpdateTopic = (typeof PROJECT_UPDATE_TOPICS)[number];

export type ProjectStatusUpdate = {
  id: string;
  projectId: string;
  authorId: string;
  authorName: string;
  body: string;
  topic: ProjectUpdateTopic | null;
  createdAt: string;
};

function normalizeTopic(value: string | null | undefined): ProjectUpdateTopic | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return (PROJECT_UPDATE_TOPICS as readonly string[]).includes(upper)
    ? (upper as ProjectUpdateTopic)
    : null;
}

function canStaffReadUpdates(actor: RequestUser): boolean {
  return (
    actor.permissions.includes(PERMISSIONS.PROJECTS_MANAGE) ||
    actor.roles.includes(ROLE_CODES.SUPER_ADMIN)
  );
}

async function loadProjectRow(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, code, status, lead_employee_id')
    .eq('id', projectId)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
  }
  return data;
}

function assertCanReadUpdates(
  actor: RequestUser,
  project: { lead_employee_id: string | null },
): void {
  const isLead = (project.lead_employee_id as string | null) === actor.employeeId;
  if (!isLead && !canStaffReadUpdates(actor)) {
    throw new AppError(
      API_ERROR_CODES.FORBIDDEN,
      'Only the current project lead or CSO can view these updates.',
      403,
    );
  }
}

export async function listProjectStatusUpdates(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectStatusUpdate[]> {
  const { data, error } = await supabase
    .from('project_status_updates')
    .select('id, project_id, author_id, body, topic, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) {
    // Older DBs may lack topic until migration 050 runs.
    if (/topic/i.test(error.message ?? '')) {
      const legacy = await supabase
        .from('project_status_updates')
        .select('id, project_id, author_id, body, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (legacy.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project status updates.', 500);
      }
      const rows = legacy.data ?? [];
      if (rows.length === 0) return [];
      const authorIds = [...new Set(rows.map((row) => row.author_id as string))];
      const { data: employees } = await supabase.from('employees').select('id, full_name').in('id', authorIds);
      const names = new Map((employees ?? []).map((row) => [row.id as string, row.full_name as string]));
      return rows.map((row) => ({
        id: row.id as string,
        projectId: row.project_id as string,
        authorId: row.author_id as string,
        authorName: names.get(row.author_id as string) ?? 'Lead',
        body: row.body as string,
        topic: null,
        createdAt: row.created_at as string,
      }));
    }
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project status updates.', 500);
  }
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((row) => row.author_id as string))];
  const { data: employees } = await supabase.from('employees').select('id, full_name').in('id', authorIds);
  const names = new Map((employees ?? []).map((row) => [row.id as string, row.full_name as string]));

  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    authorId: row.author_id as string,
    authorName: names.get(row.author_id as string) ?? 'Lead',
    body: row.body as string,
    topic: normalizeTopic((row as { topic?: string | null }).topic),
    createdAt: row.created_at as string,
  }));
}

async function notifyCsoOfProjectUpdate(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    projectName: string;
    projectCode: string;
    leadName: string;
    body: string;
  },
): Promise<void> {
  const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
  if (csoStaff.length === 0) return;

  const preview = input.body.length > 240 ? `${input.body.slice(0, 237)}…` : input.body;
  await notifyStaff(supabase, csoStaff, {
    type: 'work',
    title: 'Project status update',
    message: `${input.leadName} posted an update on ${input.projectName} (${input.projectCode}).`,
    referenceType: 'project',
    referenceId: input.projectId,
    eyebrow: 'Projects',
    paragraphs: [
      `${input.leadName} shared a status update on ${input.projectName}.`,
      preview,
    ],
    details: [
      { label: 'Project', value: input.projectName },
      { label: 'Code', value: input.projectCode },
      { label: 'Lead', value: input.leadName },
    ],
    ctaLabel: 'View updates',
    ctaHref: portalUrl(`/cso/work/projects?updatesProjectId=${encodeURIComponent(input.projectId)}`),
  });
}

export function createProjectUpdatesService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser, projectId: string) {
      const project = await loadProjectRow(supabase, projectId);
      assertCanReadUpdates(actor, project);
      return listProjectStatusUpdates(supabase, projectId);
    },

    async create(
      actor: RequestUser,
      projectId: string,
      input: { body: string; topic?: string | null },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const project = await loadProjectRow(supabase, projectId);
      if ((project.status as string) !== 'active') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'This project is inactive. Reactivate it before posting updates.',
          400,
        );
      }
      if ((project.lead_employee_id as string | null) !== actor.employeeId) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Only the current project lead can post a status update.',
          403,
        );
      }

      const body = input.body.trim();
      if (!body) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Write a short status update.', 400);
      }
      if (body.length > MAX_BODY_LENGTH) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Keep the update under ${MAX_BODY_LENGTH} characters.`,
          400,
        );
      }
      const topic = normalizeTopic(input.topic);
      if (input.topic && !topic) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a valid update topic.', 400);
      }

      const insertPayload: Record<string, unknown> = {
        project_id: projectId,
        author_id: actor.employeeId,
        body,
      };
      if (topic) insertPayload.topic = topic;

      const { data, error } = await supabase
        .from('project_status_updates')
        .insert(insertPayload)
        .select('id, project_id, author_id, body, topic, created_at')
        .single();

      let saved = data;
      if (error && /topic/i.test(error.message ?? '')) {
        const legacy = await supabase
          .from('project_status_updates')
          .insert({
            project_id: projectId,
            author_id: actor.employeeId,
            body,
          })
          .select('id, project_id, author_id, body, created_at')
          .single();
        if (legacy.error || !legacy.data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save the status update.', 500);
        }
        saved = { ...legacy.data, topic: null };
      } else if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save the status update.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project.status_update',
        entityType: 'project',
        entityId: projectId,
        newValues: { updateId: saved!.id, bodyLength: body.length, topic },
        ...meta,
      });

      await notifyCsoOfProjectUpdate(supabase, {
        projectId,
        projectName: project.name as string,
        projectCode: project.code as string,
        leadName: actor.fullName || 'Project lead',
        body,
      });

      return {
        id: saved!.id as string,
        projectId: saved!.project_id as string,
        authorId: saved!.author_id as string,
        authorName: actor.fullName || 'Lead',
        body: saved!.body as string,
        topic: normalizeTopic((saved as { topic?: string | null }).topic) ?? topic,
        createdAt: saved!.created_at as string,
      } satisfies ProjectStatusUpdate;
    },
  };
}
