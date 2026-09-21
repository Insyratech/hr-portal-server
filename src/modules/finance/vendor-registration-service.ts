import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageFinanceOrg, canManageParties, type RequestMeta } from './access';
import { normalizeGstin, parseGstin } from './gstin-utils';
import type {
  FinanceEmployeeOption,
  FinanceOrgAddress,
  FinanceOrgGstProfile,
  FinanceOrgOfficer,
  FinanceSignedUpload,
  FinanceVendorDocument,
  FinanceVendorDocumentType,
  FinanceVendorPrintPayload,
  FinanceVendorPrincipalCustomer,
  FinanceVendorRegistration,
} from './vendor-registration-types';

const ORG_ID = '00000000-0000-4000-8000-000000000020';
const LOGO_BUCKET = 'finance-org-logos';
const DOC_BUCKET = 'finance-vendor-docs';
const MAX_GST_REGISTRATIONS = 4;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const LOGO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOC_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const DOCUMENT_LABELS: Record<FinanceVendorDocumentType, string> = {
  income_tax: 'Latest Income Tax details',
  sales_tax_license: 'Copy of Sales Tax License',
  msme_ssi_license: 'SSI / MSME / Shops & establishment license',
  gst_certificate: 'GST Registration Certificate',
  pan_card: 'PAN Card copy',
  cancelled_cheque: 'Cancelled cheque',
  iso_certificate: 'ISO Certificate',
  other: 'Other document',
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  return emptyToNull(value);
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function signedUrl(supabase: SupabaseClient, bucket: string, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

function mapGstProfile(row: Record<string, unknown>, logoUrl: string | null): FinanceOrgGstProfile {
  const gstin = (row.gstin as string) ?? '';
  const legalName = (row.legal_name as string) ?? '';
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    label: (row.label as string) || legalName || gstin,
    gstin,
    legalName,
    tradeName: (row.trade_name as string) ?? '',
    cin: (row.cin as string | null) ?? null,
    pan: (row.pan as string | null) ?? null,
    stateCode: (row.state_code as string | null) ?? null,
    stateName: (row.state_name as string | null) ?? null,
    addressLine1: (row.address_line1 as string) ?? '',
    addressLine2: (row.address_line2 as string) ?? '',
    city: (row.city as string) ?? '',
    postalCode: (row.postal_code as string) ?? '',
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    logoStoragePath: (row.logo_storage_path as string | null) ?? null,
    logoUrl,
    registrationType: (row.registration_type as FinanceOrgGstProfile['registrationType']) ?? null,
    isDefault: Boolean(row.is_default),
    active: Boolean(row.active),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapAddress(row: Record<string, unknown>): FinanceOrgAddress {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    label: (row.label as string) ?? '',
    addressType: row.address_type as FinanceOrgAddress['addressType'],
    line1: (row.line1 as string) ?? '',
    line2: (row.line2 as string) ?? '',
    city: (row.city as string) ?? '',
    stateCode: (row.state_code as string | null) ?? null,
    stateName: (row.state_name as string | null) ?? null,
    postalCode: (row.postal_code as string) ?? '',
    countryCode: (row.country_code as string) ?? 'IN',
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function officerRoleLabel(role: string): string {
  if (role === 'ceo') return 'CEO';
  if (role === 'director') return 'Director';
  return 'Other';
}

function mapOfficer(row: Record<string, unknown>): FinanceOrgOfficer {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    orgGstProfileId: (row.org_gst_profile_id as string | null) ?? null,
    role: row.role as FinanceOrgOfficer['role'],
    fullName: row.full_name as string,
    designation: (row.designation as string) ?? '',
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    din: (row.din as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapVendorBase(row: Record<string, unknown>): Omit<
  FinanceVendorRegistration,
  'principalCustomers' | 'documents' | 'orgGstProfile'
> {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    companyName: (row.company_name as string) ?? '',
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    telephone: (row.telephone as string | null) ?? null,
    fax: (row.fax as string | null) ?? null,
    gstin: (row.gstin as string | null) ?? null,
    pan: (row.pan as string | null) ?? null,
    stateCode: (row.state_code as string | null) ?? null,
    stateName: (row.state_name as string | null) ?? null,
    billingAddress: (row.billing_address as string) ?? '',
    registeredAddress: (row.registered_address as string) ?? '',
    factoryAddress: (row.factory_address as string) ?? '',
    shippingAddress: (row.shipping_address as string) ?? '',
    paymentTermsDays: Number(row.payment_terms_days ?? 0),
    currencyCode: (row.currency_code as string) ?? 'INR',
    status: (row.status as 'active' | 'inactive') ?? 'active',
    notes: (row.notes as string) ?? '',
    establishmentType: (row.establishment_type as string) ?? '',
    constitution: (row.constitution as string) ?? '',
    yearEstablished: (row.year_established as string) ?? '',
    salesTaxRegNo: (row.sales_tax_reg_no as string | null) ?? null,
    factoryLicenseNo: (row.factory_license_no as string | null) ?? null,
    businessProfile: (row.business_profile as string) ?? '',
    bankNameAddress: (row.bank_name_address as string) ?? '',
    bankAccountNo: (row.bank_account_no as string | null) ?? null,
    ifsc: (row.ifsc as string | null) ?? null,
    micr: (row.micr as string | null) ?? null,
    creditLimit: row.credit_limit == null ? null : Number(row.credit_limit),
    contactPersonName: (row.contact_person_name as string) ?? '',
    contactPersonDesignation: (row.contact_person_designation as string) ?? '',
    contactPersonMobile: (row.contact_person_mobile as string | null) ?? null,
    declarationName: (row.declaration_name as string) ?? '',
    declarationDesignation: (row.declaration_designation as string) ?? '',
    declarationPlace: (row.declaration_place as string) ?? '',
    declarationDate: row.declaration_date ? String(row.declaration_date).slice(0, 10) : null,
    vendorSignaturePath: (row.vendor_signature_path as string | null) ?? null,
    orgGstProfileId: (row.org_gst_profile_id as string | null) ?? null,
    billingAddressId: (row.billing_address_id as string | null) ?? null,
    shippingAddressId: (row.shipping_address_id as string | null) ?? null,
    officeInspectedBy: (row.office_inspected_by as string) ?? '',
    officeInspectionDate: row.office_inspection_date
      ? String(row.office_inspection_date).slice(0, 10)
      : null,
    vendorCode: (row.vendor_code as string | null) ?? null,
    officeApprovedBy: (row.office_approved_by as string) ?? '',
    officeDecision: (row.office_decision as FinanceVendorRegistration['officeDecision']) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function vendorPatchFromInput(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const map: Record<string, string> = {
    displayName: 'display_name',
    companyName: 'company_name',
    email: 'email',
    phone: 'phone',
    telephone: 'telephone',
    fax: 'fax',
    gstin: 'gstin',
    pan: 'pan',
    stateCode: 'state_code',
    stateName: 'state_name',
    billingAddress: 'billing_address',
    registeredAddress: 'registered_address',
    factoryAddress: 'factory_address',
    shippingAddress: 'shipping_address',
    notes: 'notes',
    establishmentType: 'establishment_type',
    constitution: 'constitution',
    yearEstablished: 'year_established',
    salesTaxRegNo: 'sales_tax_reg_no',
    factoryLicenseNo: 'factory_license_no',
    businessProfile: 'business_profile',
    bankNameAddress: 'bank_name_address',
    bankAccountNo: 'bank_account_no',
    ifsc: 'ifsc',
    micr: 'micr',
    contactPersonName: 'contact_person_name',
    contactPersonDesignation: 'contact_person_designation',
    contactPersonMobile: 'contact_person_mobile',
    declarationName: 'declaration_name',
    declarationDesignation: 'declaration_designation',
    declarationPlace: 'declaration_place',
    declarationDate: 'declaration_date',
    orgGstProfileId: 'org_gst_profile_id',
    billingAddressId: 'billing_address_id',
    shippingAddressId: 'shipping_address_id',
    officeInspectedBy: 'office_inspected_by',
    officeInspectionDate: 'office_inspection_date',
    vendorCode: 'vendor_code',
    officeApprovedBy: 'office_approved_by',
    officeDecision: 'office_decision',
    status: 'status',
  };
  for (const [camel, snake] of Object.entries(map)) {
    if (input[camel] === undefined) continue;
    if (
      [
        'email',
        'phone',
        'telephone',
        'fax',
        'gstin',
        'pan',
        'stateCode',
        'stateName',
        'salesTaxRegNo',
        'factoryLicenseNo',
        'bankAccountNo',
        'ifsc',
        'micr',
        'contactPersonMobile',
        'declarationDate',
        'orgGstProfileId',
        'billingAddressId',
        'shippingAddressId',
        'officeInspectionDate',
        'vendorCode',
        'officeDecision',
      ].includes(camel)
    ) {
      patch[snake] = asNullableString(input[camel] as string | null);
    } else if (camel === 'status' || camel === 'officeDecision') {
      patch[snake] = input[camel];
    } else {
      patch[snake] = asString(input[camel]);
    }
  }
  if (input.paymentTermsDays !== undefined) {
    patch.payment_terms_days = Number(input.paymentTermsDays) || 0;
  }
  if (input.creditLimit !== undefined) {
    patch.credit_limit = asNumberOrNull(input.creditLimit);
  }
  if (input.displayName !== undefined && patch.display_name === '') {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor name is required.', 400);
  }
  return patch;
}

export function createVendorRegistrationService(supabase: SupabaseClient) {
  return {
    async listGstProfiles(actor: RequestUser): Promise<FinanceOrgGstProfile[]> {
      if (!canManageFinanceOrg(actor) && !canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view GST profiles.', 403);
      }
      const { data, error } = await supabase
        .from('finance_org_gst_profiles')
        .select('*')
        .eq('organization_id', ORG_ID)
        .order('is_default', { ascending: false })
        .order('gstin');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list GST profiles.', 500);
      }
      return Promise.all(
        ((data ?? []) as Record<string, unknown>[]).map(async (row) =>
          mapGstProfile(row, await signedUrl(supabase, LOGO_BUCKET, (row.logo_storage_path as string | null) ?? null)),
        ),
      );
    },

    async createGstProfile(actor: RequestUser, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage GST registrations.', 403);
      }
      const gstin = normalizeGstin(asString(input.gstin));
      const parsed = parseGstin(gstin);
      if (!parsed.validFormat) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, parsed.message, 400);
      }
      const legalName = asString(input.legalName);
      if (!legalName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Legal name is required for this GST registration.', 400);
      }
      const addressLine1 = asString(input.addressLine1);
      if (!addressLine1) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Registered address is required.', 400);
      }
      const city = asString(input.city);
      if (!city) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'City is required.', 400);
      }
      const stateCode = asNullableString(input.stateCode as string | null) ?? parsed.stateCode;
      const stateName = asNullableString(input.stateName as string | null) ?? parsed.stateName;

      const { count, error: countErr } = await supabase
        .from('finance_org_gst_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ORG_ID)
        .eq('active', true);
      if (countErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check GST registration limit.', 500);
      }
      if ((count ?? 0) >= MAX_GST_REGISTRATIONS) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `At most ${MAX_GST_REGISTRATIONS} GST registrations are allowed. Deactivate one before adding another.`,
          400,
        );
      }

      const tradeName = asString(input.tradeName) || legalName;
      const displayLabel = legalName || gstin;
      const isDefault = Boolean(input.isDefault) || (count ?? 0) === 0;
      if (isDefault) {
        await supabase
          .from('finance_org_gst_profiles')
          .update({ is_default: false })
          .eq('organization_id', ORG_ID);
      }
      const { data, error } = await supabase
        .from('finance_org_gst_profiles')
        .insert({
          organization_id: ORG_ID,
          label: displayLabel,
          gstin,
          legal_name: legalName,
          trade_name: tradeName,
          cin: asNullableString(input.cin as string | null),
          pan: asNullableString(input.pan as string | null) ?? parsed.pan,
          state_code: stateCode,
          state_name: stateName,
          address_line1: addressLine1,
          address_line2: asString(input.addressLine2),
          city,
          postal_code: asString(input.postalCode),
          phone: asNullableString(input.phone as string | null),
          email: asNullableString(input.email as string | null),
          website: asNullableString(input.website as string | null),
          registration_type: input.registrationType ?? 'regular',
          is_default: isDefault,
          active: input.active === undefined ? true : Boolean(input.active),
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'This GSTIN is already registered.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create GST registration.', 500);
      }
      if (isDefault) {
        const orgPatch: Record<string, unknown> = {
          gstin,
          legal_name: legalName,
          trade_name: tradeName,
          state_code: stateCode,
          state_name: stateName,
          address_line1: addressLine1,
          address_line2: asString(input.addressLine2),
          city,
          postal_code: asString(input.postalCode),
          gst_registered: true,
        };
        if (input.fiscalYearStartMonth !== undefined) {
          const month = Number(input.fiscalYearStartMonth);
          if (!Number.isInteger(month) || month < 1 || month > 12) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Fiscal year start month must be 1–12.', 400);
          }
          orgPatch.fiscal_year_start_month = month;
        }
        await supabase.from('finance_organizations').update(orgPatch).eq('id', ORG_ID);
      } else if (input.fiscalYearStartMonth !== undefined) {
        const month = Number(input.fiscalYearStartMonth);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Fiscal year start month must be 1–12.', 400);
        }
        await supabase
          .from('finance_organizations')
          .update({ fiscal_year_start_month: month })
          .eq('id', ORG_ID);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_gst_profile.create',
        entityType: 'finance_org_gst_profile',
        entityId: data.id as string,
        newValues: { gstin, legalName },
        ...meta,
      });
      return mapGstProfile(data as Record<string, unknown>, null);
    },

    async updateGstProfile(
      actor: RequestUser,
      id: string,
      input: Record<string, unknown>,
      meta: RequestMeta,
    ) {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage GST profiles.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.gstin !== undefined) {
        const gstin = normalizeGstin(asString(input.gstin));
        const parsed = parseGstin(gstin);
        if (!parsed.validFormat) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, parsed.message, 400);
        }
        patch.gstin = gstin;
        if (input.stateCode === undefined && parsed.stateCode) patch.state_code = parsed.stateCode;
        if (input.stateName === undefined && parsed.stateName) patch.state_name = parsed.stateName;
        if (input.pan === undefined && parsed.pan) patch.pan = parsed.pan;
      }
      if (input.legalName !== undefined) {
        const legalName = asString(input.legalName);
        if (!legalName) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Legal name is required.', 400);
        }
        patch.legal_name = legalName;
        patch.label = legalName;
      }
      if (input.tradeName !== undefined) patch.trade_name = asString(input.tradeName);
      if (input.cin !== undefined) patch.cin = asNullableString(input.cin as string | null);
      if (input.pan !== undefined) patch.pan = asNullableString(input.pan as string | null);
      if (input.stateCode !== undefined) patch.state_code = asNullableString(input.stateCode as string | null);
      if (input.stateName !== undefined) patch.state_name = asNullableString(input.stateName as string | null);
      if (input.addressLine1 !== undefined) patch.address_line1 = asString(input.addressLine1);
      if (input.addressLine2 !== undefined) patch.address_line2 = asString(input.addressLine2);
      if (input.city !== undefined) patch.city = asString(input.city);
      if (input.postalCode !== undefined) patch.postal_code = asString(input.postalCode);
      if (input.phone !== undefined) patch.phone = asNullableString(input.phone as string | null);
      if (input.email !== undefined) patch.email = asNullableString(input.email as string | null);
      if (input.website !== undefined) patch.website = asNullableString(input.website as string | null);
      if (input.registrationType !== undefined) patch.registration_type = input.registrationType;
      if (input.active !== undefined) patch.active = Boolean(input.active);
      if (input.isDefault === true) {
        await supabase
          .from('finance_org_gst_profiles')
          .update({ is_default: false })
          .eq('organization_id', ORG_ID);
        patch.is_default = true;
      } else if (input.isDefault === false) {
        patch.is_default = false;
      }
      const { data, error } = await supabase
        .from('finance_org_gst_profiles')
        .update(patch)
        .eq('id', id)
        .eq('organization_id', ORG_ID)
        .select('*')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'This GSTIN is already registered.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to update GST registration.', 500);
      }
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'GST registration not found.', 404);
      const orgPatch: Record<string, unknown> = {};
      if (data.is_default) {
        orgPatch.gstin = data.gstin;
        orgPatch.legal_name = data.legal_name;
        orgPatch.trade_name = data.trade_name;
        orgPatch.state_code = data.state_code;
        orgPatch.state_name = data.state_name;
        orgPatch.address_line1 = data.address_line1;
        orgPatch.address_line2 = data.address_line2;
        orgPatch.city = data.city;
        orgPatch.postal_code = data.postal_code;
        orgPatch.gst_registered = true;
      }
      if (input.fiscalYearStartMonth !== undefined) {
        const month = Number(input.fiscalYearStartMonth);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Fiscal year start month must be 1–12.', 400);
        }
        orgPatch.fiscal_year_start_month = month;
      }
      if (Object.keys(orgPatch).length > 0) {
        await supabase.from('finance_organizations').update(orgPatch).eq('id', ORG_ID);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_gst_profile.update',
        entityType: 'finance_org_gst_profile',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return mapGstProfile(
        data as Record<string, unknown>,
        await signedUrl(supabase, LOGO_BUCKET, (data.logo_storage_path as string | null) ?? null),
      );
    },

    async createGstProfileLogoUpload(
      actor: RequestUser,
      profileId: string,
      input: { fileName: string; contentType: string; sizeBytes: number },
    ): Promise<FinanceSignedUpload> {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot upload logos.', 403);
      }
      if (input.sizeBytes > MAX_LOGO_BYTES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Logo must be 2MB or smaller.', 400);
      }
      if (!LOGO_TYPES.has(input.contentType)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Logo must be JPEG, PNG, or WebP.', 400);
      }
      const { data: profile } = await supabase
        .from('finance_org_gst_profiles')
        .select('id')
        .eq('id', profileId)
        .eq('organization_id', ORG_ID)
        .maybeSingle();
      if (!profile) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'GST profile not found.', 404);
      const ext = input.fileName.split('.').pop()?.toLowerCase() || 'png';
      const path = `${ORG_ID}/${profileId}/${Date.now()}.${ext}`;
      const { data, error } = await supabase.storage.from(LOGO_BUCKET).createSignedUploadUrl(path);
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create logo upload URL.', 500);
      }
      await supabase
        .from('finance_org_gst_profiles')
        .update({ logo_storage_path: path })
        .eq('id', profileId);
      return { path: data.path, token: data.token, bucket: LOGO_BUCKET };
    },

    async listAddresses(actor: RequestUser): Promise<FinanceOrgAddress[]> {
      if (!canManageFinanceOrg(actor) && !canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view addresses.', 403);
      }
      const { data, error } = await supabase
        .from('finance_org_addresses')
        .select('*')
        .eq('organization_id', ORG_ID)
        .order('label');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list addresses.', 500);
      return ((data ?? []) as Record<string, unknown>[]).map(mapAddress);
    },

    async createAddress(actor: RequestUser, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageFinanceOrg(actor) && !canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage addresses.', 403);
      }
      const line1 = asString(input.line1);
      if (!line1) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Address line 1 is required.', 400);
      }
      const { data, error } = await supabase
        .from('finance_org_addresses')
        .insert({
          organization_id: ORG_ID,
          label: asString(input.label) || 'Address',
          address_type: (input.addressType as string) || 'other',
          line1,
          line2: asString(input.line2),
          city: asString(input.city),
          state_code: asNullableString(input.stateCode as string | null),
          state_name: asNullableString(input.stateName as string | null),
          postal_code: asString(input.postalCode),
          country_code: asString(input.countryCode) || 'IN',
          is_default: Boolean(input.isDefault),
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create address.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_address.create',
        entityType: 'finance_org_address',
        entityId: data.id as string,
        newValues: { line1 },
        ...meta,
      });
      return mapAddress(data as Record<string, unknown>);
    },

    async updateAddress(actor: RequestUser, id: string, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageFinanceOrg(actor) && !canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage addresses.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.label !== undefined) patch.label = asString(input.label);
      if (input.addressType !== undefined) patch.address_type = input.addressType;
      if (input.line1 !== undefined) patch.line1 = asString(input.line1);
      if (input.line2 !== undefined) patch.line2 = asString(input.line2);
      if (input.city !== undefined) patch.city = asString(input.city);
      if (input.stateCode !== undefined) patch.state_code = asNullableString(input.stateCode as string | null);
      if (input.stateName !== undefined) patch.state_name = asNullableString(input.stateName as string | null);
      if (input.postalCode !== undefined) patch.postal_code = asString(input.postalCode);
      if (input.isDefault !== undefined) patch.is_default = Boolean(input.isDefault);
      const { data, error } = await supabase
        .from('finance_org_addresses')
        .update(patch)
        .eq('id', id)
        .eq('organization_id', ORG_ID)
        .select('*')
        .maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update address.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Address not found.', 404);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_address.update',
        entityType: 'finance_org_address',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return mapAddress(data as Record<string, unknown>);
    },

    async listEmployeeOptions(actor: RequestUser): Promise<FinanceEmployeeOption[]> {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view employee options.', 403);
      }
      const { data, error } = await supabase
        .from('employees')
        .select('id, employee_code, full_name, email, phone, designations (name)')
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('full_name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list employees.', 500);
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => {
        const designations = row.designations as { name: string } | { name: string }[] | null;
        const designationName = Array.isArray(designations)
          ? (designations[0]?.name ?? null)
          : (designations?.name ?? null);
        return {
          id: row.id as string,
          employeeCode: (row.employee_code as string) ?? '',
          fullName: (row.full_name as string) ?? '',
          email: (row.email as string) ?? '',
          phone: (row.phone as string | null) ?? null,
          designationName,
        };
      });
    },

    async listOfficers(
      actor: RequestUser,
      filters?: { orgGstProfileId?: string | null },
    ): Promise<FinanceOrgOfficer[]> {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view officers.', 403);
      }
      let query = supabase
        .from('finance_org_officers')
        .select('*')
        .eq('organization_id', ORG_ID)
        .order('role')
        .order('full_name');
      if (filters?.orgGstProfileId) {
        query = query.eq('org_gst_profile_id', filters.orgGstProfileId);
      }
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list officers.', 500);
      return ((data ?? []) as Record<string, unknown>[]).map(mapOfficer);
    },

    async createOfficer(actor: RequestUser, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage officers.', 403);
      }
      const fullName = asString(input.fullName);
      if (!fullName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Officer name is required.', 400);
      }
      const orgGstProfileId = asNullableString(input.orgGstProfileId as string | null);
      if (orgGstProfileId) {
        const { data: profile } = await supabase
          .from('finance_org_gst_profiles')
          .select('id')
          .eq('id', orgGstProfileId)
          .eq('organization_id', ORG_ID)
          .maybeSingle();
        if (!profile) {
          throw new AppError(API_ERROR_CODES.NOT_FOUND, 'GST registration not found for officer.', 404);
        }
      }
      const role = (input.role as string) || 'other';
      const designation = asString(input.designation) || officerRoleLabel(role);
      const { data, error } = await supabase
        .from('finance_org_officers')
        .insert({
          organization_id: ORG_ID,
          org_gst_profile_id: orgGstProfileId,
          role,
          full_name: fullName,
          designation,
          email: asNullableString(input.email as string | null),
          phone: asNullableString(input.phone as string | null),
          din: asNullableString(input.din as string | null),
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create officer.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_officer.create',
        entityType: 'finance_org_officer',
        entityId: data.id as string,
        newValues: { fullName, orgGstProfileId },
        ...meta,
      });
      return mapOfficer(data as Record<string, unknown>);
    },

    async updateOfficer(actor: RequestUser, id: string, input: Record<string, unknown>, meta: RequestMeta) {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage officers.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.role !== undefined) patch.role = input.role;
      if (input.fullName !== undefined) patch.full_name = asString(input.fullName);
      if (input.designation !== undefined) patch.designation = asString(input.designation);
      if (input.email !== undefined) patch.email = asNullableString(input.email as string | null);
      if (input.phone !== undefined) patch.phone = asNullableString(input.phone as string | null);
      if (input.din !== undefined) patch.din = asNullableString(input.din as string | null);
      if (input.orgGstProfileId !== undefined) {
        const orgGstProfileId = asNullableString(input.orgGstProfileId as string | null);
        if (orgGstProfileId) {
          const { data: profile } = await supabase
            .from('finance_org_gst_profiles')
            .select('id')
            .eq('id', orgGstProfileId)
            .eq('organization_id', ORG_ID)
            .maybeSingle();
          if (!profile) {
            throw new AppError(API_ERROR_CODES.NOT_FOUND, 'GST registration not found for officer.', 404);
          }
        }
        patch.org_gst_profile_id = orgGstProfileId;
      }
      const { data, error } = await supabase
        .from('finance_org_officers')
        .update(patch)
        .eq('id', id)
        .eq('organization_id', ORG_ID)
        .select('*')
        .maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update officer.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Officer not found.', 404);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_org_officer.update',
        entityType: 'finance_org_officer',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return mapOfficer(data as Record<string, unknown>);
    },

    async getVendorRegistration(actor: RequestUser, id: string): Promise<FinanceVendorRegistration> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view vendors.', 403);
      }
      const { data, error } = await supabase.from('finance_vendors').select('*').eq('id', id).maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      return this.hydrateVendor(data as Record<string, unknown>);
    },

    async hydrateVendor(row: Record<string, unknown>): Promise<FinanceVendorRegistration> {
      const base = mapVendorBase(row);
      const [{ data: customers }, { data: docs }] = await Promise.all([
        supabase
          .from('finance_vendor_principal_customers')
          .select('*')
          .eq('vendor_id', base.id)
          .order('sort_order'),
        supabase.from('finance_vendor_documents').select('*').eq('vendor_id', base.id),
      ]);
      const principalCustomers: FinanceVendorPrincipalCustomer[] = ((customers ?? []) as Record<string, unknown>[]).map(
        (item) => ({
          id: item.id as string,
          vendorId: item.vendor_id as string,
          customerNameAddress: (item.customer_name_address as string) ?? '',
          productSupplied: (item.product_supplied as string) ?? '',
          sortOrder: Number(item.sort_order ?? 0),
        }),
      );
      const documents: FinanceVendorDocument[] = await Promise.all(
        ((docs ?? []) as Record<string, unknown>[]).map(async (item) => ({
          id: item.id as string,
          vendorId: item.vendor_id as string,
          documentType: item.document_type as FinanceVendorDocumentType,
          fileName: item.file_name as string,
          storagePath: item.storage_path as string,
          contentType: (item.content_type as string) ?? 'application/pdf',
          sizeBytes: Number(item.size_bytes ?? 0),
          downloadUrl: await signedUrl(supabase, DOC_BUCKET, item.storage_path as string),
          createdAt: item.created_at as string,
        })),
      );
      let orgGstProfile: FinanceOrgGstProfile | null = null;
      if (base.orgGstProfileId) {
        const { data: profile } = await supabase
          .from('finance_org_gst_profiles')
          .select('*')
          .eq('id', base.orgGstProfileId)
          .maybeSingle();
        if (profile) {
          orgGstProfile = mapGstProfile(
            profile as Record<string, unknown>,
            await signedUrl(supabase, LOGO_BUCKET, (profile.logo_storage_path as string | null) ?? null),
          );
        }
      }
      return { ...base, principalCustomers, documents, orgGstProfile };
    },

    async saveVendorRegistration(
      actor: RequestUser,
      input: Record<string, unknown>,
      meta: RequestMeta,
      id?: string,
    ): Promise<FinanceVendorRegistration> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage vendors.', 403);
      }
      const patch = vendorPatchFromInput(input);
      let vendorId = id;
      if (!vendorId) {
        const { data, error } = await supabase.from('finance_vendors').insert(patch).select('*').single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create vendor.', 500);
        }
        vendorId = data.id as string;
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance_vendor.create',
          entityType: 'finance_vendor',
          entityId: vendorId,
          newValues: { displayName: patch.display_name },
          ...meta,
        });
      } else {
        const { data, error } = await supabase
          .from('finance_vendors')
          .update(patch)
          .eq('id', vendorId)
          .select('*')
          .maybeSingle();
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to update vendor.', 500);
        if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance_vendor.update',
          entityType: 'finance_vendor',
          entityId: vendorId,
          newValues: patch,
          ...meta,
        });
      }

      const principals = Array.isArray(input.principalCustomers) ? input.principalCustomers : null;
      if (principals) {
        await supabase.from('finance_vendor_principal_customers').delete().eq('vendor_id', vendorId);
        const rows = principals
          .map((item, index) => {
            const row = item as Record<string, unknown>;
            return {
              vendor_id: vendorId,
              customer_name_address: asString(row.customerNameAddress),
              product_supplied: asString(row.productSupplied),
              sort_order: index,
            };
          })
          .filter((row) => row.customer_name_address || row.product_supplied);
        if (rows.length > 0) {
          const { error } = await supabase.from('finance_vendor_principal_customers').insert(rows);
          if (error) {
            throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save principal customers.', 500);
          }
        }
      }

      return this.getVendorRegistration(actor, vendorId!);
    },

    async createVendorDocumentUpload(
      actor: RequestUser,
      vendorId: string,
      input: { documentType: FinanceVendorDocumentType; fileName: string; contentType: string; sizeBytes: number },
    ): Promise<FinanceSignedUpload & { documentType: FinanceVendorDocumentType }> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot upload vendor documents.', 403);
      }
      if (!DOCUMENT_LABELS[input.documentType]) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid document type.', 400);
      }
      if (input.sizeBytes > MAX_DOC_BYTES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Document must be 10MB or smaller.', 400);
      }
      if (!DOC_TYPES.has(input.contentType)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Document must be PDF, JPEG, PNG, or WebP.', 400);
      }
      const { data: vendor } = await supabase.from('finance_vendors').select('id').eq('id', vendorId).maybeSingle();
      if (!vendor) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      const ext = input.fileName.split('.').pop()?.toLowerCase() || 'pdf';
      const path = `${vendorId}/${input.documentType}/${Date.now()}.${ext}`;
      const { data, error } = await supabase.storage.from(DOC_BUCKET).createSignedUploadUrl(path);
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create document upload URL.', 500);
      }
      const { error: upsertError } = await supabase.from('finance_vendor_documents').upsert(
        {
          vendor_id: vendorId,
          document_type: input.documentType,
          file_name: input.fileName,
          storage_path: path,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
        },
        { onConflict: 'vendor_id,document_type' },
      );
      if (upsertError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save document metadata.', 500);
      }
      return { path: data.path, token: data.token, bucket: DOC_BUCKET, documentType: input.documentType };
    },

    async getVendorPrint(actor: RequestUser, id: string): Promise<FinanceVendorPrintPayload> {
      const vendor = await this.getVendorRegistration(actor, id);
      let letterhead = vendor.orgGstProfile;
      if (!letterhead) {
        const profiles = await this.listGstProfiles(actor);
        letterhead = profiles.find((item) => item.isDefault && item.active) ?? profiles.find((item) => item.active) ?? null;
      }
      return { vendor, letterhead };
    },

    documentLabels: DOCUMENT_LABELS,
  };
}

export type VendorRegistrationService = ReturnType<typeof createVendorRegistrationService>;
