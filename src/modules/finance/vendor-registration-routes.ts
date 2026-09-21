import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createVendorRegistrationService } from './vendor-registration-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const nullableString = Type.Union([Type.String(), Type.Null()]);
const uuidOrNull = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);

const registrationType = Type.Union([
  Type.Literal('regular'),
  Type.Literal('composition'),
  Type.Literal('unregistered'),
  Type.Null(),
]);

const gstProfileBody = Type.Object({
  label: Type.Optional(Type.String()),
  gstin: Type.Optional(Type.String({ minLength: 1 })),
  legalName: Type.Optional(Type.String()),
  tradeName: Type.Optional(Type.String()),
  cin: Type.Optional(nullableString),
  pan: Type.Optional(nullableString),
  stateCode: Type.Optional(nullableString),
  stateName: Type.Optional(nullableString),
  addressLine1: Type.Optional(Type.String()),
  addressLine2: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  postalCode: Type.Optional(Type.String()),
  phone: Type.Optional(nullableString),
  email: Type.Optional(nullableString),
  website: Type.Optional(nullableString),
  registrationType: Type.Optional(registrationType),
  isDefault: Type.Optional(Type.Boolean()),
  active: Type.Optional(Type.Boolean()),
});

const gstProfileCreateBody = Type.Object({
  label: Type.Optional(Type.String()),
  gstin: Type.String({ minLength: 1 }),
  legalName: Type.Optional(Type.String()),
  tradeName: Type.Optional(Type.String()),
  cin: Type.Optional(nullableString),
  pan: Type.Optional(nullableString),
  stateCode: Type.Optional(nullableString),
  stateName: Type.Optional(nullableString),
  addressLine1: Type.Optional(Type.String()),
  addressLine2: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  postalCode: Type.Optional(Type.String()),
  phone: Type.Optional(nullableString),
  email: Type.Optional(nullableString),
  website: Type.Optional(nullableString),
  registrationType: Type.Optional(registrationType),
  isDefault: Type.Optional(Type.Boolean()),
  active: Type.Optional(Type.Boolean()),
});

const addressBody = Type.Object({
  label: Type.Optional(Type.String()),
  addressType: Type.Optional(
    Type.Union([
      Type.Literal('registered'),
      Type.Literal('operating'),
      Type.Literal('billing'),
      Type.Literal('shipping'),
      Type.Literal('factory'),
      Type.Literal('other'),
    ]),
  ),
  line1: Type.Optional(Type.String()),
  line2: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  stateCode: Type.Optional(nullableString),
  stateName: Type.Optional(nullableString),
  postalCode: Type.Optional(Type.String()),
  countryCode: Type.Optional(Type.String()),
  isDefault: Type.Optional(Type.Boolean()),
});

const addressCreateBody = Type.Object({
  label: Type.Optional(Type.String()),
  addressType: Type.Optional(
    Type.Union([
      Type.Literal('registered'),
      Type.Literal('operating'),
      Type.Literal('billing'),
      Type.Literal('shipping'),
      Type.Literal('factory'),
      Type.Literal('other'),
    ]),
  ),
  line1: Type.String({ minLength: 1 }),
  line2: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  stateCode: Type.Optional(nullableString),
  stateName: Type.Optional(nullableString),
  postalCode: Type.Optional(Type.String()),
  countryCode: Type.Optional(Type.String()),
  isDefault: Type.Optional(Type.Boolean()),
});

const officerBody = Type.Object({
  role: Type.Optional(Type.Union([Type.Literal('ceo'), Type.Literal('director'), Type.Literal('other')])),
  fullName: Type.Optional(Type.String()),
  designation: Type.Optional(Type.String()),
  email: Type.Optional(nullableString),
  phone: Type.Optional(nullableString),
  din: Type.Optional(nullableString),
  orgGstProfileId: Type.Optional(uuidOrNull),
});

const officerCreateBody = Type.Object({
  role: Type.Optional(Type.Union([Type.Literal('ceo'), Type.Literal('director'), Type.Literal('other')])),
  fullName: Type.String({ minLength: 1 }),
  designation: Type.Optional(Type.String()),
  email: Type.Optional(nullableString),
  phone: Type.Optional(nullableString),
  din: Type.Optional(nullableString),
  orgGstProfileId: Type.Optional(uuidOrNull),
});

const principalCustomer = Type.Object({
  customerNameAddress: Type.Optional(Type.String()),
  productSupplied: Type.Optional(Type.String()),
});

const vendorRegistrationBody = Type.Object({
  displayName: Type.Optional(Type.String()),
  companyName: Type.Optional(Type.String()),
  email: Type.Optional(nullableString),
  phone: Type.Optional(nullableString),
  telephone: Type.Optional(nullableString),
  fax: Type.Optional(nullableString),
  gstin: Type.Optional(nullableString),
  pan: Type.Optional(nullableString),
  stateCode: Type.Optional(nullableString),
  stateName: Type.Optional(nullableString),
  billingAddress: Type.Optional(Type.String()),
  registeredAddress: Type.Optional(Type.String()),
  factoryAddress: Type.Optional(Type.String()),
  shippingAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
  establishmentType: Type.Optional(Type.String()),
  constitution: Type.Optional(Type.String()),
  yearEstablished: Type.Optional(Type.String()),
  salesTaxRegNo: Type.Optional(nullableString),
  factoryLicenseNo: Type.Optional(nullableString),
  businessProfile: Type.Optional(Type.String()),
  bankNameAddress: Type.Optional(Type.String()),
  bankAccountNo: Type.Optional(nullableString),
  ifsc: Type.Optional(nullableString),
  micr: Type.Optional(nullableString),
  creditLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  contactPersonName: Type.Optional(Type.String()),
  contactPersonDesignation: Type.Optional(Type.String()),
  contactPersonMobile: Type.Optional(nullableString),
  declarationName: Type.Optional(Type.String()),
  declarationDesignation: Type.Optional(Type.String()),
  declarationPlace: Type.Optional(Type.String()),
  declarationDate: Type.Optional(nullableString),
  orgGstProfileId: Type.Optional(uuidOrNull),
  billingAddressId: Type.Optional(uuidOrNull),
  shippingAddressId: Type.Optional(uuidOrNull),
  officeInspectedBy: Type.Optional(Type.String()),
  officeInspectionDate: Type.Optional(nullableString),
  vendorCode: Type.Optional(nullableString),
  officeApprovedBy: Type.Optional(Type.String()),
  officeDecision: Type.Optional(
    Type.Union([
      Type.Literal('approved'),
      Type.Literal('rejected'),
      Type.Literal('pending'),
      Type.Null(),
    ]),
  ),
  principalCustomers: Type.Optional(Type.Array(principalCustomer)),
});

const vendorRegistrationCreateBody = Type.Object({
  ...vendorRegistrationBody.properties,
  displayName: Type.String({ minLength: 1 }),
});

const logoUploadBody = Type.Object({
  fileName: Type.String({ minLength: 1 }),
  contentType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 1 }),
});

const documentUploadBody = Type.Object({
  documentType: Type.Union([
    Type.Literal('income_tax'),
    Type.Literal('sales_tax_license'),
    Type.Literal('msme_ssi_license'),
    Type.Literal('gst_certificate'),
    Type.Literal('pan_card'),
    Type.Literal('cancelled_cheque'),
    Type.Literal('iso_certificate'),
    Type.Literal('other'),
  ]),
  fileName: Type.String({ minLength: 1 }),
  contentType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 1 }),
});

const orgPerms = [PERMISSIONS.FINANCE_ORG_MANAGE] as const;
const partyPerms = [PERMISSIONS.FINANCE_PARTIES_MANAGE] as const;
const orgOrPartyPerms = [PERMISSIONS.FINANCE_ORG_MANAGE, PERMISSIONS.FINANCE_PARTIES_MANAGE] as const;

export async function registerFinanceVendorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => createVendorRegistrationService(app.supabase!);

  app.get(
    '/api/v1/finance/org/gst-profiles',
    { preHandler: [requirePermission(...orgOrPartyPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listGstProfiles(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/org/gst-profiles',
    { preHandler: [requirePermission(...orgPerms)], schema: { body: gstProfileCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().createGstProfile(request.user!, request.body as Record<string, unknown>, metaOf(request)));
    },
  );

  app.patch(
    '/api/v1/finance/org/gst-profiles/:id',
    { preHandler: [requirePermission(...orgPerms)], schema: { body: gstProfileBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await svc().updateGstProfile(request.user!, id, request.body as Record<string, unknown>, metaOf(request)),
      );
    },
  );

  app.post(
    '/api/v1/finance/org/gst-profiles/:id/logo-upload',
    { preHandler: [requirePermission(...orgPerms)], schema: { body: logoUploadBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      const body = request.body as { fileName: string; contentType: string; sizeBytes: number };
      return ok(await svc().createGstProfileLogoUpload(request.user!, id, body));
    },
  );

  app.get(
    '/api/v1/finance/org/addresses',
    { preHandler: [requirePermission(...orgOrPartyPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listAddresses(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/org/addresses',
    { preHandler: [requirePermission(...orgOrPartyPerms)], schema: { body: addressCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().createAddress(request.user!, request.body as Record<string, unknown>, metaOf(request)));
    },
  );

  app.patch(
    '/api/v1/finance/org/addresses/:id',
    { preHandler: [requirePermission(...orgOrPartyPerms)], schema: { body: addressBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await svc().updateAddress(request.user!, id, request.body as Record<string, unknown>, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/finance/org/officers',
    { preHandler: [requirePermission(...orgPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { orgGstProfileId?: string };
      return ok(
        await svc().listOfficers(request.user!, {
          orgGstProfileId: query.orgGstProfileId || undefined,
        }),
      );
    },
  );

  app.post(
    '/api/v1/finance/org/officers',
    { preHandler: [requirePermission(...orgPerms)], schema: { body: officerCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().createOfficer(request.user!, request.body as Record<string, unknown>, metaOf(request)));
    },
  );

  app.patch(
    '/api/v1/finance/org/officers/:id',
    { preHandler: [requirePermission(...orgPerms)], schema: { body: officerBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await svc().updateOfficer(request.user!, id, request.body as Record<string, unknown>, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/finance/vendors/:id/registration',
    { preHandler: [requirePermission(...partyPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await svc().getVendorRegistration(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/vendors/registration',
    { preHandler: [requirePermission(...partyPerms)], schema: { body: vendorRegistrationCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await svc().saveVendorRegistration(request.user!, request.body as Record<string, unknown>, metaOf(request)),
      );
    },
  );

  app.patch(
    '/api/v1/finance/vendors/:id/registration',
    { preHandler: [requirePermission(...partyPerms)], schema: { body: vendorRegistrationBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await svc().saveVendorRegistration(
          request.user!,
          request.body as Record<string, unknown>,
          metaOf(request),
          id,
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/vendors/:id/documents/upload',
    { preHandler: [requirePermission(...partyPerms)], schema: { body: documentUploadBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        documentType:
          | 'income_tax'
          | 'sales_tax_license'
          | 'msme_ssi_license'
          | 'gst_certificate'
          | 'pan_card'
          | 'cancelled_cheque'
          | 'iso_certificate'
          | 'other';
        fileName: string;
        contentType: string;
        sizeBytes: number;
      };
      return ok(await svc().createVendorDocumentUpload(request.user!, id, body));
    },
  );

  app.get(
    '/api/v1/finance/vendors/:id/print',
    { preHandler: [requirePermission(...partyPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await svc().getVendorPrint(request.user!, id));
    },
  );
}
