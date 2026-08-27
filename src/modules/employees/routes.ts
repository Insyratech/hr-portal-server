import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { listAuditLogs } from '../audit/write-audit-log';
import { createEmployeeRepository } from './repository';
import { employeeBody, employeePatchBody, employeeRolesBody, employeeCompanyBody, compensationBody, paymentBody, workWeekBody, workEmailOtpBody, workEmailOtpVerifyBody } from './schemas';
import { createEmployeeService } from './service';
import { createWorkWeekService } from '../attendance/work-week';
import type { CompensationInput, CreateEmployeeInput, EmployeeStatus, PaymentInput, UpdateEmployeeInput, UpdateEmployeeRolesInput } from './types';

function requestMeta(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function registerEmployeeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/employees',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const query = request.query as { q?: string; status?: EmployeeStatus };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      const items = await service.list(request.user, {
        query: query.q,
        status: query.status,
      });

      return ok(items, { total: items.length });
    },
  );

  app.post(
    '/api/v1/employees/email-otp',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: workEmailOtpBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.sendWorkEmailOtp(request.user, (request.body as { email: string }).email));
    },
  );

  app.post(
    '/api/v1/employees/email-otp/verify',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: workEmailOtpVerifyBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      const body = request.body as { email: string; code: string };
      return ok(await service.verifyWorkEmailOtp(request.user, body.email, body.code));
    },
  );

  app.post(
    '/api/v1/employees',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: employeeBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      const created = await service.create(
        request.user,
        request.body as CreateEmployeeInput,
        requestMeta(request),
      );
      return ok(created);
    },
  );

  app.get(
    '/api/v1/employees/:id',
    { preHandler: [requireAuth()] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.getById(request.user, id));
    },
  );

  app.patch(
    '/api/v1/employees/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: employeePatchBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(
        await service.update(
          request.user,
          id,
          request.body as UpdateEmployeeInput,
          requestMeta(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/employees/:id/roles',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: employeeRolesBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(
        await service.updateRoles(
          request.user,
          id,
          request.body as UpdateEmployeeRolesInput,
          requestMeta(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/employees/:id/company',
    {
      preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)],
      schema: { body: employeeCompanyBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const body = request.body as { companyId: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.updateCompany(request.user, id, body.companyId, requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/employees/:id/deactivate',
    { preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.setStatus(request.user, id, 'inactive', requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/employees/:id/activate',
    { preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.setStatus(request.user, id, 'active', requestMeta(request)));
    },
  );

  app.delete(
    '/api/v1/employees/:id',
    { preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      await service.remove(request.user, id, requestMeta(request));
      return ok({ deleted: true });
    },
  );

  app.get(
    '/api/v1/employees/:id/audit',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE, PERMISSIONS.AUDIT_VIEW)] },
    async (request) => {
      if (!app.supabase) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      return ok(await listAuditLogs(app.supabase, { entityId: id, limit: 50 }));
    },
  );

  app.get(
    '/api/v1/employees/:id/payroll',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.PAYROLL_VIEW,
          PERMISSIONS.PAYROLL_MANAGE,
          PERMISSIONS.USERS_VIEW,
          PERMISSIONS.USERS_MANAGE,
        ),
      ],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.getPayroll(request.user, id));
    },
  );

  app.put(
    '/api/v1/employees/:id/compensation',
    { preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)], schema: { body: compensationBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(
        await service.saveCompensation(
          request.user,
          id,
          request.body as CompensationInput,
          requestMeta(request),
        ),
      );
    },
  );

  app.put(
    '/api/v1/employees/:id/payment',
    { preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)], schema: { body: paymentBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(
        await service.savePayment(request.user, id, request.body as PaymentInput, requestMeta(request)),
      );
    },
  );

  app.get(
    '/api/v1/employees/:id/work-week',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createWorkWeekService(app.supabase).listForEmployee(request.user, id));
    },
  );

  app.put(
    '/api/v1/employees/:id/work-week',
    {
      preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)],
      schema: { body: workWeekBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = request.body as { pattern: string; effectiveFrom: string };
      return ok(await createWorkWeekService(app.supabase).save(request.user, id, body, requestMeta(request)));
    },
  );
}
