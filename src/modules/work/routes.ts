import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createWorkBoardService } from './admin-board';
import { createWorkAnalyticsService } from './analytics';
import { createDailyWorkService } from './daily';
import { createLeadDeskService } from './lead-desk';
import { createWorkOverviewService } from './overview';
import { createProjectUpdatesService } from './project-updates';
import { createWorkService } from './service';
import { createWorkSettingsService } from './settings';
import { createWeeklyUpdatesService } from './weekly-updates';
import { createWeeklyPptDeskService } from './weekly-ppt-desk';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const priorityBody = Type.Object({
  employeeId: Type.Optional(Type.String({ minLength: 1 })),
  type: Type.String({ minLength: 1 }),
  projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  regularSubtype: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  regularSubtypeLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  expectedOutcome: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.String()),
  level: Type.String({ minLength: 1 }),
});

const priorityPatch = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  expectedOutcome: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.String()),
  level: Type.Optional(Type.String()),
  regularSubtype: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  regularSubtypeLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(Type.String()),
  incompleteReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export async function registerWorkRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/work/days/:date',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW)],
      schema: { params: Type.Object({ date: Type.String({ minLength: 10, maxLength: 10 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { date } = request.params as { date: string };
      const query = request.query as { employeeId?: string };
      return ok(await createDailyWorkService(requireSupabase(app.supabase)).getDay(request.user, date, query.employeeId));
    },
  );

  app.put(
    '/api/v1/work/days/:date',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN)],
      schema: {
        params: Type.Object({ date: Type.String({ minLength: 10, maxLength: 10 }) }),
        body: Type.Object({
          planned: Type.Array(
            Type.Object({
              priorityId: Type.String({ minLength: 1 }),
              description: Type.String(),
            }),
          ),
          unplanned: Type.Optional(Type.Array(Type.Object({ description: Type.String() }))),
          blocker: Type.Optional(
            Type.Union([
              Type.Null(),
              Type.Object({
                category: Type.String(),
                description: Type.String(),
              }),
            ]),
          ),
          tomorrow: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { date } = request.params as { date: string };
      const body = request.body as {
        planned: { priorityId: string; description: string }[];
        unplanned?: { description: string }[];
        blocker?: { category: string; description: string } | null;
        tomorrow?: string;
      };
      return ok(await createDailyWorkService(requireSupabase(app.supabase)).submitDay(request.user, date, body));
    },
  );

  app.get(
    '/api/v1/work/history',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { month?: string; employeeId?: string };
      const month = query.month && /^\d{4}-\d{2}$/.test(query.month) ? query.month : new Date().toISOString().slice(0, 7);
      return ok(await createDailyWorkService(requireSupabase(app.supabase)).getHistory(request.user, month, query.employeeId));
    },
  );

  app.get(
    '/api/v1/work/overview',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { employeeId?: string };
      return ok(await createWorkOverviewService(requireSupabase(app.supabase)).getOverview(request.user, query.employeeId));
    },
  );

  app.get(
    '/api/v1/work/board',
    { preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as {
        date?: string;
        from?: string;
        to?: string;
        departmentId?: string;
        employeeId?: string;
        type?: string;
        category?: string;
        projectId?: string;
      };
      return ok(await createWorkBoardService(requireSupabase(app.supabase)).getBoard(request.user, query));
    },
  );

  app.get(
    '/api/v1/work/priorities/queue',
    { preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { date?: string };
      return ok(
        await createWorkBoardService(requireSupabase(app.supabase)).getPrioritiesQueue(request.user, query),
      );
    },
  );

  app.get(
    '/api/v1/work/priorities/approved',
    { preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { date?: string };
      return ok(
        await createWorkBoardService(requireSupabase(app.supabase)).getApprovedPriorities(request.user, query),
      );
    },
  );

  app.get(
    '/api/v1/work/analytics',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as {
        from?: string;
        to?: string;
        months?: string;
        departmentId?: string;
        employeeId?: string;
      };
      const months = query.months && /^\d+$/.test(query.months) ? Number(query.months) : undefined;
      return ok(
        await createWorkAnalyticsService(requireSupabase(app.supabase)).getAnalytics(request.user, {
          from: query.from,
          to: query.to,
          months,
          departmentId: query.departmentId,
          employeeId: query.employeeId,
        }),
      );
    },
  );

  app.get(
    '/api/v1/work/settings',
    { preHandler: [requirePermission(PERMISSIONS.WORK_SETTINGS)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createWorkSettingsService(requireSupabase(app.supabase)).getSettings(request.user));
    },
  );

  app.patch(
    '/api/v1/work/settings',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_SETTINGS)],
      schema: {
        body: Type.Object({
          reminderHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
          secondReminderHour: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 23 }), Type.Null()])),
          retentionDays: Type.Optional(Type.Integer()),
          archiveBeforeDelete: Type.Optional(Type.Boolean()),
          notifyBeforePurge: Type.Optional(Type.Boolean()),
          purgeNotifyDaysBefore: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
          legalHold: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as {
        reminderHour?: number;
        secondReminderHour?: number | null;
        retentionDays?: number;
        archiveBeforeDelete?: boolean;
        notifyBeforePurge?: boolean;
        purgeNotifyDaysBefore?: number;
        legalHold?: boolean;
      };
      return ok(
        await createWorkSettingsService(requireSupabase(app.supabase)).updateSettings(request.user, body, metaOf(request)),
      );
    },
  );

  app.post(
    '/api/v1/work/feedback',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_FEEDBACK)],
      schema: {
        body: Type.Object({
          employeeId: Type.String({ minLength: 1 }),
          type: Type.String({ minLength: 1 }),
          comment: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { employeeId: string; type: string; comment: string };
      return ok(await createWorkService(requireSupabase(app.supabase)).createFeedback(request.user, body, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/work/week',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { employeeId?: string; date?: string };
      return ok(await createWorkService(requireSupabase(app.supabase)).getWeek(request.user, query));
    },
  );

  app.get(
    '/api/v1/work/lead/projects',
    {
      preHandler: [
        requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW, PERMISSIONS.PROJECTS_MANAGE),
      ],
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createLeadDeskService(requireSupabase(app.supabase)).listLeadProjects(request.user));
    },
  );

  app.get(
    '/api/v1/work/lead/projects/:id',
    {
      preHandler: [
        requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW, PERMISSIONS.PROJECTS_MANAGE),
      ],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const query = request.query as { date?: string };
      return ok(
        await createLeadDeskService(requireSupabase(app.supabase)).getLeadProjectDesk(
          request.user,
          id,
          query.date,
        ),
      );
    },
  );

  app.get(
    '/api/v1/work/projects/:id/updates',
    {
      preHandler: [
        requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW, PERMISSIONS.PROJECTS_MANAGE),
      ],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createProjectUpdatesService(requireSupabase(app.supabase)).list(request.user, id));
    },
  );

  app.post(
    '/api/v1/work/projects/:id/updates',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          body: Type.String({ minLength: 1, maxLength: 2000 }),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { body: string };
      return ok(
        await createProjectUpdatesService(requireSupabase(app.supabase)).create(
          request.user,
          id,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/work/projects',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.PROJECTS_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createWorkService(requireSupabase(app.supabase)).listProjects(request.user));
    },
  );

  app.post(
    '/api/v1/work/projects',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          code: Type.String({ minLength: 1 }),
          leadEmployeeId: Type.String({ minLength: 1 }),
          employeeIds: Type.Optional(Type.Array(Type.String())),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as {
        name: string;
        code: string;
        leadEmployeeId: string;
        employeeIds?: string[];
      };
      return ok(await createWorkService(requireSupabase(app.supabase)).createProject(request.user, body, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/work/projects/:id/members',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE, PERMISSIONS.WORK_ASSIGN)],
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createWorkService(requireSupabase(app.supabase)).getProjectMembers(request.user, id));
    },
  );

  app.put(
    '/api/v1/work/projects/:id/members',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          employeeIds: Type.Array(Type.String()),
          leadEmployeeId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { employeeIds: string[]; leadEmployeeId: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).setProjectMembers(
          request.user,
          id,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/work/projects/:id/status',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { status: 'active' | 'inactive' };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).setProjectStatus(
          request.user,
          id,
          body.status,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/projects/:id/members',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Object({ employeeId: Type.String({ minLength: 1 }) }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const { employeeId } = request.body as { employeeId: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).addProjectMember(request.user, id, employeeId, metaOf(request)),
      );
    },
  );

  app.get(
    '/api/v1/work/employees/:employeeId/projects',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.PROJECTS_MANAGE, PERMISSIONS.WORK_ASSIGN)],
      schema: { params: Type.Object({ employeeId: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { employeeId } = request.params as { employeeId: string };
      return ok(await createWorkService(requireSupabase(app.supabase)).listEmployeeProjects(request.user, employeeId));
    },
  );

  app.put(
    '/api/v1/work/employees/:employeeId/projects',
    {
      preHandler: [requirePermission(PERMISSIONS.PROJECTS_MANAGE)],
      schema: {
        params: Type.Object({ employeeId: Type.String({ minLength: 1 }) }),
        body: Type.Object({ projectIds: Type.Array(Type.String()) }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { employeeId } = request.params as { employeeId: string };
      const { projectIds } = request.body as { projectIds: string[] };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).setEmployeeProjects(
          request.user,
          employeeId,
          projectIds,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_ASSIGN)], schema: { body: priorityBody } },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as {
        employeeId?: string;
        type: string;
        projectId?: string | null;
        regularSubtype?: string | null;
        regularSubtypeLabel?: string | null;
        title: string;
        description?: string;
        expectedOutcome?: string;
        successCriteria?: string;
        level: string;
      };
      return ok(await createWorkService(requireSupabase(app.supabase)).createPriority(request.user, body, metaOf(request)));
    },
  );

  app.patch(
    '/api/v1/work/priorities/:id',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_ASSIGN)], schema: { body: priorityPatch } },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as {
        title?: string;
        description?: string;
        expectedOutcome?: string;
        successCriteria?: string;
        level?: string;
        status?: string;
        incompleteReason?: string | null;
      };
      return ok(await createWorkService(requireSupabase(app.supabase)).updatePriority(request.user, id, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/work/priorities/:id/submit',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN)],
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).submitPriorityForApproval(
          request.user,
          id,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities/submit-all',
    { preHandler: [requirePermission(PERMISSIONS.WORK_OWN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(
        await createWorkService(requireSupabase(app.supabase)).submitAllPendingPriorities(
          request.user,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities/approve-all',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)],
      schema: {
        body: Type.Object({
          employeeId: Type.String({ minLength: 1 }),
          date: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { employeeId: string; date?: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).approveAllSubmittedPriorities(
          request.user,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities/:id/approve',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)],
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).approvePriority(request.user, id, metaOf(request)),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities/:id/request-resubmit',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Object({ comment: Type.String({ minLength: 1 }) }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const { comment } = request.body as { comment: string };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).requestPriorityResubmit(
          request.user,
          id,
          comment,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/priorities/:id/carry-forward',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_ASSIGN)],
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        body: Type.Optional(Type.Object({ incompleteReason: Type.Optional(Type.Union([Type.String(), Type.Null()])) })),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { incompleteReason?: string | null };
      return ok(
        await createWorkService(requireSupabase(app.supabase)).carryForward(
          request.user,
          id,
          body.incompleteReason ?? null,
          metaOf(request),
        ),
      );
    },
  );

  app.get('/api/v1/work/weekly-updates', { preHandler: [requirePermission(PERMISSIONS.WORK_OWN)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createWeeklyUpdatesService(requireSupabase(app.supabase)).getBoard(request.user));
  });

  app.get(
    '/api/v1/work/weekly-updates/admin',
    { preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { weekStart?: string };
      return ok(
        await createWeeklyPptDeskService(requireSupabase(app.supabase)).getAdminBoard(
          request.user,
          query.weekStart,
        ),
      );
    },
  );

  app.get(
    '/api/v1/work/weekly-updates/shares',
    { preHandler: [requirePermission(PERMISSIONS.WORK_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createWeeklyPptDeskService(requireSupabase(app.supabase)).listGmShares(request.user));
    },
  );

  app.post(
    '/api/v1/work/weekly-updates/share-to-gm',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_VIEW, PERMISSIONS.WORK_ASSIGN)],
      schema: {
        body: Type.Optional(Type.Object({ weekStart: Type.Optional(Type.String({ minLength: 10, maxLength: 10 })) })),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = (request.body ?? {}) as { weekStart?: string };
      return ok(
        await createWeeklyPptDeskService(requireSupabase(app.supabase)).shareWeekToGm(
          request.user,
          body.weekStart,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/work/weekly-updates/upload',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN)],
      schema: {
        body: Type.Object({
          fileName: Type.String({ minLength: 1 }),
          contentType: Type.String(),
          sizeBytes: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { fileName: string; contentType: string; sizeBytes: number };
      return ok(
        await createWeeklyUpdatesService(requireSupabase(app.supabase)).createUploadSession(
          request.user,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/work/weekly-updates/:id/download',
    {
      preHandler: [requirePermission(PERMISSIONS.WORK_OWN, PERMISSIONS.WORK_VIEW)],
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const query = request.query as { shareId?: string };
      return ok(
        await createWeeklyPptDeskService(requireSupabase(app.supabase)).getDownloadUrl(
          request.user,
          id,
          query.shareId,
        ),
      );
    },
  );
}
