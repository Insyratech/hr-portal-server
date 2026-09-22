import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { writeAuditLog } from '../audit/write-audit-log';
import { sendPortalMail } from '../notifications/mail';
import { listStaffByRole } from '../notifications/notify-staff';
import { requireSupabase } from '../leave/support';

const CONTACT_ROLES = [
  ROLE_CODES.HR_MANAGER,
  ROLE_CODES.CSO,
  ROLE_CODES.GENERAL_MANAGER,
  ROLE_CODES.FINANCE_MANAGER,
  ROLE_CODES.INVENTORY_MANAGER,
  ROLE_CODES.SUPER_ADMIN,
] as const;

type ContactRole = (typeof CONTACT_ROLES)[number];

const ROLE_LABELS: Record<ContactRole, string> = {
  HR_MANAGER: 'HR Manager',
  CSO: 'CSO',
  GENERAL_MANAGER: 'General Manager',
  FINANCE_MANAGER: 'Finance Manager',
  INVENTORY_MANAGER: 'Inventory Manager',
  SUPER_ADMIN: 'Super Admin',
};

function isContactRole(value: string): value is ContactRole {
  return (CONTACT_ROLES as readonly string[]).includes(value);
}

/** Roles the actor may message from the FAQ chatbot (never themselves-only empty). */
function allowedContactRoles(actorRoles: string[]): ContactRole[] {
  const targets: ContactRole[] = [
    ROLE_CODES.HR_MANAGER,
    ROLE_CODES.CSO,
    ROLE_CODES.GENERAL_MANAGER,
    ROLE_CODES.FINANCE_MANAGER,
    ROLE_CODES.INVENTORY_MANAGER,
  ];
  if (actorRoles.includes(ROLE_CODES.SUPER_ADMIN) || actorRoles.includes(ROLE_CODES.GENERAL_MANAGER)) {
    targets.push(ROLE_CODES.SUPER_ADMIN);
  }
  return targets;
}

const contactBody = Type.Object({
  roleCode: Type.String({ minLength: 1 }),
  subject: Type.String({ minLength: 3, maxLength: 200 }),
  message: Type.String({ minLength: 10, maxLength: 4000 }),
});

export async function registerFaqRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/faq/contact-targets', { preHandler: [requireAuth()] }, async (request) => {
    if (!request.user) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    }
    const supabase = requireSupabase(app.supabase);
    const roles = allowedContactRoles(request.user.roles);
    const targets = await Promise.all(
      roles.map(async (roleCode) => {
        const staff = await listStaffByRole(supabase, roleCode);
        return {
          roleCode,
          label: ROLE_LABELS[roleCode],
          available: staff.some((person) => person.email.includes('@')),
          recipientCount: staff.filter((person) => person.email.includes('@')).length,
        };
      }),
    );
    return ok(targets);
  });

  app.post(
    '/api/v1/faq/contact',
    { preHandler: [requireAuth()], schema: { body: contactBody } },
    async (request) => {
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }
      const supabase = requireSupabase(app.supabase);
      const body = request.body as { roleCode: string; subject: string; message: string };
      const roleCode = body.roleCode.trim().toUpperCase();
      if (!isContactRole(roleCode)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid contact role.', 400);
      }
      if (!allowedContactRoles(request.user.roles).includes(roleCode)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot message that role.', 403);
      }

      const subject = body.subject.trim();
      const message = body.message.trim();
      if (subject.length < 3) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Subject is too short.', 400);
      }
      if (message.length < 10) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Message is too short.', 400);
      }

      const staff = await listStaffByRole(supabase, roleCode);
      const recipients = staff.map((person) => person.email).filter((email) => email.includes('@'));
      if (!recipients.length) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `No ${ROLE_LABELS[roleCode]} with an email address is available right now.`,
          400,
        );
      }

      const fromName = request.user.fullName || 'Portal user';
      const fromEmail = request.user.email || 'unknown';
      const result = await sendPortalMail({
        to: recipients,
        subject: `[ERP Portal Help] ${subject}`,
        eyebrow: 'ERP Portal help',
        title: `Message for ${ROLE_LABELS[roleCode]}`,
        greeting: `Hello ${ROLE_LABELS[roleCode]},`,
        paragraphs: [
          `${fromName} (${fromEmail}) sent this message from the ERP Portal help chatbot.`,
          message,
          'Reply to the sender’s work email if a response is needed.',
        ],
        details: [
          { label: 'From', value: `${fromName} <${fromEmail}>` },
          { label: 'To role', value: ROLE_LABELS[roleCode] },
          { label: 'Subject', value: subject },
        ],
      });

      await writeAuditLog(supabase, {
        actorId: request.user.employeeId,
        action: 'faq.contact',
        entityType: 'faq_contact',
        entityId: roleCode,
        newValues: {
          roleCode,
          subject,
          recipientCount: recipients.length,
          outcome: result.outcome,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      if (!result.sent) {
        if (result.outcome === 'disabled') {
          throw new AppError(
            API_ERROR_CODES.SERVICE_UNAVAILABLE,
            'Outbound email is not configured on the server.',
            503,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Unable to send the message right now.', 500);
      }

      return ok({
        sent: true,
        roleCode,
        label: ROLE_LABELS[roleCode],
        recipientCount: recipients.length,
      });
    },
  );
}
