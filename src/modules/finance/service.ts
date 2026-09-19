import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  canAccessFinanceDesk,
  canManageCoa,
  canManageFinanceOrg,
  canManageItems,
  canManageParties,
  canManageSeries,
  canManageTax,
  canViewCoa,
  type RequestMeta,
} from './access';
import type {
  FinanceAccount,
  FinanceCustomer,
  FinanceCustomerChangeHistory,
  FinanceItem,
  FinanceNumberSeries,
  FinanceOrganization,
  FinanceSetupChecklist,
  FinanceTaxGroup,
  FinanceTaxRate,
  FinanceTdsRate,
  FinanceVendor,
} from './types';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type OrgRow = {
  id: string;
  legal_name: string;
  trade_name: string;
  cin: string | null;
  pan: string | null;
  gstin: string | null;
  industry: string | null;
  country_code: string;
  state_code: string | null;
  state_name: string | null;
  address_line1: string;
  address_line2: string;
  city: string;
  postal_code: string;
  base_currency: string;
  language: string;
  time_zone: string;
  fiscal_year_start_month: number;
  gst_registered: boolean;
  gst_registration_type: 'regular' | 'composition' | 'unregistered' | null;
  setup_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: FinanceAccount['accountType'];
  system_role: string | null;
  is_system: boolean;
  is_active: boolean;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type TaxRateRow = {
  id: string;
  name: string;
  rate_percent: number | string;
  tax_type: FinanceTaxRate['taxType'];
  is_active: boolean;
};

type CustomerRow = {
  id: string;
  display_name: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  state_name: string | null;
  billing_address: string;
  shipping_address: string;
  billing_line1?: string;
  billing_line2?: string;
  billing_city?: string;
  billing_postal_code?: string;
  billing_country?: string;
  shipping_line1?: string;
  shipping_line2?: string;
  shipping_city?: string;
  shipping_state_code?: string | null;
  shipping_state_name?: string | null;
  shipping_postal_code?: string;
  shipping_country?: string;
  ship_to_contact_name?: string;
  ship_to_company_name?: string;
  payment_terms_days: number;
  currency_code: string;
  status: 'active' | 'inactive';
  notes: string;
  created_at: string;
  updated_at: string;
};

type VendorRow = {
  id: string;
  display_name: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  state_name: string | null;
  billing_address: string;
  payment_terms_days: number;
  currency_code: string;
  status: 'active' | 'inactive';
  notes: string;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  id: string;
  code: string;
  name: string;
  item_type: 'goods' | 'service';
  hsn_sac: string | null;
  unit: string;
  sale_rate: number | string;
  purchase_rate: number | string;
  income_account_id: string | null;
  expense_account_id: string | null;
  tax_group_id: string | null;
  description: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

type SeriesRow = {
  id: string;
  document_type: string;
  prefix: string;
  pad_length: number;
  next_number: number | string;
  fiscal_year_label: string;
  reset_yearly: boolean;
  created_at: string;
  updated_at: string;
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function mapOrg(row: OrgRow): FinanceOrganization {
  return {
    id: row.id,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    cin: row.cin,
    pan: row.pan,
    gstin: row.gstin,
    industry: row.industry,
    countryCode: row.country_code,
    stateCode: row.state_code,
    stateName: row.state_name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    baseCurrency: row.base_currency,
    language: row.language,
    timeZone: row.time_zone,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    gstRegistered: row.gst_registered,
    gstRegistrationType: row.gst_registration_type,
    setupCompletedAt: row.setup_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccount(row: AccountRow): FinanceAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    systemRole: row.system_role,
    isSystem: row.is_system,
    isActive: row.is_active,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaxRate(row: TaxRateRow): FinanceTaxRate {
  return {
    id: row.id,
    name: row.name,
    ratePercent: Number(row.rate_percent),
    taxType: row.tax_type,
    isActive: row.is_active,
  };
}

function composePartyAddress(parts: {
  line1: string;
  line2: string;
  city: string;
  stateName: string | null;
  postalCode: string;
  country: string;
}): string {
  const locality = [parts.city, parts.stateName, parts.postalCode].filter(Boolean).join(', ');
  return [parts.line1, parts.line2, locality, parts.country].filter((p) => p.trim()).join('\n');
}

function mapCustomer(row: CustomerRow): FinanceCustomer {
  return {
    id: row.id,
    displayName: row.display_name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    gstin: row.gstin,
    pan: row.pan,
    stateCode: row.state_code,
    stateName: row.state_name,
    billingAddress: row.billing_address,
    shippingAddress: row.shipping_address,
    billingLine1: row.billing_line1 ?? '',
    billingLine2: row.billing_line2 ?? '',
    billingCity: row.billing_city ?? '',
    billingPostalCode: row.billing_postal_code ?? '',
    billingCountry: row.billing_country ?? 'India',
    shippingLine1: row.shipping_line1 ?? '',
    shippingLine2: row.shipping_line2 ?? '',
    shippingCity: row.shipping_city ?? '',
    shippingStateCode: row.shipping_state_code ?? null,
    shippingStateName: row.shipping_state_name ?? null,
    shippingPostalCode: row.shipping_postal_code ?? '',
    shippingCountry: row.shipping_country ?? 'India',
    shipToContactName: row.ship_to_contact_name ?? '',
    shipToCompanyName: row.ship_to_company_name ?? '',
    paymentTermsDays: row.payment_terms_days,
    currencyCode: row.currency_code,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type CustomerWriteInput = {
  displayName?: string;
  companyName?: string;
  email?: string | null;
  phone?: string | null;
  gstin?: string | null;
  pan?: string | null;
  stateCode?: string | null;
  stateName?: string | null;
  billingAddress?: string;
  shippingAddress?: string;
  billingLine1?: string;
  billingLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  shippingLine1?: string;
  shippingLine2?: string;
  shippingCity?: string;
  shippingStateCode?: string | null;
  shippingStateName?: string | null;
  shippingPostalCode?: string;
  shippingCountry?: string;
  shipToContactName?: string;
  shipToCompanyName?: string;
  paymentTermsDays?: number;
  status?: 'active' | 'inactive';
  notes?: string;
};

const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  display_name: 'Display name',
  company_name: 'Company name',
  email: 'Email',
  phone: 'Phone',
  gstin: 'GSTIN',
  pan: 'PAN',
  state_code: 'State code',
  state_name: 'State',
  billing_address: 'Billing address',
  shipping_address: 'Shipping address',
  billing_line1: 'Billing line 1',
  billing_line2: 'Billing line 2',
  billing_city: 'Billing city',
  billing_postal_code: 'Billing postal code',
  billing_country: 'Billing country',
  shipping_line1: 'Shipping line 1',
  shipping_line2: 'Shipping line 2',
  shipping_city: 'Shipping city',
  shipping_state_code: 'Shipping state code',
  shipping_state_name: 'Shipping state',
  shipping_postal_code: 'Shipping postal code',
  shipping_country: 'Shipping country',
  ship_to_contact_name: 'Ship-to contact',
  ship_to_company_name: 'Ship-to company',
  payment_terms_days: 'Payment terms (days)',
  status: 'Status',
  notes: 'Notes',
};

function buildCustomerPatch(input: CustomerWriteInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName.trim();
  if (input.companyName !== undefined) patch.company_name = input.companyName.trim();
  if (input.email !== undefined) patch.email = emptyToNull(input.email);
  if (input.phone !== undefined) patch.phone = emptyToNull(input.phone);
  if (input.gstin !== undefined) patch.gstin = emptyToNull(input.gstin);
  if (input.pan !== undefined) patch.pan = emptyToNull(input.pan);
  if (input.stateCode !== undefined) patch.state_code = emptyToNull(input.stateCode);
  if (input.stateName !== undefined) patch.state_name = emptyToNull(input.stateName);
  if (input.billingLine1 !== undefined) patch.billing_line1 = input.billingLine1.trim();
  if (input.billingLine2 !== undefined) patch.billing_line2 = input.billingLine2.trim();
  if (input.billingCity !== undefined) patch.billing_city = input.billingCity.trim();
  if (input.billingPostalCode !== undefined) patch.billing_postal_code = input.billingPostalCode.trim();
  if (input.billingCountry !== undefined) patch.billing_country = input.billingCountry.trim() || 'India';
  if (input.shippingLine1 !== undefined) patch.shipping_line1 = input.shippingLine1.trim();
  if (input.shippingLine2 !== undefined) patch.shipping_line2 = input.shippingLine2.trim();
  if (input.shippingCity !== undefined) patch.shipping_city = input.shippingCity.trim();
  if (input.shippingStateCode !== undefined) patch.shipping_state_code = emptyToNull(input.shippingStateCode);
  if (input.shippingStateName !== undefined) patch.shipping_state_name = emptyToNull(input.shippingStateName);
  if (input.shippingPostalCode !== undefined) patch.shipping_postal_code = input.shippingPostalCode.trim();
  if (input.shippingCountry !== undefined) patch.shipping_country = input.shippingCountry.trim() || 'India';
  if (input.shipToContactName !== undefined) patch.ship_to_contact_name = input.shipToContactName.trim();
  if (input.shipToCompanyName !== undefined) patch.ship_to_company_name = input.shipToCompanyName.trim();
  if (input.paymentTermsDays !== undefined) patch.payment_terms_days = input.paymentTermsDays;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes.trim();

  const hasStructuredBilling =
    input.billingLine1 !== undefined ||
    input.billingLine2 !== undefined ||
    input.billingCity !== undefined ||
    input.billingPostalCode !== undefined ||
    input.billingCountry !== undefined;
  if (hasStructuredBilling) {
    patch.billing_address = composePartyAddress({
      line1: String(patch.billing_line1 ?? input.billingLine1 ?? ''),
      line2: String(patch.billing_line2 ?? input.billingLine2 ?? ''),
      city: String(patch.billing_city ?? input.billingCity ?? ''),
      stateName: (emptyToNull(input.stateName ?? null) ?? null) as string | null,
      postalCode: String(patch.billing_postal_code ?? input.billingPostalCode ?? ''),
      country: String(patch.billing_country ?? input.billingCountry ?? 'India'),
    });
  } else if (input.billingAddress !== undefined) {
    patch.billing_address = input.billingAddress.trim();
    if (input.billingLine1 === undefined) patch.billing_line1 = input.billingAddress.trim();
  }

  const hasStructuredShipping =
    input.shippingLine1 !== undefined ||
    input.shippingLine2 !== undefined ||
    input.shippingCity !== undefined ||
    input.shippingPostalCode !== undefined ||
    input.shippingCountry !== undefined ||
    input.shippingStateName !== undefined;
  if (hasStructuredShipping) {
    patch.shipping_address = composePartyAddress({
      line1: String(patch.shipping_line1 ?? input.shippingLine1 ?? ''),
      line2: String(patch.shipping_line2 ?? input.shippingLine2 ?? ''),
      city: String(patch.shipping_city ?? input.shippingCity ?? ''),
      stateName: (emptyToNull(input.shippingStateName ?? input.stateName ?? null) ?? null) as string | null,
      postalCode: String(patch.shipping_postal_code ?? input.shippingPostalCode ?? ''),
      country: String(patch.shipping_country ?? input.shippingCountry ?? 'India'),
    });
  } else if (input.shippingAddress !== undefined) {
    patch.shipping_address = input.shippingAddress.trim();
    if (input.shippingLine1 === undefined) patch.shipping_line1 = input.shippingAddress.trim();
  }

  return patch;
}

function mapVendor(row: VendorRow): FinanceVendor {
  return {
    id: row.id,
    displayName: row.display_name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    gstin: row.gstin,
    pan: row.pan,
    stateCode: row.state_code,
    stateName: row.state_name,
    billingAddress: row.billing_address,
    paymentTermsDays: row.payment_terms_days,
    currencyCode: row.currency_code,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: ItemRow): FinanceItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    itemType: row.item_type,
    hsnSac: row.hsn_sac,
    unit: row.unit,
    saleRate: Number(row.sale_rate),
    purchaseRate: Number(row.purchase_rate),
    incomeAccountId: row.income_account_id,
    expenseAccountId: row.expense_account_id,
    taxGroupId: row.tax_group_id,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSeries(row: SeriesRow): FinanceNumberSeries {
  return {
    id: row.id,
    documentType: row.document_type,
    prefix: row.prefix,
    padLength: row.pad_length,
    nextNumber: Number(row.next_number),
    fiscalYearLabel: row.fiscal_year_label,
    resetYearly: row.reset_yearly,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orgReady(org: FinanceOrganization): boolean {
  return Boolean(
    org.legalName.trim() &&
      org.stateCode?.trim() &&
      org.addressLine1.trim() &&
      org.city.trim() &&
      (!org.gstRegistered || org.gstin?.trim()),
  );
}

export function createFinanceService(supabase: SupabaseClient) {
  return {
    async getSetup(actor: RequestUser): Promise<FinanceSetupChecklist> {
      if (!canAccessFinanceDesk(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot access the finance desk.', 403);
      }
      const { data: orgData, error: orgError } = await supabase
        .from('finance_organizations')
        .select('*')
        .eq('id', ORG_ID)
        .maybeSingle();
      if (orgError || !orgData) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load finance organization.', 500);
      }
      const org = mapOrg(orgData as OrgRow);
      const [{ count: taxCount }, { count: accountCount }, { count: customerCount }, { count: vendorCount }, { count: itemCount }, { count: seriesCount }] =
        await Promise.all([
          supabase.from('finance_tax_groups').select('id', { count: 'exact', head: true }).eq('is_active', true),
          supabase.from('finance_accounts').select('id', { count: 'exact', head: true }).eq('is_active', true),
          supabase.from('finance_customers').select('id', { count: 'exact', head: true }),
          supabase.from('finance_vendors').select('id', { count: 'exact', head: true }),
          supabase.from('finance_items').select('id', { count: 'exact', head: true }),
          supabase.from('finance_number_series').select('id', { count: 'exact', head: true }),
        ]);

      const steps = [
        {
          id: 'organization',
          label: 'Add organisation details',
          done: orgReady(org),
          href: '/finance/settings',
        },
        {
          id: 'tax',
          label: 'Review GST tax groups',
          done: (taxCount ?? 0) > 0,
          href: '/finance/tax',
        },
        {
          id: 'coa',
          label: 'Review chart of accounts',
          done: (accountCount ?? 0) > 0,
          href: '/finance/accounts',
        },
        {
          id: 'customer',
          label: 'Create your first customer',
          done: (customerCount ?? 0) > 0,
          href: '/finance/customers',
        },
        {
          id: 'vendor',
          label: 'Create your first vendor',
          done: (vendorCount ?? 0) > 0,
          href: '/finance/vendors',
        },
        {
          id: 'item',
          label: 'Create your first item',
          done: (itemCount ?? 0) > 0,
          href: '/finance/items',
        },
        {
          id: 'series',
          label: 'Confirm document number series',
          done: (seriesCount ?? 0) > 0,
          href: '/finance/series',
        },
      ];
      const doneCount = steps.filter((step) => step.done).length;
      return {
        organizationReady: steps[0].done,
        hasTaxGroups: steps[1].done,
        hasAccounts: steps[2].done,
        hasCustomer: steps[3].done,
        hasVendor: steps[4].done,
        hasItem: steps[5].done,
        hasSeries: steps[6].done,
        percentComplete: Math.round((doneCount / steps.length) * 100),
        steps,
      };
    },

    async getOrganization(actor: RequestUser): Promise<FinanceOrganization> {
      if (!canManageFinanceOrg(actor) && !canAccessFinanceDesk(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view finance organization.', 403);
      }
      const { data, error } = await supabase.from('finance_organizations').select('*').eq('id', ORG_ID).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load finance organization.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Finance organization not found. Apply migration 056.', 404);
      }
      return mapOrg(data as OrgRow);
    },

    async updateOrganization(
      actor: RequestUser,
      input: Partial<{
        legalName: string;
        tradeName: string;
        cin: string | null;
        pan: string | null;
        gstin: string | null;
        industry: string | null;
        stateCode: string | null;
        stateName: string | null;
        addressLine1: string;
        addressLine2: string;
        city: string;
        postalCode: string;
        fiscalYearStartMonth: number;
        gstRegistered: boolean;
        gstRegistrationType: 'regular' | 'composition' | 'unregistered' | null;
        markSetupComplete: boolean;
      }>,
      meta: RequestMeta,
    ): Promise<FinanceOrganization> {
      if (!canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage finance organization.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.legalName !== undefined) patch.legal_name = input.legalName.trim();
      if (input.tradeName !== undefined) patch.trade_name = input.tradeName.trim();
      if (input.cin !== undefined) patch.cin = emptyToNull(input.cin);
      if (input.pan !== undefined) patch.pan = emptyToNull(input.pan);
      if (input.gstin !== undefined) patch.gstin = emptyToNull(input.gstin);
      if (input.industry !== undefined) patch.industry = emptyToNull(input.industry);
      if (input.stateCode !== undefined) patch.state_code = emptyToNull(input.stateCode);
      if (input.stateName !== undefined) patch.state_name = emptyToNull(input.stateName);
      if (input.addressLine1 !== undefined) patch.address_line1 = input.addressLine1.trim();
      if (input.addressLine2 !== undefined) patch.address_line2 = input.addressLine2.trim();
      if (input.city !== undefined) patch.city = input.city.trim();
      if (input.postalCode !== undefined) patch.postal_code = input.postalCode.trim();
      if (input.fiscalYearStartMonth !== undefined) {
        if (input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Fiscal year start month must be 1–12.', 400);
        }
        patch.fiscal_year_start_month = input.fiscalYearStartMonth;
      }
      if (input.gstRegistered !== undefined) patch.gst_registered = input.gstRegistered;
      if (input.gstRegistrationType !== undefined) patch.gst_registration_type = input.gstRegistrationType;
      if (input.markSetupComplete) patch.setup_completed_at = new Date().toISOString();

      if (Object.keys(patch).length === 0) {
        return this.getOrganization(actor);
      }

      const { data, error } = await supabase
        .from('finance_organizations')
        .update(patch)
        .eq('id', ORG_ID)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update organization.', 500);
      }
      const updated = mapOrg(data as OrgRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_organization.update',
        entityType: 'finance_organization',
        entityId: updated.id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listAccounts(actor: RequestUser): Promise<FinanceAccount[]> {
      if (!canViewCoa(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the chart of accounts.', 403);
      }
      const { data, error } = await supabase
        .from('finance_accounts')
        .select('*')
        .order('code');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list accounts.', 500);
      }
      return ((data ?? []) as AccountRow[])
        .map(mapAccount)
        .sort((a, b) => a.accountType.localeCompare(b.accountType) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    },

    async createAccount(
      actor: RequestUser,
      input: { code: string; name: string; accountType: FinanceAccount['accountType']; sortOrder?: number },
      meta: RequestMeta,
    ): Promise<FinanceAccount> {
      if (!canManageCoa(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage accounts.', 403);
      }
      const code = input.code.trim();
      const name = input.name.trim();
      if (!code || !name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Account code and name are required.', 400);
      }
      const { data, error } = await supabase
        .from('finance_accounts')
        .insert({
          code,
          name,
          account_type: input.accountType,
          sort_order: input.sortOrder ?? 100,
          is_system: false,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An account with this code already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create account.', 500);
      }
      const created = mapAccount(data as AccountRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_account.create',
        entityType: 'finance_account',
        entityId: created.id,
        newValues: { code, name, accountType: input.accountType },
        ...meta,
      });
      return created;
    },

    async updateAccount(
      actor: RequestUser,
      id: string,
      input: { name?: string; isActive?: boolean; sortOrder?: number },
      meta: RequestMeta,
    ): Promise<FinanceAccount> {
      if (!canManageCoa(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage accounts.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.isActive !== undefined) patch.is_active = input.isActive;
      if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
      const { data, error } = await supabase.from('finance_accounts').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update account.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Account not found.', 404);
      }
      const updated = mapAccount(data as AccountRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_account.update',
        entityType: 'finance_account',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listTaxRates(actor: RequestUser): Promise<FinanceTaxRate[]> {
      if (!canManageTax(actor) && !canManageItems(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view tax rates.', 403);
      }
      const { data, error } = await supabase.from('finance_tax_rates').select('*').order('tax_type').order('rate_percent');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list tax rates.', 500);
      }
      return ((data ?? []) as TaxRateRow[]).map(mapTaxRate);
    },

    async listTaxGroups(actor: RequestUser): Promise<FinanceTaxGroup[]> {
      if (!canManageTax(actor) && !canManageItems(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view tax groups.', 403);
      }
      const [{ data: groups, error: gErr }, { data: rates, error: rErr }, { data: links, error: lErr }] = await Promise.all([
        supabase.from('finance_tax_groups').select('*').order('name'),
        supabase.from('finance_tax_rates').select('*'),
        supabase.from('finance_tax_group_rates').select('tax_group_id, tax_rate_id'),
      ]);
      if (gErr || rErr || lErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list tax groups.', 500);
      }
      const rateMap = new Map(((rates ?? []) as TaxRateRow[]).map((row) => [row.id, mapTaxRate(row)]));
      const byGroup = new Map<string, string[]>();
      for (const link of (links ?? []) as { tax_group_id: string; tax_rate_id: string }[]) {
        const list = byGroup.get(link.tax_group_id) ?? [];
        list.push(link.tax_rate_id);
        byGroup.set(link.tax_group_id, list);
      }
      return ((groups ?? []) as { id: string; name: string; is_active: boolean }[]).map((group) => {
        const rateIds = byGroup.get(group.id) ?? [];
        return {
          id: group.id,
          name: group.name,
          isActive: group.is_active,
          rateIds,
          rates: rateIds.map((id) => rateMap.get(id)).filter(Boolean) as FinanceTaxRate[],
        };
      });
    },

    async listTdsRates(actor: RequestUser): Promise<FinanceTdsRate[]> {
      if (!canManageTax(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view TDS rates.', 403);
      }
      const { data, error } = await supabase.from('finance_tds_rates').select('*').order('section');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list TDS rates.', 500);
      }
      return ((data ?? []) as { id: string; section: string; name: string; rate_percent: number | string; is_active: boolean }[]).map(
        (row) => ({
          id: row.id,
          section: row.section,
          name: row.name,
          ratePercent: Number(row.rate_percent),
          isActive: row.is_active,
        }),
      );
    },

    async listCustomers(actor: RequestUser): Promise<FinanceCustomer[]> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view customers.', 403);
      }
      const { data, error } = await supabase.from('finance_customers').select('*').order('display_name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list customers.', 500);
      }
      return ((data ?? []) as CustomerRow[]).map(mapCustomer);
    },

    async createCustomer(
      actor: RequestUser,
      input: CustomerWriteInput & { displayName: string },
      meta: RequestMeta,
    ): Promise<FinanceCustomer> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage customers.', 403);
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Customer name is required.', 400);
      }
      const patch = buildCustomerPatch({ ...input, displayName });
      const { data, error } = await supabase
        .from('finance_customers')
        .insert({
          display_name: displayName,
          company_name: (input.companyName ?? '').trim(),
          email: emptyToNull(input.email ?? null),
          phone: emptyToNull(input.phone ?? null),
          gstin: emptyToNull(input.gstin ?? null),
          pan: emptyToNull(input.pan ?? null),
          state_code: emptyToNull(input.stateCode ?? null),
          state_name: emptyToNull(input.stateName ?? null),
          billing_address: (patch.billing_address as string) ?? (input.billingAddress ?? '').trim(),
          shipping_address: (patch.shipping_address as string) ?? (input.shippingAddress ?? '').trim(),
          billing_line1: (patch.billing_line1 as string) ?? (input.billingLine1 ?? '').trim(),
          billing_line2: (patch.billing_line2 as string) ?? (input.billingLine2 ?? '').trim(),
          billing_city: (patch.billing_city as string) ?? (input.billingCity ?? '').trim(),
          billing_postal_code: (patch.billing_postal_code as string) ?? (input.billingPostalCode ?? '').trim(),
          billing_country: ((patch.billing_country as string) ?? (input.billingCountry ?? 'India')).trim() || 'India',
          shipping_line1: (patch.shipping_line1 as string) ?? (input.shippingLine1 ?? '').trim(),
          shipping_line2: (patch.shipping_line2 as string) ?? (input.shippingLine2 ?? '').trim(),
          shipping_city: (patch.shipping_city as string) ?? (input.shippingCity ?? '').trim(),
          shipping_state_code: emptyToNull(input.shippingStateCode ?? null),
          shipping_state_name: emptyToNull(input.shippingStateName ?? null),
          shipping_postal_code: (patch.shipping_postal_code as string) ?? (input.shippingPostalCode ?? '').trim(),
          shipping_country: ((patch.shipping_country as string) ?? (input.shippingCountry ?? 'India')).trim() || 'India',
          ship_to_contact_name: (input.shipToContactName ?? '').trim(),
          ship_to_company_name: (input.shipToCompanyName ?? '').trim(),
          payment_terms_days: input.paymentTermsDays ?? 0,
          notes: (input.notes ?? '').trim(),
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create customer.', 500);
      }
      const created = mapCustomer(data as CustomerRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_customer.create',
        entityType: 'finance_customer',
        entityId: created.id,
        newValues: { displayName },
        ...meta,
      });
      return created;
    },

    async updateCustomer(
      actor: RequestUser,
      id: string,
      input: CustomerWriteInput,
      meta: RequestMeta,
    ): Promise<FinanceCustomer> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage customers.', 403);
      }
      const { data: existing, error: existingErr } = await supabase
        .from('finance_customers')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (existingErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
      }

      const patch = buildCustomerPatch(input);
      if (Object.keys(patch).length === 0) {
        return mapCustomer(existing as CustomerRow);
      }

      // Recompute billing address with correct state when structured fields present
      if (
        patch.billing_line1 !== undefined ||
        patch.billing_line2 !== undefined ||
        patch.billing_city !== undefined ||
        patch.billing_postal_code !== undefined ||
        patch.billing_country !== undefined ||
        patch.state_name !== undefined
      ) {
        const next = { ...(existing as CustomerRow), ...patch } as CustomerRow;
        patch.billing_address = composePartyAddress({
          line1: next.billing_line1 ?? '',
          line2: next.billing_line2 ?? '',
          city: next.billing_city ?? '',
          stateName: next.state_name,
          postalCode: next.billing_postal_code ?? '',
          country: next.billing_country ?? 'India',
        });
      }
      if (
        patch.shipping_line1 !== undefined ||
        patch.shipping_line2 !== undefined ||
        patch.shipping_city !== undefined ||
        patch.shipping_postal_code !== undefined ||
        patch.shipping_country !== undefined ||
        patch.shipping_state_name !== undefined
      ) {
        const next = { ...(existing as CustomerRow), ...patch } as CustomerRow;
        patch.shipping_address = composePartyAddress({
          line1: next.shipping_line1 ?? '',
          line2: next.shipping_line2 ?? '',
          city: next.shipping_city ?? '',
          stateName: next.shipping_state_name ?? next.state_name,
          postalCode: next.shipping_postal_code ?? '',
          country: next.shipping_country ?? 'India',
        });
      }

      const historyRows: {
        customer_id: string;
        field_name: string;
        old_value: string | null;
        new_value: string | null;
        changed_by: string;
      }[] = [];
      for (const [key, newVal] of Object.entries(patch)) {
        const oldVal = (existing as Record<string, unknown>)[key];
        const oldStr = oldVal == null ? null : String(oldVal);
        const newStr = newVal == null ? null : String(newVal);
        if (oldStr === newStr) continue;
        historyRows.push({
          customer_id: id,
          field_name: CUSTOMER_FIELD_LABELS[key] ?? key,
          old_value: oldStr,
          new_value: newStr,
          changed_by: actor.employeeId,
        });
      }

      const { data, error } = await supabase
        .from('finance_customers')
        .update(patch)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update customer.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
      }
      if (historyRows.length) {
        const { error: histErr } = await supabase.from('finance_customer_change_history').insert(historyRows);
        if (histErr) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, histErr.message, 500);
        }
      }
      const updated = mapCustomer(data as CustomerRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_customer.update',
        entityType: 'finance_customer',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listCustomerChangeHistory(
      actor: RequestUser,
      customerId: string,
    ): Promise<FinanceCustomerChangeHistory[]> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view customer history.', 403);
      }
      const { data: customer } = await supabase.from('finance_customers').select('id').eq('id', customerId).maybeSingle();
      if (!customer) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
      const { data, error } = await supabase
        .from('finance_customer_change_history')
        .select('*')
        .eq('customer_id', customerId)
        .order('changed_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer history.', 500);
      }
      return ((data ?? []) as {
        id: string;
        customer_id: string;
        field_name: string;
        old_value: string | null;
        new_value: string | null;
        changed_by: string | null;
        changed_at: string;
      }[]).map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        fieldName: row.field_name,
        oldValue: row.old_value,
        newValue: row.new_value,
        changedBy: row.changed_by,
        changedAt: row.changed_at,
      }));
    },

    async listVendors(actor: RequestUser): Promise<FinanceVendor[]> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view vendors.', 403);
      }
      const { data, error } = await supabase.from('finance_vendors').select('*').order('display_name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list vendors.', 500);
      }
      return ((data ?? []) as VendorRow[]).map(mapVendor);
    },

    async createVendor(
      actor: RequestUser,
      input: {
        displayName: string;
        companyName?: string;
        email?: string | null;
        phone?: string | null;
        gstin?: string | null;
        pan?: string | null;
        stateCode?: string | null;
        stateName?: string | null;
        billingAddress?: string;
        paymentTermsDays?: number;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<FinanceVendor> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage vendors.', 403);
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor name is required.', 400);
      }
      const { data, error } = await supabase
        .from('finance_vendors')
        .insert({
          display_name: displayName,
          company_name: (input.companyName ?? '').trim(),
          email: emptyToNull(input.email ?? null),
          phone: emptyToNull(input.phone ?? null),
          gstin: emptyToNull(input.gstin ?? null),
          pan: emptyToNull(input.pan ?? null),
          state_code: emptyToNull(input.stateCode ?? null),
          state_name: emptyToNull(input.stateName ?? null),
          billing_address: (input.billingAddress ?? '').trim(),
          payment_terms_days: input.paymentTermsDays ?? 0,
          notes: (input.notes ?? '').trim(),
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create vendor.', 500);
      }
      const created = mapVendor(data as VendorRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_vendor.create',
        entityType: 'finance_vendor',
        entityId: created.id,
        newValues: { displayName },
        ...meta,
      });
      return created;
    },

    async updateVendor(
      actor: RequestUser,
      id: string,
      input: Partial<{
        displayName: string;
        companyName: string;
        email: string | null;
        phone: string | null;
        gstin: string | null;
        pan: string | null;
        stateCode: string | null;
        stateName: string | null;
        billingAddress: string;
        paymentTermsDays: number;
        status: 'active' | 'inactive';
        notes: string;
      }>,
      meta: RequestMeta,
    ): Promise<FinanceVendor> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage vendors.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.displayName !== undefined) patch.display_name = input.displayName.trim();
      if (input.companyName !== undefined) patch.company_name = input.companyName.trim();
      if (input.email !== undefined) patch.email = emptyToNull(input.email);
      if (input.phone !== undefined) patch.phone = emptyToNull(input.phone);
      if (input.gstin !== undefined) patch.gstin = emptyToNull(input.gstin);
      if (input.pan !== undefined) patch.pan = emptyToNull(input.pan);
      if (input.stateCode !== undefined) patch.state_code = emptyToNull(input.stateCode);
      if (input.stateName !== undefined) patch.state_name = emptyToNull(input.stateName);
      if (input.billingAddress !== undefined) patch.billing_address = input.billingAddress.trim();
      if (input.paymentTermsDays !== undefined) patch.payment_terms_days = input.paymentTermsDays;
      if (input.status !== undefined) patch.status = input.status;
      if (input.notes !== undefined) patch.notes = input.notes.trim();

      const { data, error } = await supabase.from('finance_vendors').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update vendor.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      }
      const updated = mapVendor(data as VendorRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_vendor.update',
        entityType: 'finance_vendor',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async deleteVendor(actor: RequestUser, id: string, meta: RequestMeta): Promise<{ id: string; mode: 'deleted' | 'deactivated' }> {
      if (!canManageParties(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage vendors.', 403);
      }
      const { data: existing, error: lookupError } = await supabase
        .from('finance_vendors')
        .select('id, display_name')
        .eq('id', id)
        .maybeSingle();
      if (lookupError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      }

      const { error: deleteError } = await supabase.from('finance_vendors').delete().eq('id', id);
      if (!deleteError) {
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance_vendor.delete',
          entityType: 'finance_vendor',
          entityId: id,
          oldValues: { displayName: existing.display_name },
          ...meta,
        });
        return { id, mode: 'deleted' };
      }

      // Referenced by purchase docs (ON DELETE RESTRICT) — deactivate instead of failing hard.
      if (deleteError.code === '23503') {
        const { error: deactivateError } = await supabase
          .from('finance_vendors')
          .update({ status: 'inactive' })
          .eq('id', id);
        if (deactivateError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to deactivate vendor.', 500);
        }
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance_vendor.deactivate',
          entityType: 'finance_vendor',
          entityId: id,
          newValues: { status: 'inactive' },
          ...meta,
        });
        return { id, mode: 'deactivated' };
      }

      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, deleteError.message || 'Failed to delete vendor.', 500);
    },

    async listItems(actor: RequestUser): Promise<FinanceItem[]> {
      if (!canManageItems(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view items.', 403);
      }
      const { data, error } = await supabase.from('finance_items').select('*').order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list items.', 500);
      }
      return ((data ?? []) as ItemRow[]).map(mapItem);
    },

    async createItem(
      actor: RequestUser,
      input: {
        code: string;
        name: string;
        itemType: 'goods' | 'service';
        hsnSac?: string | null;
        unit?: string;
        saleRate?: number;
        purchaseRate?: number;
        incomeAccountId?: string | null;
        expenseAccountId?: string | null;
        taxGroupId?: string | null;
        description?: string;
      },
      meta: RequestMeta,
    ): Promise<FinanceItem> {
      if (!canManageItems(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage items.', 403);
      }
      const code = input.code.trim();
      const name = input.name.trim();
      if (!code || !name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Item code and name are required.', 400);
      }
      const { data, error } = await supabase
        .from('finance_items')
        .insert({
          code,
          name,
          item_type: input.itemType,
          hsn_sac: emptyToNull(input.hsnSac ?? null),
          unit: (input.unit ?? 'nos').trim() || 'nos',
          sale_rate: input.saleRate ?? 0,
          purchase_rate: input.purchaseRate ?? 0,
          income_account_id: input.incomeAccountId ?? null,
          expense_account_id: input.expenseAccountId ?? null,
          tax_group_id: input.taxGroupId ?? null,
          description: (input.description ?? '').trim(),
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An item with this code already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create item.', 500);
      }
      const created = mapItem(data as ItemRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_item.create',
        entityType: 'finance_item',
        entityId: created.id,
        newValues: { code, name, itemType: input.itemType },
        ...meta,
      });
      return created;
    },

    async updateItem(
      actor: RequestUser,
      id: string,
      input: Partial<{
        name: string;
        hsnSac: string | null;
        unit: string;
        saleRate: number;
        purchaseRate: number;
        incomeAccountId: string | null;
        expenseAccountId: string | null;
        taxGroupId: string | null;
        description: string;
        status: 'active' | 'inactive';
      }>,
      meta: RequestMeta,
    ): Promise<FinanceItem> {
      if (!canManageItems(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage items.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.hsnSac !== undefined) patch.hsn_sac = emptyToNull(input.hsnSac);
      if (input.unit !== undefined) patch.unit = input.unit.trim() || 'nos';
      if (input.saleRate !== undefined) patch.sale_rate = input.saleRate;
      if (input.purchaseRate !== undefined) patch.purchase_rate = input.purchaseRate;
      if (input.incomeAccountId !== undefined) patch.income_account_id = input.incomeAccountId;
      if (input.expenseAccountId !== undefined) patch.expense_account_id = input.expenseAccountId;
      if (input.taxGroupId !== undefined) patch.tax_group_id = input.taxGroupId;
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.status !== undefined) patch.status = input.status;

      const { data, error } = await supabase.from('finance_items').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update item.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Item not found.', 404);
      }
      const updated = mapItem(data as ItemRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_item.update',
        entityType: 'finance_item',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listSeries(actor: RequestUser): Promise<FinanceNumberSeries[]> {
      if (!canManageSeries(actor) && !canManageFinanceOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view number series.', 403);
      }
      const { data, error } = await supabase.from('finance_number_series').select('*').order('document_type');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list number series.', 500);
      }
      return ((data ?? []) as SeriesRow[]).map(mapSeries);
    },

    async updateSeries(
      actor: RequestUser,
      id: string,
      input: Partial<{ prefix: string; padLength: number; nextNumber: number; resetYearly: boolean }>,
      meta: RequestMeta,
    ): Promise<FinanceNumberSeries> {
      if (!canManageSeries(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage number series.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.prefix !== undefined) patch.prefix = input.prefix.trim().toUpperCase();
      if (input.padLength !== undefined) patch.pad_length = input.padLength;
      if (input.nextNumber !== undefined) {
        if (input.nextNumber < 1) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Next number must be at least 1.', 400);
        }
        patch.next_number = input.nextNumber;
      }
      if (input.resetYearly !== undefined) patch.reset_yearly = input.resetYearly;

      const { data, error } = await supabase.from('finance_number_series').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update number series.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Number series not found.', 404);
      }
      const updated = mapSeries(data as SeriesRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance_number_series.update',
        entityType: 'finance_number_series',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },
  };
}
