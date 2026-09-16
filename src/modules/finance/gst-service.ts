import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageGst, canViewGst, type RequestMeta } from './access';
import type {
  GstHsnSummaryRow,
  GstInwardRow,
  GstItcRow,
  GstOutwardRow,
  GstPeriodSummary,
  GstValidationIssue,
  GstWorkbookExport,
  TdsDeductionRow,
} from './gst-types';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

const POSTED_BILL_STATUSES = ['posted', 'partially_paid', 'paid'] as const;

type OrgSnapshot = {
  stateCode: string | null;
  gstin: string | null;
};

type PartySnapshot = {
  id: string;
  displayName: string | null;
  gstin: string | null;
  stateCode: string | null;
};

type InvoiceDoc = {
  id: string;
  document_number: string;
  invoice_date: string;
  customer_id: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  place_of_supply_state: string | null;
  is_intra_state: boolean | null;
  journal_id: string | null;
};

type CreditNoteDoc = {
  id: string;
  document_number: string;
  credit_date: string;
  customer_id: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  place_of_supply_state: string | null;
  is_intra_state: boolean | null;
  status: string;
};

type BillDoc = {
  id: string;
  document_number: string;
  bill_date: string;
  vendor_id: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  place_of_supply_state: string | null;
  is_intra_state: boolean | null;
  tds_section: string;
  tds_percent: number | string;
  tds_amount: number | string;
  itc_eligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed';
  status: string;
};

type LineHsnRow = {
  parentId: string;
  amount: number;
  taxAmount: number;
  hsnSac: string;
  itemId: string | null;
  isIntraState: boolean;
};

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireView(actor: RequestUser): void {
  if (!canViewGst(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view GST data.', 403);
  }
}

function requireManage(actor: RequestUser): void {
  if (!canManageGst(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage GST data.', 403);
  }
}

export function splitTax(
  taxTotal: number,
  isIntraState: boolean,
): { cgst: number; sgst: number; igst: number } {
  const tax = round2(taxTotal);
  if (isIntraState) {
    const half = round2(tax / 2);
    return { cgst: half, sgst: round2(tax - half), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: tax };
}

export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const escape = (value: string | number | null | undefined): string => {
    const text = value == null ? '' : String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
}

function periodBounds(periodYear: number, periodMonth: number): { fromDate: string; toDate: string } {
  if (!Number.isInteger(periodYear) || periodYear < 2000 || periodYear > 2100) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'periodYear is invalid.', 400);
  }
  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'periodMonth must be 1–12.', 400);
  }
  const mm = String(periodMonth).padStart(2, '0');
  const fromDate = `${periodYear}-${mm}-01`;
  const lastDay = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
  const toDate = `${periodYear}-${mm}-${String(lastDay).padStart(2, '0')}`;
  return { fromDate, toDate };
}

function requireDateRange(fromDate?: string, toDate?: string): { fromDate: string; toDate: string } {
  if (!fromDate || !toDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'fromDate and toDate are required.', 400);
  }
  if (fromDate > toDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'fromDate must be on or before toDate.', 400);
  }
  return { fromDate, toDate };
}

function collectIssues(input: {
  orgState: string | null;
  partyState: string | null;
  partyGstin: string | null;
  taxTotal: number;
  hasMissingHsn: boolean;
}): GstValidationIssue[] {
  const issues: GstValidationIssue[] = [];
  if (!input.orgState?.trim()) {
    issues.push({ code: 'missing_org_state', message: 'Organization state code is missing.' });
  }
  if (!input.partyState?.trim()) {
    issues.push({ code: 'missing_party_state', message: 'Party state code is missing.' });
  }
  if (input.taxTotal > 0 && !input.partyGstin?.trim()) {
    issues.push({ code: 'missing_gstin', message: 'Party GSTIN is required when tax is charged.' });
  }
  if (input.hasMissingHsn) {
    issues.push({ code: 'missing_hsn', message: 'One or more lines are missing HSN/SAC.' });
  }
  return issues;
}

function resolveIntraState(
  stored: boolean | null | undefined,
  orgState: string | null,
  partyState: string | null,
): boolean {
  if (typeof stored === 'boolean') return stored;
  return Boolean(orgState && partyState && orgState === partyState);
}

function itcAmountFor(eligibility: string, taxTotal: number): number {
  if (eligibility === 'eligible' || eligibility === 'claimed') {
    return round2(taxTotal);
  }
  return 0;
}

async function loadOrg(supabase: SupabaseClient): Promise<OrgSnapshot> {
  const { data, error } = await supabase
    .from('finance_organizations')
    .select('state_code, gstin')
    .eq('id', ORG_ID)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load organization.', 500);
  }
  return {
    stateCode: (data?.state_code as string | null) ?? null,
    gstin: (data?.gstin as string | null) ?? null,
  };
}

async function loadCustomers(supabase: SupabaseClient, ids: string[]): Promise<Map<string, PartySnapshot>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('finance_customers')
    .select('id, display_name, gstin, state_code')
    .in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customers.', 500);
  }
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        id: row.id as string,
        displayName: (row.display_name as string | null) ?? null,
        gstin: (row.gstin as string | null) ?? null,
        stateCode: (row.state_code as string | null) ?? null,
      },
    ]),
  );
}

async function loadVendors(supabase: SupabaseClient, ids: string[]): Promise<Map<string, PartySnapshot>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('finance_vendors')
    .select('id, display_name, gstin, state_code')
    .in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendors.', 500);
  }
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        id: row.id as string,
        displayName: (row.display_name as string | null) ?? null,
        gstin: (row.gstin as string | null) ?? null,
        stateCode: (row.state_code as string | null) ?? null,
      },
    ]),
  );
}

async function loadItemHsnMap(supabase: SupabaseClient, itemIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(itemIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('finance_items').select('id, hsn_sac').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load item HSN codes.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, ((row.hsn_sac as string) ?? '').trim()]));
}

async function linesMissingHsn(
  supabase: SupabaseClient,
  table: 'finance_invoice_lines' | 'finance_credit_note_lines' | 'finance_vendor_bill_lines',
  parentColumn: 'invoice_id' | 'credit_note_id' | 'bill_id',
  parentIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(parentIds.filter(Boolean))];
  const missing = new Set<string>();
  if (!unique.length) return missing;

  const { data, error } = await supabase.from(table).select(`${parentColumn}, hsn_sac, item_id`).in(parentColumn, unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load document lines for HSN checks.', 500);
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const itemIds = rows.map((row) => (row.item_id as string | null) ?? null).filter(Boolean) as string[];
  const itemHsn = await loadItemHsnMap(supabase, itemIds);

  for (const row of rows) {
    const parentId = row[parentColumn] as string;
    const lineHsn = ((row.hsn_sac as string) ?? '').trim();
    const fromItem = row.item_id ? itemHsn.get(row.item_id as string) ?? '' : '';
    if (!lineHsn && !fromItem) {
      missing.add(parentId);
    }
  }
  return missing;
}

async function fetchPostedInvoices(
  supabase: SupabaseClient,
  fromDate: string,
  toDate: string,
): Promise<InvoiceDoc[]> {
  const { data, error } = await supabase
    .from('finance_invoices')
    .select(
      'id, document_number, invoice_date, customer_id, subtotal, tax_total, grand_total, place_of_supply_state, is_intra_state, journal_id',
    )
    .not('journal_id', 'is', null)
    .gte('invoice_date', fromDate)
    .lte('invoice_date', toDate)
    .order('invoice_date', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices for GST.', 500);
  }
  return (data ?? []) as InvoiceDoc[];
}

async function fetchPostedCreditNotes(
  supabase: SupabaseClient,
  fromDate: string,
  toDate: string,
): Promise<CreditNoteDoc[]> {
  const { data, error } = await supabase
    .from('finance_credit_notes')
    .select(
      'id, document_number, credit_date, customer_id, subtotal, tax_total, grand_total, place_of_supply_state, is_intra_state, status',
    )
    .eq('status', 'posted')
    .gte('credit_date', fromDate)
    .lte('credit_date', toDate)
    .order('credit_date', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load credit notes for GST.', 500);
  }
  return (data ?? []) as CreditNoteDoc[];
}

async function fetchPostedBills(
  supabase: SupabaseClient,
  fromDate: string,
  toDate: string,
): Promise<BillDoc[]> {
  const { data, error } = await supabase
    .from('finance_vendor_bills')
    .select(
      'id, document_number, bill_date, vendor_id, subtotal, tax_total, grand_total, place_of_supply_state, is_intra_state, tds_section, tds_percent, tds_amount, itc_eligibility, status',
    )
    .in('status', [...POSTED_BILL_STATUSES])
    .gte('bill_date', fromDate)
    .lte('bill_date', toDate)
    .order('bill_date', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor bills for GST.', 500);
  }
  return (data ?? []) as BillDoc[];
}

function mapOutwardInvoice(
  doc: InvoiceDoc,
  customer: PartySnapshot | undefined,
  org: OrgSnapshot,
  missingHsn: boolean,
): GstOutwardRow {
  const taxableValue = round2(num(doc.subtotal));
  const taxTotal = round2(num(doc.tax_total));
  const partyState = doc.place_of_supply_state ?? customer?.stateCode ?? null;
  const isIntra = resolveIntraState(doc.is_intra_state, org.stateCode, partyState ?? customer?.stateCode ?? null);
  const split = splitTax(taxTotal, isIntra);
  const gstin = customer?.gstin ?? null;
  return {
    documentType: 'invoice',
    documentId: doc.id,
    documentNumber: doc.document_number,
    documentDate: doc.invoice_date,
    customerId: doc.customer_id,
    customerName: customer?.displayName ?? null,
    customerGstin: gstin,
    placeOfSupplyState: partyState,
    isIntraState: isIntra,
    supplyType: gstin?.trim() ? 'B2B' : 'B2C',
    taxableValue,
    cgst: split.cgst,
    sgst: split.sgst,
    igst: split.igst,
    taxTotal,
    grandTotal: round2(num(doc.grand_total)),
    signedTaxableValue: taxableValue,
    signedTaxTotal: taxTotal,
    issues: collectIssues({
      orgState: org.stateCode,
      partyState: customer?.stateCode ?? partyState,
      partyGstin: gstin,
      taxTotal,
      hasMissingHsn: missingHsn,
    }),
  };
}

function mapOutwardCreditNote(
  doc: CreditNoteDoc,
  customer: PartySnapshot | undefined,
  org: OrgSnapshot,
  missingHsn: boolean,
): GstOutwardRow {
  const taxableValue = round2(num(doc.subtotal));
  const taxTotal = round2(num(doc.tax_total));
  const partyState = doc.place_of_supply_state ?? customer?.stateCode ?? null;
  const isIntra = resolveIntraState(doc.is_intra_state, org.stateCode, partyState ?? customer?.stateCode ?? null);
  const split = splitTax(taxTotal, isIntra);
  const gstin = customer?.gstin ?? null;
  return {
    documentType: 'credit_note',
    documentId: doc.id,
    documentNumber: doc.document_number,
    documentDate: doc.credit_date,
    customerId: doc.customer_id,
    customerName: customer?.displayName ?? null,
    customerGstin: gstin,
    placeOfSupplyState: partyState,
    isIntraState: isIntra,
    supplyType: gstin?.trim() ? 'B2B' : 'B2C',
    taxableValue,
    cgst: split.cgst,
    sgst: split.sgst,
    igst: split.igst,
    taxTotal,
    grandTotal: round2(num(doc.grand_total)),
    signedTaxableValue: round2(-taxableValue),
    signedTaxTotal: round2(-taxTotal),
    issues: collectIssues({
      orgState: org.stateCode,
      partyState: customer?.stateCode ?? partyState,
      partyGstin: gstin,
      taxTotal,
      hasMissingHsn: missingHsn,
    }),
  };
}

function mapInwardBill(
  doc: BillDoc,
  vendor: PartySnapshot | undefined,
  org: OrgSnapshot,
  missingHsn: boolean,
): GstInwardRow {
  const taxableValue = round2(num(doc.subtotal));
  const taxTotal = round2(num(doc.tax_total));
  const partyState = doc.place_of_supply_state ?? vendor?.stateCode ?? null;
  const isIntra = resolveIntraState(doc.is_intra_state, org.stateCode, partyState ?? vendor?.stateCode ?? null);
  const split = splitTax(taxTotal, isIntra);
  const eligibility = doc.itc_eligibility ?? 'eligible';
  const gstin = vendor?.gstin ?? null;
  return {
    documentType: 'vendor_bill',
    documentId: doc.id,
    documentNumber: doc.document_number,
    documentDate: doc.bill_date,
    vendorId: doc.vendor_id,
    vendorName: vendor?.displayName ?? null,
    vendorGstin: gstin,
    placeOfSupplyState: partyState,
    isIntraState: isIntra,
    taxableValue,
    cgst: split.cgst,
    sgst: split.sgst,
    igst: split.igst,
    taxTotal,
    grandTotal: round2(num(doc.grand_total)),
    tdsSection: doc.tds_section ?? '',
    tdsPercent: num(doc.tds_percent),
    tdsAmount: round2(num(doc.tds_amount)),
    itcEligibility: eligibility,
    itcAmount: itcAmountFor(eligibility, taxTotal),
    issues: collectIssues({
      orgState: org.stateCode,
      partyState: vendor?.stateCode ?? partyState,
      partyGstin: gstin,
      taxTotal,
      hasMissingHsn: missingHsn,
    }),
  };
}

async function loadHsnLines(
  supabase: SupabaseClient,
  table: 'finance_invoice_lines' | 'finance_credit_note_lines' | 'finance_vendor_bill_lines',
  parentColumn: 'invoice_id' | 'credit_note_id' | 'bill_id',
  parents: Array<{ id: string; isIntraState: boolean }>,
  sign: 1 | -1,
): Promise<LineHsnRow[]> {
  if (!parents.length) return [];
  const parentMap = new Map(parents.map((p) => [p.id, p.isIntraState]));
  const { data, error } = await supabase
    .from(table)
    .select(`${parentColumn}, amount, tax_amount, hsn_sac, item_id`)
    .in(
      parentColumn,
      parents.map((p) => p.id),
    );
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load HSN lines.', 500);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    parentId: row[parentColumn] as string,
    amount: round2(sign * num(row.amount as number | string)),
    taxAmount: round2(sign * num(row.tax_amount as number | string)),
    hsnSac: ((row.hsn_sac as string) ?? '').trim(),
    itemId: (row.item_id as string | null) ?? null,
    isIntraState: parentMap.get(row[parentColumn] as string) ?? false,
  }));
}

export function createGstService(supabase: SupabaseClient) {
  return {
    async getOutwardRegister(actor: RequestUser, range: { fromDate: string; toDate: string }): Promise<GstOutwardRow[]> {
      requireView(actor);
      const { fromDate, toDate } = requireDateRange(range.fromDate, range.toDate);
      const org = await loadOrg(supabase);
      const [invoices, creditNotes] = await Promise.all([
        fetchPostedInvoices(supabase, fromDate, toDate),
        fetchPostedCreditNotes(supabase, fromDate, toDate),
      ]);
      const customers = await loadCustomers(supabase, [
        ...invoices.map((row) => row.customer_id),
        ...creditNotes.map((row) => row.customer_id),
      ]);
      const [invoiceMissingHsn, creditMissingHsn] = await Promise.all([
        linesMissingHsn(
          supabase,
          'finance_invoice_lines',
          'invoice_id',
          invoices.map((row) => row.id),
        ),
        linesMissingHsn(
          supabase,
          'finance_credit_note_lines',
          'credit_note_id',
          creditNotes.map((row) => row.id),
        ),
      ]);

      const rows: GstOutwardRow[] = [
        ...invoices.map((doc) =>
          mapOutwardInvoice(doc, customers.get(doc.customer_id), org, invoiceMissingHsn.has(doc.id)),
        ),
        ...creditNotes.map((doc) =>
          mapOutwardCreditNote(doc, customers.get(doc.customer_id), org, creditMissingHsn.has(doc.id)),
        ),
      ];
      rows.sort((a, b) => a.documentDate.localeCompare(b.documentDate) || a.documentNumber.localeCompare(b.documentNumber));
      return rows;
    },

    async getInwardRegister(actor: RequestUser, range: { fromDate: string; toDate: string }): Promise<GstInwardRow[]> {
      requireView(actor);
      const { fromDate, toDate } = requireDateRange(range.fromDate, range.toDate);
      const org = await loadOrg(supabase);
      const bills = await fetchPostedBills(supabase, fromDate, toDate);
      const vendors = await loadVendors(
        supabase,
        bills.map((row) => row.vendor_id),
      );
      const missingHsn = await linesMissingHsn(
        supabase,
        'finance_vendor_bill_lines',
        'bill_id',
        bills.map((row) => row.id),
      );
      return bills.map((doc) => mapInwardBill(doc, vendors.get(doc.vendor_id), org, missingHsn.has(doc.id)));
    },

    async getItcTracker(actor: RequestUser, range: { fromDate: string; toDate: string }): Promise<GstItcRow[]> {
      requireView(actor);
      const inward = await this.getInwardRegister(actor, range);
      return inward.map((row) => ({
        billId: row.documentId,
        documentNumber: row.documentNumber,
        billDate: row.documentDate,
        vendorName: row.vendorName,
        vendorGstin: row.vendorGstin,
        taxableValue: row.taxableValue,
        cgst: row.cgst,
        sgst: row.sgst,
        igst: row.igst,
        itcEligibility: row.itcEligibility,
        itcAmount: row.itcAmount,
      }));
    },

    async getPeriodSummary(
      actor: RequestUser,
      range: { fromDate: string; toDate: string },
    ): Promise<GstPeriodSummary> {
      requireView(actor);
      const { fromDate, toDate } = requireDateRange(range.fromDate, range.toDate);
      const [outward, inward] = await Promise.all([
        this.getOutwardRegister(actor, { fromDate, toDate }),
        this.getInwardRegister(actor, { fromDate, toDate }),
      ]);

      const outwardTaxable = round2(outward.reduce((sum, row) => sum + row.signedTaxableValue, 0));
      const outwardTax = round2(outward.reduce((sum, row) => sum + row.signedTaxTotal, 0));
      const inwardTaxable = round2(inward.reduce((sum, row) => sum + row.taxableValue, 0));
      const inwardTax = round2(inward.reduce((sum, row) => sum + row.taxTotal, 0));
      const itcEligible = round2(
        inward.filter((row) => row.itcEligibility === 'eligible').reduce((sum, row) => sum + row.itcAmount, 0),
      );
      const itcClaimed = round2(
        inward.filter((row) => row.itcEligibility === 'claimed').reduce((sum, row) => sum + row.itcAmount, 0),
      );
      const tdsDeducted = round2(inward.reduce((sum, row) => sum + row.tdsAmount, 0));

      return {
        fromDate,
        toDate,
        outwardTaxable,
        outwardTax,
        inwardTaxable,
        inwardTax,
        itcEligible,
        itcClaimed,
        netGstLiability: round2(outwardTax - itcEligible - itcClaimed),
        tdsDeducted,
      };
    },

    async getHsnSummary(actor: RequestUser, range: { fromDate: string; toDate: string }): Promise<GstHsnSummaryRow[]> {
      requireView(actor);
      const { fromDate, toDate } = requireDateRange(range.fromDate, range.toDate);
      const org = await loadOrg(supabase);
      const [invoices, creditNotes, bills] = await Promise.all([
        fetchPostedInvoices(supabase, fromDate, toDate),
        fetchPostedCreditNotes(supabase, fromDate, toDate),
        fetchPostedBills(supabase, fromDate, toDate),
      ]);
      const [customers, vendors] = await Promise.all([
        loadCustomers(
          supabase,
          [...invoices, ...creditNotes].map((row) => row.customer_id),
        ),
        loadVendors(
          supabase,
          bills.map((row) => row.vendor_id),
        ),
      ]);

      const invoiceParents = invoices.map((doc) => {
        const customer = customers.get(doc.customer_id);
        const partyState = doc.place_of_supply_state ?? customer?.stateCode ?? null;
        return {
          id: doc.id,
          isIntraState: resolveIntraState(doc.is_intra_state, org.stateCode, partyState),
        };
      });
      const creditParents = creditNotes.map((doc) => {
        const customer = customers.get(doc.customer_id);
        const partyState = doc.place_of_supply_state ?? customer?.stateCode ?? null;
        return {
          id: doc.id,
          isIntraState: resolveIntraState(doc.is_intra_state, org.stateCode, partyState),
        };
      });
      const billParents = bills.map((doc) => {
        const vendor = vendors.get(doc.vendor_id);
        const partyState = doc.place_of_supply_state ?? vendor?.stateCode ?? null;
        return {
          id: doc.id,
          isIntraState: resolveIntraState(doc.is_intra_state, org.stateCode, partyState),
        };
      });

      const [invoiceLines, creditLines, billLines] = await Promise.all([
        loadHsnLines(supabase, 'finance_invoice_lines', 'invoice_id', invoiceParents, 1),
        loadHsnLines(supabase, 'finance_credit_note_lines', 'credit_note_id', creditParents, -1),
        loadHsnLines(supabase, 'finance_vendor_bill_lines', 'bill_id', billParents, 1),
      ]);

      const itemIds = [...invoiceLines, ...creditLines, ...billLines]
        .map((line) => line.itemId)
        .filter(Boolean) as string[];
      const itemHsn = await loadItemHsnMap(supabase, itemIds);

      const buckets = new Map<string, GstHsnSummaryRow>();

      const addLines = (lines: LineHsnRow[], direction: 'outward' | 'inward') => {
        for (const line of lines) {
          const hsnSac = line.hsnSac || (line.itemId ? itemHsn.get(line.itemId) ?? '' : '') || 'UNKNOWN';
          const split = splitTax(line.taxAmount < 0 ? -line.taxAmount : line.taxAmount, line.isIntraState);
          const signedSplit =
            line.taxAmount < 0
              ? { cgst: -split.cgst, sgst: -split.sgst, igst: -split.igst }
              : split;
          const key = `${direction}:${hsnSac}`;
          const existing = buckets.get(key);
          if (existing) {
            existing.taxableValue = round2(existing.taxableValue + line.amount);
            existing.cgst = round2(existing.cgst + signedSplit.cgst);
            existing.sgst = round2(existing.sgst + signedSplit.sgst);
            existing.igst = round2(existing.igst + signedSplit.igst);
            existing.taxTotal = round2(existing.taxTotal + line.taxAmount);
            existing.lineCount += 1;
          } else {
            buckets.set(key, {
              hsnSac,
              direction,
              taxableValue: line.amount,
              cgst: signedSplit.cgst,
              sgst: signedSplit.sgst,
              igst: signedSplit.igst,
              taxTotal: line.taxAmount,
              lineCount: 1,
            });
          }
        }
      };

      addLines([...invoiceLines, ...creditLines], 'outward');
      addLines(billLines, 'inward');

      return [...buckets.values()].sort((a, b) => {
        if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
        return a.hsnSac.localeCompare(b.hsnSac);
      });
    },

    async exportGstr1Workbook(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number },
    ): Promise<GstWorkbookExport> {
      requireView(actor);
      const { fromDate, toDate } = periodBounds(input.periodYear, input.periodMonth);
      const outward = await this.getOutwardRegister(actor, { fromDate, toDate });
      const invoices = outward.filter((row) => row.documentType === 'invoice');
      const creditNotes = outward.filter((row) => row.documentType === 'credit_note');
      const b2b = invoices.filter((row) => row.supplyType === 'B2B');
      const b2c = invoices.filter((row) => row.supplyType === 'B2C');

      const sections: string[] = [];
      const header = [
        'Section',
        'GSTIN',
        'Party',
        'Invoice/Note No',
        'Date',
        'Place of Supply',
        'Taxable Value',
        'CGST',
        'SGST',
        'IGST',
        'Tax Total',
        'Grand Total',
      ];

      const pushSection = (section: string, rows: GstOutwardRow[]) => {
        sections.push(`# ${section}`);
        sections.push(
          toCsv(
            header,
            rows.map((row) => [
              section,
              row.customerGstin,
              row.customerName,
              row.documentNumber,
              row.documentDate,
              row.placeOfSupplyState,
              row.signedTaxableValue,
              row.documentType === 'credit_note' ? -row.cgst : row.cgst,
              row.documentType === 'credit_note' ? -row.sgst : row.sgst,
              row.documentType === 'credit_note' ? -row.igst : row.igst,
              row.signedTaxTotal,
              row.documentType === 'credit_note' ? -row.grandTotal : row.grandTotal,
            ]),
          ),
        );
      };

      pushSection('B2B', b2b);
      sections.push('');
      pushSection('B2C', b2c);
      sections.push('');
      pushSection('Credit notes', creditNotes);

      const csv = sections.join('\n');
      const rowCount = b2b.length + b2c.length + creditNotes.length;
      const mm = String(input.periodMonth).padStart(2, '0');
      return {
        filename: `gstr1_${input.periodYear}-${mm}.csv`,
        contentType: 'text/csv; charset=utf-8',
        csv,
        rowCount,
      };
    },

    async exportGstr2bWorkbook(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number },
    ): Promise<GstWorkbookExport> {
      requireView(actor);
      const { fromDate, toDate } = periodBounds(input.periodYear, input.periodMonth);
      const inward = await this.getInwardRegister(actor, { fromDate, toDate });
      const csv = toCsv(
        [
          'Supplier GSTIN',
          'Supplier Name',
          'Bill No',
          'Bill Date',
          'Place of Supply',
          'Taxable Value',
          'CGST',
          'SGST',
          'IGST',
          'Tax Total',
          'ITC Eligibility',
          'ITC Amount',
          'TDS Section',
          'TDS Amount',
        ],
        inward.map((row) => [
          row.vendorGstin,
          row.vendorName,
          row.documentNumber,
          row.documentDate,
          row.placeOfSupplyState,
          row.taxableValue,
          row.cgst,
          row.sgst,
          row.igst,
          row.taxTotal,
          row.itcEligibility,
          row.itcAmount,
          row.tdsSection,
          row.tdsAmount,
        ]),
      );
      const mm = String(input.periodMonth).padStart(2, '0');
      return {
        filename: `gstr2b_${input.periodYear}-${mm}.csv`,
        contentType: 'text/csv; charset=utf-8',
        csv,
        rowCount: inward.length,
      };
    },

    async listTdsDeductions(
      actor: RequestUser,
      range: { fromDate: string; toDate: string },
    ): Promise<TdsDeductionRow[]> {
      requireView(actor);
      const { fromDate, toDate } = requireDateRange(range.fromDate, range.toDate);
      const { data, error } = await supabase
        .from('finance_vendor_bills')
        .select('id, document_number, bill_date, vendor_id, subtotal, tds_section, tds_percent, tds_amount, status')
        .gt('tds_amount', 0)
        .gte('bill_date', fromDate)
        .lte('bill_date', toDate)
        .order('bill_date', { ascending: true });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load TDS deductions.', 500);
      }
      const rows = (data ?? []) as Array<{
        id: string;
        document_number: string;
        bill_date: string;
        vendor_id: string;
        subtotal: number | string;
        tds_section: string;
        tds_percent: number | string;
        tds_amount: number | string;
        status: string;
      }>;
      const vendors = await loadVendors(
        supabase,
        rows.map((row) => row.vendor_id),
      );
      return rows.map((row) => ({
        billId: row.id,
        documentNumber: row.document_number,
        billDate: row.bill_date,
        vendorName: vendors.get(row.vendor_id)?.displayName ?? null,
        tdsSection: row.tds_section ?? '',
        tdsPercent: num(row.tds_percent),
        taxableValue: round2(num(row.subtotal)),
        tdsAmount: round2(num(row.tds_amount)),
        status: row.status,
      }));
    },

    async applyBillTds(
      actor: RequestUser,
      billId: string,
      input: { tdsSection: string; tdsPercent: number },
      meta: RequestMeta,
    ): Promise<TdsDeductionRow> {
      requireManage(actor);
      const section = input.tdsSection?.trim() ?? '';
      if (!section) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'tdsSection is required.', 400);
      }
      if (!(input.tdsPercent >= 0) || input.tdsPercent > 100) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'tdsPercent must be between 0 and 100.', 400);
      }

      const { data: bill, error } = await supabase
        .from('finance_vendor_bills')
        .select('id, document_number, bill_date, vendor_id, subtotal, status, tds_section, tds_percent, tds_amount')
        .eq('id', billId)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor bill.', 500);
      }
      if (!bill) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor bill not found.', 404);
      }
      if ((bill.status as string) !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'TDS can only be applied to draft bills.', 400);
      }

      const subtotal = round2(num(bill.subtotal as number | string));
      const tdsAmount = round2(subtotal * (input.tdsPercent / 100));
      const { error: updateError } = await supabase
        .from('finance_vendor_bills')
        .update({
          tds_section: section,
          tds_percent: input.tdsPercent,
          tds_amount: tdsAmount,
        })
        .eq('id', billId);
      if (updateError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updateError.message, 500);
      }

      const vendors = await loadVendors(supabase, [bill.vendor_id as string]);
      const result: TdsDeductionRow = {
        billId: bill.id as string,
        documentNumber: bill.document_number as string,
        billDate: bill.bill_date as string,
        vendorName: vendors.get(bill.vendor_id as string)?.displayName ?? null,
        tdsSection: section,
        tdsPercent: input.tdsPercent,
        taxableValue: subtotal,
        tdsAmount,
        status: 'draft',
      };

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.gst.bill_tds.apply',
        entityType: 'finance_vendor_bill',
        entityId: billId,
        oldValues: {
          tdsSection: bill.tds_section,
          tdsPercent: num(bill.tds_percent as number | string),
          tdsAmount: num(bill.tds_amount as number | string),
        },
        newValues: {
          tdsSection: section,
          tdsPercent: input.tdsPercent,
          tdsAmount,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return result;
    },

    async setBillItcEligibility(
      actor: RequestUser,
      billId: string,
      input: { itcEligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed' },
      meta: RequestMeta,
    ): Promise<GstItcRow> {
      requireManage(actor);
      const allowed = ['eligible', 'ineligible', 'claimed', 'reversed'] as const;
      if (!allowed.includes(input.itcEligibility)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'itcEligibility is invalid.', 400);
      }

      const { data: bill, error } = await supabase
        .from('finance_vendor_bills')
        .select(
          'id, document_number, bill_date, vendor_id, subtotal, tax_total, place_of_supply_state, is_intra_state, itc_eligibility, status',
        )
        .eq('id', billId)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor bill.', 500);
      }
      if (!bill) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor bill not found.', 404);
      }

      const { error: updateError } = await supabase
        .from('finance_vendor_bills')
        .update({ itc_eligibility: input.itcEligibility })
        .eq('id', billId);
      if (updateError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updateError.message, 500);
      }

      const org = await loadOrg(supabase);
      const vendors = await loadVendors(supabase, [bill.vendor_id as string]);
      const vendor = vendors.get(bill.vendor_id as string);
      const taxTotal = round2(num(bill.tax_total as number | string));
      const partyState =
        ((bill.place_of_supply_state as string | null) ?? vendor?.stateCode ?? null);
      const isIntra = resolveIntraState(
        bill.is_intra_state as boolean | null,
        org.stateCode,
        partyState,
      );
      const split = splitTax(taxTotal, isIntra);

      const result: GstItcRow = {
        billId: bill.id as string,
        documentNumber: bill.document_number as string,
        billDate: bill.bill_date as string,
        vendorName: vendor?.displayName ?? null,
        vendorGstin: vendor?.gstin ?? null,
        taxableValue: round2(num(bill.subtotal as number | string)),
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        itcEligibility: input.itcEligibility,
        itcAmount: itcAmountFor(input.itcEligibility, taxTotal),
      };

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.gst.bill_itc.set',
        entityType: 'finance_vendor_bill',
        entityId: billId,
        oldValues: { itcEligibility: bill.itc_eligibility },
        newValues: { itcEligibility: input.itcEligibility },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return result;
    },
  };
}
