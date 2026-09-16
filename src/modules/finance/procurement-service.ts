import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  canApplyIndent,
  canApproveIndent,
  canManagePurchase,
  canViewPurchase,
  type RequestMeta,
} from './access';
import { postVendorBillJournal, postVendorCreditJournal, postVendorPaymentJournal } from './posting';
import type {
  IndentLineInput,
  PoLineInput,
  PurchaseIndent,
  PurchaseOrder,
  PurchaseOrderPrint,
  PurchaseReceipt,
  Rfq,
  VendorBill,
  VendorCredit,
  VendorPayment,
  VendorQuote,
} from './procurement-types';
import { allocateDocumentNumber, lineAmount } from './series-allocate';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type IndentRow = {
  id: string;
  document_number: string;
  requested_by: string;
  department_id: string | null;
  required_date: string | null;
  priority: PurchaseIndent['priority'];
  purpose: string;
  justification: string;
  status: PurchaseIndent['status'];
  estimated_total: number | string;
  reviewer_id: string | null;
  reviewer_comment: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

type IndentLineRow = {
  id: string;
  indent_id: string;
  line_order: number;
  item_id: string | null;
  description: string;
  quantity: number | string;
  unit: string;
  estimated_rate: number | string;
  amount: number | string;
};

type RfqRow = {
  id: string;
  document_number: string;
  indent_id: string | null;
  title: string;
  status: string;
  notes: string;
  created_at: string;
};

type PoRow = {
  id: string;
  document_number: string;
  vendor_id: string;
  indent_id: string | null;
  rfq_id: string | null;
  vendor_quote_id: string | null;
  order_date: string;
  expected_delivery: string | null;
  billing_address: string;
  delivery_address: string;
  payment_terms_days: number;
  notes: string;
  status: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  created_at: string;
  updated_at: string;
};

type PoLineRow = {
  id: string;
  purchase_order_id: string;
  line_order: number;
  item_id: string | null;
  description: string;
  quantity: number | string;
  unit: string;
  rate: number | string;
  tax_percent: number | string;
  amount: number | string;
  tax_amount: number | string;
  quantity_received: number | string;
  quantity_billed: number | string;
};

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function canSeeAllIndents(actor: RequestUser): boolean {
  return canViewPurchase(actor) || canApproveIndent(actor) || canManagePurchase(actor);
}

function requireIndentAccess(actor: RequestUser): void {
  if (!canApplyIndent(actor) && !canSeeAllIndents(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot access purchase indents.', 403);
  }
}

function requirePurchaseView(actor: RequestUser): void {
  if (!canViewPurchase(actor) && !canManagePurchase(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view procurement documents.', 403);
  }
}

function requirePurchaseManage(actor: RequestUser): void {
  if (!canManagePurchase(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage procurement documents.', 403);
  }
}

async function employeeNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('employees').select('id, full_name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee names.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
}

async function vendorNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('finance_vendors').select('id, display_name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor names.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.display_name as string]));
}

async function resolveExpenseAccountId(
  supabase: SupabaseClient,
  itemId: string | null | undefined,
  explicit?: string | null,
): Promise<string> {
  if (explicit) return explicit;
  if (itemId) {
    const { data } = await supabase.from('finance_items').select('expense_account_id').eq('id', itemId).maybeSingle();
    if (data?.expense_account_id) return data.expense_account_id as string;
  }
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id')
    .eq('system_role', 'purchase')
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Purchase expense account is missing.', 500);
  }
  return data.id as string;
}

async function isIntraState(supabase: SupabaseClient, vendorId: string): Promise<boolean> {
  const [{ data: org }, { data: vendor }] = await Promise.all([
    supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle(),
    supabase.from('finance_vendors').select('state_code').eq('id', vendorId).maybeSingle(),
  ]);
  const orgState = (org?.state_code as string | null) ?? null;
  const vendorState = (vendor?.state_code as string | null) ?? null;
  return Boolean(orgState && vendorState && orgState === vendorState);
}

function mapIndent(row: IndentRow, lines: IndentLineRow[], requesterName: string | null): PurchaseIndent {
  return {
    id: row.id,
    documentNumber: row.document_number,
    requestedBy: row.requested_by,
    requesterName,
    departmentId: row.department_id,
    requiredDate: row.required_date,
    priority: row.priority,
    purpose: row.purpose,
    justification: row.justification,
    status: row.status,
    estimatedTotal: num(row.estimated_total),
    reviewerId: row.reviewer_id,
    reviewerComment: row.reviewer_comment,
    decidedAt: row.decided_at,
    lines: lines
      .sort((a, b) => a.line_order - b.line_order)
      .map((line) => ({
        id: line.id,
        itemId: line.item_id,
        description: line.description,
        quantity: num(line.quantity),
        unit: line.unit,
        estimatedRate: num(line.estimated_rate),
        amount: num(line.amount),
        lineOrder: line.line_order,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPo(row: PoRow, lines: PoLineRow[], vendorName: string | null): PurchaseOrder {
  return {
    id: row.id,
    documentNumber: row.document_number,
    vendorId: row.vendor_id,
    vendorName,
    indentId: row.indent_id,
    rfqId: row.rfq_id,
    vendorQuoteId: row.vendor_quote_id,
    orderDate: row.order_date,
    expectedDelivery: row.expected_delivery,
    billingAddress: row.billing_address,
    deliveryAddress: row.delivery_address,
    paymentTermsDays: row.payment_terms_days,
    notes: row.notes,
    status: row.status,
    subtotal: num(row.subtotal),
    taxTotal: num(row.tax_total),
    grandTotal: num(row.grand_total),
    lines: lines
      .sort((a, b) => a.line_order - b.line_order)
      .map((line) => ({
        id: line.id,
        itemId: line.item_id,
        description: line.description,
        quantity: num(line.quantity),
        unit: line.unit,
        rate: num(line.rate),
        taxPercent: num(line.tax_percent),
        amount: num(line.amount),
        taxAmount: num(line.tax_amount),
        quantityReceived: num(line.quantity_received),
        quantityBilled: num(line.quantity_billed),
        lineOrder: line.line_order,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateIndentLines(lines: IndentLineInput[]): void {
  if (!lines.length) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one indent line is required.', 400);
  }
  for (const line of lines) {
    if (!line.description?.trim()) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Line description is required.', 400);
    }
    if (!(line.quantity > 0)) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Line quantity must be greater than zero.', 400);
    }
    if (line.estimatedRate < 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Estimated rate cannot be negative.', 400);
    }
  }
}

function validatePoLines(lines: PoLineInput[]): void {
  if (!lines.length) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one purchase order line is required.', 400);
  }
  for (const line of lines) {
    if (!line.description?.trim()) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Line description is required.', 400);
    }
    if (!(line.quantity > 0)) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Line quantity must be greater than zero.', 400);
    }
    if (line.rate < 0 || line.taxPercent < 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Rate and tax percent cannot be negative.', 400);
    }
  }
}

export function createProcurementService(supabase: SupabaseClient) {
  async function loadIndent(id: string): Promise<PurchaseIndent> {
    const { data, error } = await supabase.from('finance_purchase_indents').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load indent.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Purchase indent not found.', 404);
    const row = data as IndentRow;
    const { data: lineData, error: lineErr } = await supabase
      .from('finance_purchase_indent_lines')
      .select('*')
      .eq('indent_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load indent lines.', 500);
    const names = await employeeNames(supabase, [row.requested_by]);
    return mapIndent(row, (lineData ?? []) as IndentLineRow[], names.get(row.requested_by) ?? null);
  }

  async function loadRfq(id: string): Promise<Rfq> {
    const { data, error } = await supabase.from('finance_rfqs').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load RFQ.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'RFQ not found.', 404);
    const row = data as RfqRow;
    const [{ data: lines }, { data: vendors }] = await Promise.all([
      supabase.from('finance_rfq_lines').select('*').eq('rfq_id', id).order('line_order'),
      supabase.from('finance_rfq_vendors').select('vendor_id').eq('rfq_id', id),
    ]);
    return {
      id: row.id,
      documentNumber: row.document_number,
      indentId: row.indent_id,
      title: row.title,
      status: row.status,
      notes: row.notes,
      vendorIds: (vendors ?? []).map((v) => v.vendor_id as string),
      lines: ((lines ?? []) as { id: string; item_id: string | null; description: string; quantity: number | string; unit: string }[]).map(
        (line) => ({
          id: line.id,
          itemId: line.item_id,
          description: line.description,
          quantity: num(line.quantity),
          unit: line.unit,
        }),
      ),
      createdAt: row.created_at,
    };
  }

  async function loadPurchaseOrder(id: string): Promise<PurchaseOrder> {
    const { data, error } = await supabase.from('finance_purchase_orders').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load purchase order.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Purchase order not found.', 404);
    const row = data as PoRow;
    const { data: lines, error: lineErr } = await supabase
      .from('finance_purchase_order_lines')
      .select('*')
      .eq('purchase_order_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load purchase order lines.', 500);
    const names = await vendorNames(supabase, [row.vendor_id]);
    return mapPo(row, (lines ?? []) as PoLineRow[], names.get(row.vendor_id) ?? null);
  }

  async function loadReceipt(id: string): Promise<PurchaseReceipt> {
    const { data, error } = await supabase.from('finance_purchase_receipts').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load receipt.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Purchase receipt not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_purchase_receipt_lines')
      .select('*')
      .eq('receipt_id', id);
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load receipt lines.', 500);
    const { data: po } = await supabase
      .from('finance_purchase_orders')
      .select('document_number')
      .eq('id', data.purchase_order_id as string)
      .maybeSingle();
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      purchaseOrderId: data.purchase_order_id as string,
      purchaseOrderNumber: (po?.document_number as string | undefined) ?? null,
      receiptDate: data.receipt_date as string,
      notes: data.notes as string,
      status: data.status as string,
      lines: ((lines ?? []) as { id: string; purchase_order_line_id: string; quantity_received: number | string; description: string }[]).map(
        (line) => ({
          id: line.id,
          purchaseOrderLineId: line.purchase_order_line_id,
          quantityReceived: num(line.quantity_received),
          description: line.description,
        }),
      ),
      createdAt: data.created_at as string,
    };
  }

  async function loadBill(id: string): Promise<VendorBill> {
    const { data, error } = await supabase.from('finance_vendor_bills').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bill.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor bill not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_vendor_bill_lines')
      .select('*')
      .eq('bill_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bill lines.', 500);
    const names = await vendorNames(supabase, [data.vendor_id as string]);
    const grandTotal = num(data.grand_total as number | string);
    const amountPaid = num(data.amount_paid as number | string);
    const tdsAmount = num((data as { tds_amount?: number | string }).tds_amount);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      vendorId: data.vendor_id as string,
      vendorName: names.get(data.vendor_id as string) ?? null,
      purchaseOrderId: (data.purchase_order_id as string | null) ?? null,
      receiptId: (data.receipt_id as string | null) ?? null,
      billDate: data.bill_date as string,
      dueDate: (data.due_date as string | null) ?? null,
      vendorInvoiceNumber: (data.vendor_invoice_number as string | null) ?? null,
      notes: data.notes as string,
      status: data.status as string,
      matchStatus: data.match_status as string,
      matchNotes: data.match_notes as string,
      subtotal: num(data.subtotal as number | string),
      taxTotal: num(data.tax_total as number | string),
      grandTotal,
      amountPaid,
      amountDue: round2(grandTotal - tdsAmount - amountPaid),
      placeOfSupplyState: ((data as { place_of_supply_state?: string | null }).place_of_supply_state as string | null) ?? null,
      isIntraState: ((data as { is_intra_state?: boolean | null }).is_intra_state as boolean | null) ?? null,
      tdsSection: ((data as { tds_section?: string }).tds_section as string) ?? '',
      tdsPercent: num((data as { tds_percent?: number | string }).tds_percent),
      tdsAmount,
      itcEligibility: (((data as { itc_eligibility?: string }).itc_eligibility as VendorBill['itcEligibility']) ??
        'eligible'),
      lines: ((lines ?? []) as {
        id: string;
        purchase_order_line_id: string | null;
        item_id: string | null;
        expense_account_id: string | null;
        description: string;
        quantity: number | string;
        unit: string;
        rate: number | string;
        tax_percent: number | string;
        amount: number | string;
        tax_amount: number | string;
        hsn_sac?: string;
      }[]).map((line) => ({
        id: line.id,
        purchaseOrderLineId: line.purchase_order_line_id,
        itemId: line.item_id,
        expenseAccountId: line.expense_account_id,
        description: line.description,
        quantity: num(line.quantity),
        unit: line.unit,
        rate: num(line.rate),
        taxPercent: num(line.tax_percent),
        amount: num(line.amount),
        taxAmount: num(line.tax_amount),
        hsnSac: line.hsn_sac ?? '',
      })),
      createdAt: data.created_at as string,
    };
  }

  async function loadPayment(id: string): Promise<VendorPayment> {
    const { data, error } = await supabase.from('finance_vendor_payments').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payment.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor payment not found.', 404);
    const { data: allocs, error: allocErr } = await supabase
      .from('finance_vendor_payment_allocations')
      .select('*')
      .eq('payment_id', id);
    if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payment allocations.', 500);
    const billIds = (allocs ?? []).map((a) => a.bill_id as string);
    const billNumberMap = new Map<string, string>();
    if (billIds.length) {
      const { data: bills } = await supabase.from('finance_vendor_bills').select('id, document_number').in('id', billIds);
      for (const bill of bills ?? []) {
        billNumberMap.set(bill.id as string, bill.document_number as string);
      }
    }
    const names = await vendorNames(supabase, [data.vendor_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      vendorId: data.vendor_id as string,
      vendorName: names.get(data.vendor_id as string) ?? null,
      paymentDate: data.payment_date as string,
      amount: num(data.amount as number | string),
      bankAccountId: (data.bank_account_id as string | null) ?? null,
      method: data.method as string,
      reference: data.reference as string,
      notes: data.notes as string,
      status: data.status as string,
      allocations: ((allocs ?? []) as { bill_id: string; amount: number | string }[]).map((a) => ({
        billId: a.bill_id,
        billNumber: billNumberMap.get(a.bill_id) ?? null,
        amount: num(a.amount),
      })),
      createdAt: data.created_at as string,
    };
  }

  async function loadCredit(id: string): Promise<VendorCredit> {
    const { data, error } = await supabase.from('finance_vendor_credits').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor credit.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor credit not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_vendor_credit_lines')
      .select('*')
      .eq('credit_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load credit lines.', 500);
    const names = await vendorNames(supabase, [data.vendor_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      vendorId: data.vendor_id as string,
      vendorName: names.get(data.vendor_id as string) ?? null,
      billId: (data.bill_id as string | null) ?? null,
      creditDate: data.credit_date as string,
      reason: data.reason as string,
      status: data.status as string,
      subtotal: num(data.subtotal as number | string),
      taxTotal: num(data.tax_total as number | string),
      grandTotal: num(data.grand_total as number | string),
      lines: ((lines ?? []) as {
        id: string;
        description: string;
        quantity: number | string;
        rate: number | string;
        tax_percent: number | string;
        amount: number | string;
        tax_amount: number | string;
      }[]).map((line) => ({
        id: line.id,
        description: line.description,
        quantity: num(line.quantity),
        rate: num(line.rate),
        taxPercent: num(line.tax_percent),
        amount: num(line.amount),
        taxAmount: num(line.tax_amount),
      })),
      createdAt: data.created_at as string,
    };
  }

  async function loadQuote(id: string): Promise<VendorQuote> {
    const { data, error } = await supabase.from('finance_vendor_quotes').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor quote.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor quote not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_vendor_quote_lines')
      .select('*')
      .eq('quote_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load quote lines.', 500);
    const names = await vendorNames(supabase, [data.vendor_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      rfqId: data.rfq_id as string,
      vendorId: data.vendor_id as string,
      vendorName: names.get(data.vendor_id as string) ?? null,
      quoteDate: data.quote_date as string,
      deliveryDays: data.delivery_days as number,
      shippingAmount: num(data.shipping_amount as number | string),
      notes: data.notes as string,
      status: data.status as string,
      subtotal: num(data.subtotal as number | string),
      taxTotal: num(data.tax_total as number | string),
      grandTotal: num(data.grand_total as number | string),
      lines: ((lines ?? []) as {
        id: string;
        description: string;
        quantity: number | string;
        unit: string;
        rate: number | string;
        tax_percent: number | string;
        amount: number | string;
        tax_amount: number | string;
      }[]).map((line) => ({
        id: line.id,
        description: line.description,
        quantity: num(line.quantity),
        unit: line.unit,
        rate: num(line.rate),
        taxPercent: num(line.tax_percent),
        amount: num(line.amount),
        taxAmount: num(line.tax_amount),
      })),
      createdAt: data.created_at as string,
    };
  }

  return {
    async listIndents(actor: RequestUser): Promise<PurchaseIndent[]> {
      requireIndentAccess(actor);
      let query = supabase.from('finance_purchase_indents').select('*').order('created_at', { ascending: false });
      if (!canSeeAllIndents(actor)) {
        query = query.eq('requested_by', actor.employeeId);
      }
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list indents.', 500);
      const rows = (data ?? []) as IndentRow[];
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const { data: lineData, error: lineErr } = await supabase
        .from('finance_purchase_indent_lines')
        .select('*')
        .in('indent_id', ids);
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list indent lines.', 500);
      const linesByIndent = new Map<string, IndentLineRow[]>();
      for (const line of (lineData ?? []) as IndentLineRow[]) {
        const list = linesByIndent.get(line.indent_id) ?? [];
        list.push(line);
        linesByIndent.set(line.indent_id, list);
      }
      const names = await employeeNames(
        supabase,
        rows.map((r) => r.requested_by),
      );
      return rows.map((row) => mapIndent(row, linesByIndent.get(row.id) ?? [], names.get(row.requested_by) ?? null));
    },

    async getIndent(actor: RequestUser, id: string): Promise<PurchaseIndent> {
      requireIndentAccess(actor);
      const indent = await loadIndent(id);
      if (!canSeeAllIndents(actor) && indent.requestedBy !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this indent.', 403);
      }
      return indent;
    },

    async createIndent(
      actor: RequestUser,
      input: {
        departmentId?: string | null;
        requiredDate?: string | null;
        priority?: PurchaseIndent['priority'];
        purpose: string;
        justification?: string;
        lines: IndentLineInput[];
      },
      meta: RequestMeta,
    ): Promise<PurchaseIndent> {
      if (!canApplyIndent(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create purchase indents.', 403);
      }
      validateIndentLines(input.lines);
      const purpose = input.purpose.trim();
      if (!purpose) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Purpose is required.', 400);
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'indent');
      const prepared = input.lines.map((line, index) => {
        const amount = round2(line.quantity * line.estimatedRate);
        return {
          line_order: index,
          item_id: line.itemId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit?.trim() || 'nos',
          estimated_rate: line.estimatedRate,
          amount,
        };
      });
      const estimatedTotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const { data, error } = await supabase
        .from('finance_purchase_indents')
        .insert({
          document_number: documentNumber,
          requested_by: actor.employeeId,
          department_id: input.departmentId ?? null,
          required_date: input.requiredDate ?? null,
          priority: input.priority ?? 'normal',
          purpose,
          justification: input.justification?.trim() ?? '',
          status: 'draft',
          estimated_total: estimatedTotal,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create indent.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_purchase_indent_lines').insert(
        prepared.map((line) => ({ ...line, indent_id: data.id })),
      );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      }
      const created = await loadIndent(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.indent.create',
        entityType: 'finance_purchase_indent',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, status: created.status, estimatedTotal: created.estimatedTotal },
        ...meta,
      });
      return created;
    },

    async updateIndent(
      actor: RequestUser,
      id: string,
      input: {
        departmentId?: string | null;
        requiredDate?: string | null;
        priority?: PurchaseIndent['priority'];
        purpose?: string;
        justification?: string;
        lines?: IndentLineInput[];
      },
      meta: RequestMeta,
    ): Promise<PurchaseIndent> {
      requireIndentAccess(actor);
      const existing = await loadIndent(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft indents can be edited.', 400);
      }
      if (!canManagePurchase(actor) && existing.requestedBy !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot edit this indent.', 403);
      }
      if (!canApplyIndent(actor) && !canManagePurchase(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot edit purchase indents.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.departmentId !== undefined) patch.department_id = input.departmentId;
      if (input.requiredDate !== undefined) patch.required_date = input.requiredDate;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.purpose !== undefined) {
        const purpose = input.purpose.trim();
        if (!purpose) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Purpose is required.', 400);
        patch.purpose = purpose;
      }
      if (input.justification !== undefined) patch.justification = input.justification.trim();

      if (input.lines) {
        validateIndentLines(input.lines);
        const prepared = input.lines.map((line, index) => {
          const amount = round2(line.quantity * line.estimatedRate);
          return {
            indent_id: id,
            line_order: index,
            item_id: line.itemId ?? null,
            description: line.description.trim(),
            quantity: line.quantity,
            unit: line.unit?.trim() || 'nos',
            estimated_rate: line.estimatedRate,
            amount,
          };
        });
        patch.estimated_total = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
        const { error: delErr } = await supabase.from('finance_purchase_indent_lines').delete().eq('indent_id', id);
        if (delErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, delErr.message, 500);
        const { error: insErr } = await supabase.from('finance_purchase_indent_lines').insert(prepared);
        if (insErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, insErr.message, 500);
      }

      if (Object.keys(patch).length) {
        const { error } = await supabase.from('finance_purchase_indents').update(patch).eq('id', id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const updated = await loadIndent(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.indent.update',
        entityType: 'finance_purchase_indent',
        entityId: id,
        oldValues: { status: existing.status, estimatedTotal: existing.estimatedTotal },
        newValues: { status: updated.status, estimatedTotal: updated.estimatedTotal },
        ...meta,
      });
      return updated;
    },

    async submitIndent(actor: RequestUser, id: string, meta: RequestMeta): Promise<PurchaseIndent> {
      requireIndentAccess(actor);
      const existing = await loadIndent(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft indents can be submitted.', 400);
      }
      if (!canManagePurchase(actor) && existing.requestedBy !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit this indent.', 403);
      }
      if (!canApplyIndent(actor) && !canManagePurchase(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit purchase indents.', 403);
      }
      if (!existing.lines.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Indent must have at least one line.', 400);
      }
      const { error } = await supabase.from('finance_purchase_indents').update({ status: 'submitted' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadIndent(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.indent.submit',
        entityType: 'finance_purchase_indent',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'submitted' },
        ...meta,
      });
      return updated;
    },

    async decideIndent(
      actor: RequestUser,
      id: string,
      input: { decision: 'approve' | 'reject'; comment?: string },
      meta: RequestMeta,
    ): Promise<PurchaseIndent> {
      if (!canApproveIndent(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot approve purchase indents.', 403);
      }
      const existing = await loadIndent(id);
      if (existing.status !== 'submitted') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only submitted indents can be decided.', 400);
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      const { error } = await supabase
        .from('finance_purchase_indents')
        .update({
          status,
          reviewer_id: actor.employeeId,
          reviewer_comment: input.comment?.trim() ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadIndent(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: input.decision === 'approve' ? 'finance.indent.approve' : 'finance.indent.reject',
        entityType: 'finance_purchase_indent',
        entityId: id,
        oldValues: { status: 'submitted' },
        newValues: { status, comment: input.comment?.trim() ?? null },
        ...meta,
      });
      return updated;
    },

    async listRfqs(actor: RequestUser): Promise<Rfq[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase.from('finance_rfqs').select('*').order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list RFQs.', 500);
      return Promise.all(((data ?? []) as RfqRow[]).map((row) => loadRfq(row.id)));
    },

    async getRfq(actor: RequestUser, id: string): Promise<Rfq> {
      requirePurchaseView(actor);
      return loadRfq(id);
    },

    async createRfqFromIndent(
      actor: RequestUser,
      input: { indentId: string; vendorIds: string[]; title?: string; notes?: string },
      meta: RequestMeta,
    ): Promise<Rfq> {
      requirePurchaseManage(actor);
      const indent = await loadIndent(input.indentId);
      if (indent.status !== 'approved') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'RFQ can only be created from an approved indent.', 400);
      }
      if (!input.vendorIds?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one vendor is required.', 400);
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'rfq');
      const { data, error } = await supabase
        .from('finance_rfqs')
        .insert({
          document_number: documentNumber,
          indent_id: indent.id,
          title: input.title?.trim() || `RFQ for ${indent.documentNumber}`,
          status: 'open',
          notes: input.notes?.trim() ?? '',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create RFQ.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_rfq_lines').insert(
        indent.lines.map((line, index) => ({
          rfq_id: data.id,
          line_order: index,
          item_id: line.itemId ?? null,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit || 'nos',
        })),
      );
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const { error: vendorErr } = await supabase
        .from('finance_rfq_vendors')
        .insert(input.vendorIds.map((vendorId) => ({ rfq_id: data.id, vendor_id: vendorId })));
      if (vendorErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, vendorErr.message, 500);
      await supabase.from('finance_purchase_indents').update({ status: 'converted' }).eq('id', indent.id);
      const created = await loadRfq(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.rfq.create',
        entityType: 'finance_rfq',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, indentId: indent.id, vendorIds: input.vendorIds },
        ...meta,
      });
      return created;
    },

    async closeRfq(actor: RequestUser, id: string, meta: RequestMeta): Promise<Rfq> {
      requirePurchaseManage(actor);
      const existing = await loadRfq(id);
      if (existing.status === 'closed' || existing.status === 'cancelled') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'RFQ is already closed.', 400);
      }
      const { error } = await supabase.from('finance_rfqs').update({ status: 'closed' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadRfq(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.rfq.close',
        entityType: 'finance_rfq',
        entityId: id,
        oldValues: { status: existing.status },
        newValues: { status: 'closed' },
        ...meta,
      });
      return updated;
    },

    async listQuotesForRfq(actor: RequestUser, rfqId: string): Promise<VendorQuote[]> {
      requirePurchaseView(actor);
      await loadRfq(rfqId);
      const { data, error } = await supabase
        .from('finance_vendor_quotes')
        .select('id')
        .eq('rfq_id', rfqId)
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list quotes.', 500);
      return Promise.all((data ?? []).map((row) => loadQuote(row.id as string)));
    },

    async createVendorQuote(
      actor: RequestUser,
      input: {
        rfqId: string;
        vendorId: string;
        quoteDate?: string;
        deliveryDays?: number;
        shippingAmount?: number;
        notes?: string;
        lines: {
          rfqLineId?: string | null;
          description: string;
          quantity: number;
          unit?: string;
          rate: number;
          taxPercent: number;
        }[];
      },
      meta: RequestMeta,
    ): Promise<VendorQuote> {
      requirePurchaseManage(actor);
      const rfq = await loadRfq(input.rfqId);
      if (rfq.status !== 'open' && rfq.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Quotes can only be added to an open RFQ.', 400);
      }
      if (!rfq.vendorIds.includes(input.vendorId)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor is not attached to this RFQ.', 400);
      }
      if (!input.lines?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one quote line is required.', 400);
      }
      const prepared = input.lines.map((line, index) => {
        const { amount, taxAmount } = lineAmount(line.quantity, line.rate, line.taxPercent);
        return {
          line_order: index,
          rfq_line_id: line.rfqLineId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit?.trim() || 'nos',
          rate: line.rate,
          tax_percent: line.taxPercent,
          amount,
          tax_amount: taxAmount,
        };
      });
      const subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
      const shipping = input.shippingAmount ?? 0;
      const grandTotal = round2(subtotal + taxTotal + shipping);
      const documentNumber = await allocateDocumentNumber(supabase, 'vendor_quote');
      const { data, error } = await supabase
        .from('finance_vendor_quotes')
        .insert({
          document_number: documentNumber,
          rfq_id: input.rfqId,
          vendor_id: input.vendorId,
          quote_date: input.quoteDate ?? todayIsoDate(),
          delivery_days: input.deliveryDays ?? 0,
          shipping_amount: shipping,
          notes: input.notes?.trim() ?? '',
          status: 'received',
          subtotal,
          tax_total: taxTotal,
          grand_total: grandTotal,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create vendor quote.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_vendor_quote_lines')
        .insert(prepared.map((line) => ({ ...line, quote_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadQuote(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.vendor_quote.create',
        entityType: 'finance_vendor_quote',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, rfqId: input.rfqId, vendorId: input.vendorId },
        ...meta,
      });
      return created;
    },

    async selectVendorQuote(actor: RequestUser, quoteId: string, meta: RequestMeta): Promise<VendorQuote> {
      requirePurchaseManage(actor);
      const quote = await loadQuote(quoteId);
      const { data: siblings, error } = await supabase
        .from('finance_vendor_quotes')
        .select('id, status')
        .eq('rfq_id', quote.rfqId);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load quotes for RFQ.', 500);
      for (const sibling of siblings ?? []) {
        const nextStatus = sibling.id === quoteId ? 'selected' : 'rejected';
        const { error: updErr } = await supabase
          .from('finance_vendor_quotes')
          .update({ status: nextStatus })
          .eq('id', sibling.id);
        if (updErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }
      const selected = await loadQuote(quoteId);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.vendor_quote.select',
        entityType: 'finance_vendor_quote',
        entityId: quoteId,
        newValues: { status: 'selected', rfqId: quote.rfqId },
        ...meta,
      });
      return selected;
    },

    async listPurchaseOrders(actor: RequestUser): Promise<PurchaseOrder[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase
        .from('finance_purchase_orders')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list purchase orders.', 500);
      return Promise.all((data ?? []).map((row) => loadPurchaseOrder(row.id as string)));
    },

    async getPurchaseOrder(actor: RequestUser, id: string): Promise<PurchaseOrder> {
      requirePurchaseView(actor);
      return loadPurchaseOrder(id);
    },

    async createPurchaseOrder(
      actor: RequestUser,
      input: {
        vendorId: string;
        indentId?: string | null;
        rfqId?: string | null;
        vendorQuoteId?: string | null;
        orderDate?: string;
        expectedDelivery?: string | null;
        billingAddress?: string;
        deliveryAddress?: string;
        paymentTermsDays?: number;
        notes?: string;
        lines: PoLineInput[];
      },
      meta: RequestMeta,
    ): Promise<PurchaseOrder> {
      requirePurchaseManage(actor);
      validatePoLines(input.lines);
      const prepared = input.lines.map((line, index) => {
        const { amount, taxAmount } = lineAmount(line.quantity, line.rate, line.taxPercent);
        return {
          line_order: index,
          item_id: line.itemId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit?.trim() || 'nos',
          rate: line.rate,
          tax_percent: line.taxPercent,
          amount,
          tax_amount: taxAmount,
          quantity_received: 0,
          quantity_billed: 0,
        };
      });
      const subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
      const documentNumber = await allocateDocumentNumber(supabase, 'purchase_order');
      const { data: vendor } = await supabase
        .from('finance_vendors')
        .select('billing_address, payment_terms_days')
        .eq('id', input.vendorId)
        .maybeSingle();
      if (!vendor) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      const { data, error } = await supabase
        .from('finance_purchase_orders')
        .insert({
          document_number: documentNumber,
          vendor_id: input.vendorId,
          indent_id: input.indentId ?? null,
          rfq_id: input.rfqId ?? null,
          vendor_quote_id: input.vendorQuoteId ?? null,
          order_date: input.orderDate ?? todayIsoDate(),
          expected_delivery: input.expectedDelivery ?? null,
          billing_address: input.billingAddress ?? (vendor.billing_address as string) ?? '',
          delivery_address: input.deliveryAddress ?? '',
          payment_terms_days: input.paymentTermsDays ?? (vendor.payment_terms_days as number) ?? 0,
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          subtotal,
          tax_total: taxTotal,
          grand_total: round2(subtotal + taxTotal),
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create purchase order.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_purchase_order_lines')
        .insert(prepared.map((line) => ({ ...line, purchase_order_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      if (input.indentId) {
        await supabase.from('finance_purchase_indents').update({ status: 'converted' }).eq('id', input.indentId);
      }
      const created = await loadPurchaseOrder(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.purchase_order.create',
        entityType: 'finance_purchase_order',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, vendorId: created.vendorId },
        ...meta,
      });
      return created;
    },

    async createPurchaseOrderFromQuote(
      actor: RequestUser,
      input: {
        quoteId: string;
        orderDate?: string;
        expectedDelivery?: string | null;
        billingAddress?: string;
        deliveryAddress?: string;
        paymentTermsDays?: number;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<PurchaseOrder> {
      requirePurchaseManage(actor);
      const quote = await loadQuote(input.quoteId);
      const rfq = await loadRfq(quote.rfqId);
      return this.createPurchaseOrder(
        actor,
        {
          vendorId: quote.vendorId,
          indentId: rfq.indentId,
          rfqId: quote.rfqId,
          vendorQuoteId: quote.id,
          orderDate: input.orderDate,
          expectedDelivery: input.expectedDelivery,
          billingAddress: input.billingAddress,
          deliveryAddress: input.deliveryAddress,
          paymentTermsDays: input.paymentTermsDays,
          notes: input.notes ?? quote.notes,
          lines: quote.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            rate: line.rate,
            taxPercent: line.taxPercent,
          })),
        },
        meta,
      );
    },

    async approvePurchaseOrder(actor: RequestUser, id: string, meta: RequestMeta): Promise<PurchaseOrder> {
      requirePurchaseManage(actor);
      const existing = await loadPurchaseOrder(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft purchase orders can be approved.', 400);
      }
      const { error } = await supabase.from('finance_purchase_orders').update({ status: 'approved' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadPurchaseOrder(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.purchase_order.approve',
        entityType: 'finance_purchase_order',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'approved' },
        ...meta,
      });
      return updated;
    },

    async issuePurchaseOrder(actor: RequestUser, id: string, meta: RequestMeta): Promise<PurchaseOrder> {
      requirePurchaseManage(actor);
      const existing = await loadPurchaseOrder(id);
      if (existing.status !== 'approved') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only approved purchase orders can be issued.', 400);
      }
      const { error } = await supabase.from('finance_purchase_orders').update({ status: 'issued' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadPurchaseOrder(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.purchase_order.issue',
        entityType: 'finance_purchase_order',
        entityId: id,
        oldValues: { status: 'approved' },
        newValues: { status: 'issued' },
        ...meta,
      });
      return updated;
    },

    async getPurchaseOrderPrint(actor: RequestUser, id: string): Promise<PurchaseOrderPrint> {
      requirePurchaseView(actor);
      const order = await loadPurchaseOrder(id);
      const [{ data: org, error: orgErr }, { data: vendor, error: vendorErr }] = await Promise.all([
        supabase.from('finance_organizations').select('*').eq('id', ORG_ID).maybeSingle(),
        supabase.from('finance_vendors').select('*').eq('id', order.vendorId).maybeSingle(),
      ]);
      if (orgErr || !org) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load organization.', 500);
      if (vendorErr || !vendor) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor not found.', 404);
      return {
        organization: {
          legalName: org.legal_name as string,
          tradeName: org.trade_name as string,
          gstin: (org.gstin as string | null) ?? null,
          addressLine1: org.address_line1 as string,
          city: org.city as string,
          stateName: (org.state_name as string | null) ?? null,
          postalCode: org.postal_code as string,
        },
        order,
        vendor: {
          displayName: vendor.display_name as string,
          gstin: (vendor.gstin as string | null) ?? null,
          billingAddress: vendor.billing_address as string,
          stateName: (vendor.state_name as string | null) ?? null,
        },
      };
    },

    async listReceipts(actor: RequestUser): Promise<PurchaseReceipt[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase
        .from('finance_purchase_receipts')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list receipts.', 500);
      return Promise.all((data ?? []).map((row) => loadReceipt(row.id as string)));
    },

    async getReceipt(actor: RequestUser, id: string): Promise<PurchaseReceipt> {
      requirePurchaseView(actor);
      return loadReceipt(id);
    },

    async createReceipt(
      actor: RequestUser,
      input: {
        purchaseOrderId: string;
        receiptDate?: string;
        notes?: string;
        lines: { purchaseOrderLineId: string; quantityReceived: number; description?: string }[];
      },
      meta: RequestMeta,
    ): Promise<PurchaseReceipt> {
      requirePurchaseManage(actor);
      const po = await loadPurchaseOrder(input.purchaseOrderId);
      if (!['issued', 'partially_received', 'approved'].includes(po.status)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Receipts require an issued or partially received PO.', 400);
      }
      if (!input.lines?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one receipt line is required.', 400);
      }
      const poLineMap = new Map(po.lines.map((line) => [line.id, line]));
      for (const line of input.lines) {
        const poLine = poLineMap.get(line.purchaseOrderLineId);
        if (!poLine) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Receipt line does not belong to this PO.', 400);
        }
        if (!(line.quantityReceived > 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Received quantity must be greater than zero.', 400);
        }
        const remaining = round2(poLine.quantity - poLine.quantityReceived);
        if (line.quantityReceived > remaining + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Received quantity exceeds remaining PO quantity.', 400);
        }
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'receipt');
      const { data, error } = await supabase
        .from('finance_purchase_receipts')
        .insert({
          document_number: documentNumber,
          purchase_order_id: input.purchaseOrderId,
          receipt_date: input.receiptDate ?? todayIsoDate(),
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create receipt.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_purchase_receipt_lines').insert(
        input.lines.map((line) => ({
          receipt_id: data.id,
          purchase_order_line_id: line.purchaseOrderLineId,
          quantity_received: line.quantityReceived,
          description: line.description?.trim() || poLineMap.get(line.purchaseOrderLineId)?.description || '',
        })),
      );
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadReceipt(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.receipt.create',
        entityType: 'finance_purchase_receipt',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, purchaseOrderId: input.purchaseOrderId },
        ...meta,
      });
      return created;
    },

    async postReceipt(actor: RequestUser, id: string, meta: RequestMeta): Promise<PurchaseReceipt> {
      requirePurchaseManage(actor);
      const receipt = await loadReceipt(id);
      if (receipt.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft receipts can be posted.', 400);
      }
      const po = await loadPurchaseOrder(receipt.purchaseOrderId);
      for (const line of receipt.lines) {
        const poLine = po.lines.find((l) => l.id === line.purchaseOrderLineId);
        if (!poLine) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Receipt line missing on purchase order.', 400);
        }
        const nextQty = round2(poLine.quantityReceived + line.quantityReceived);
        if (nextQty > poLine.quantity + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Posting would over-receive a PO line.', 400);
        }
        const { error } = await supabase
          .from('finance_purchase_order_lines')
          .update({ quantity_received: nextQty })
          .eq('id', poLine.id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      const refreshed = await loadPurchaseOrder(receipt.purchaseOrderId);
      const allReceived = refreshed.lines.every((line) => line.quantityReceived + 0.0001 >= line.quantity);
      const anyReceived = refreshed.lines.some((line) => line.quantityReceived > 0);
      const poStatus = allReceived ? 'received' : anyReceived ? 'partially_received' : refreshed.status;
      const { error: poErr } = await supabase
        .from('finance_purchase_orders')
        .update({ status: poStatus })
        .eq('id', receipt.purchaseOrderId);
      if (poErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, poErr.message, 500);
      const { error: recErr } = await supabase.from('finance_purchase_receipts').update({ status: 'posted' }).eq('id', id);
      if (recErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, recErr.message, 500);
      const posted = await loadReceipt(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.receipt.post',
        entityType: 'finance_purchase_receipt',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', purchaseOrderStatus: poStatus },
        ...meta,
      });
      return posted;
    },

    async listBills(actor: RequestUser): Promise<VendorBill[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase
        .from('finance_vendor_bills')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list bills.', 500);
      return Promise.all((data ?? []).map((row) => loadBill(row.id as string)));
    },

    async getBill(actor: RequestUser, id: string): Promise<VendorBill> {
      requirePurchaseView(actor);
      return loadBill(id);
    },

    async createBillFromPurchaseOrder(
      actor: RequestUser,
      input: {
        purchaseOrderId: string;
        receiptId?: string | null;
        billDate?: string;
        dueDate?: string | null;
        vendorInvoiceNumber?: string | null;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<VendorBill> {
      requirePurchaseManage(actor);
      const po = await loadPurchaseOrder(input.purchaseOrderId);
      type BillLineDraft = {
        purchase_order_line_id: string;
        item_id: string | null;
        expense_account_id: string;
        description: string;
        quantity: number;
        unit: string;
        rate: number;
        tax_percent: number;
        amount: number;
        tax_amount: number;
        line_order: number;
      };
      const drafts: BillLineDraft[] = [];
      const matchNotes: string[] = [];
      let hasVariance = false;

      if (input.receiptId) {
        const receipt = await loadReceipt(input.receiptId);
        if (receipt.purchaseOrderId !== po.id) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Receipt does not belong to this purchase order.', 400);
        }
        if (receipt.status !== 'posted') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only posted receipts can be billed.', 400);
        }
        let order = 0;
        for (const rLine of receipt.lines) {
          const poLine = po.lines.find((l) => l.id === rLine.purchaseOrderLineId);
          if (!poLine) continue;
          const remaining = round2(poLine.quantity - poLine.quantityBilled);
          const qty = Math.min(rLine.quantityReceived, remaining);
          if (qty <= 0) continue;
          if (Math.abs(rLine.quantityReceived - qty) > 0.0001 || Math.abs(qty - poLine.quantity) > 0.0001) {
            hasVariance = true;
            matchNotes.push(`Qty variance on ${poLine.description}`);
          }
          const expenseAccountId = await resolveExpenseAccountId(supabase, poLine.itemId);
          const { amount, taxAmount } = lineAmount(qty, poLine.rate, poLine.taxPercent);
          drafts.push({
            purchase_order_line_id: poLine.id,
            item_id: poLine.itemId ?? null,
            expense_account_id: expenseAccountId,
            description: poLine.description,
            quantity: qty,
            unit: poLine.unit || 'nos',
            rate: poLine.rate,
            tax_percent: poLine.taxPercent,
            amount,
            tax_amount: taxAmount,
            line_order: order++,
          });
        }
      } else {
        let order = 0;
        for (const poLine of po.lines) {
          const qty = round2(poLine.quantity - poLine.quantityBilled);
          if (qty <= 0) continue;
          const expenseAccountId = await resolveExpenseAccountId(supabase, poLine.itemId);
          const { amount, taxAmount } = lineAmount(qty, poLine.rate, poLine.taxPercent);
          drafts.push({
            purchase_order_line_id: poLine.id,
            item_id: poLine.itemId ?? null,
            expense_account_id: expenseAccountId,
            description: poLine.description,
            quantity: qty,
            unit: poLine.unit || 'nos',
            rate: poLine.rate,
            tax_percent: poLine.taxPercent,
            amount,
            tax_amount: taxAmount,
            line_order: order++,
          });
        }
      }

      if (!drafts.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No remaining quantity available to bill.', 400);
      }

      for (const draft of drafts) {
        const poLine = po.lines.find((l) => l.id === draft.purchase_order_line_id);
        if (!poLine) continue;
        if (Math.abs(draft.rate - poLine.rate) > 0.0001) {
          hasVariance = true;
          matchNotes.push(`Rate variance on ${poLine.description}`);
        }
        if (draft.quantity > poLine.quantity + 0.0001) {
          hasVariance = true;
          matchNotes.push(`Qty over PO on ${poLine.description}`);
        }
      }

      const subtotal = round2(drafts.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(drafts.reduce((sum, line) => sum + line.tax_amount, 0));
      const documentNumber = await allocateDocumentNumber(supabase, 'bill');
      const { data, error } = await supabase
        .from('finance_vendor_bills')
        .insert({
          document_number: documentNumber,
          vendor_id: po.vendorId,
          purchase_order_id: po.id,
          receipt_id: input.receiptId ?? null,
          bill_date: input.billDate ?? todayIsoDate(),
          due_date: input.dueDate ?? null,
          vendor_invoice_number: input.vendorInvoiceNumber ?? null,
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          match_status: hasVariance ? 'variance' : 'matched',
          match_notes: matchNotes.join('; '),
          subtotal,
          tax_total: taxTotal,
          grand_total: round2(subtotal + taxTotal),
          amount_paid: 0,
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create bill.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_vendor_bill_lines')
        .insert(drafts.map((line) => ({ ...line, bill_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadBill(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bill.create',
        entityType: 'finance_vendor_bill',
        entityId: created.id,
        newValues: {
          documentNumber: created.documentNumber,
          purchaseOrderId: po.id,
          matchStatus: created.matchStatus,
        },
        ...meta,
      });
      return created;
    },

    async postBill(actor: RequestUser, id: string, meta: RequestMeta): Promise<VendorBill> {
      requirePurchaseManage(actor);
      const bill = await loadBill(id);
      if (bill.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft bills can be posted.', 400);
      }
      const expenseAccountId =
        bill.lines[0]?.expenseAccountId ??
        (await resolveExpenseAccountId(supabase, bill.lines[0]?.itemId ?? null));
      const placeOfSupplyIntraState = await isIntraState(supabase, bill.vendorId);
      const [{ data: org }, { data: vendor }] = await Promise.all([
        supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle(),
        supabase.from('finance_vendors').select('state_code').eq('id', bill.vendorId).maybeSingle(),
      ]);
      const placeOfSupplyState =
        ((vendor?.state_code as string | null) ?? (org?.state_code as string | null) ?? null);
      const journalId = await postVendorBillJournal(supabase, {
        billId: bill.id,
        billNumber: bill.documentNumber,
        billDate: bill.billDate,
        createdBy: actor.employeeId,
        expenseAccountId,
        subtotal: bill.subtotal,
        taxTotal: bill.taxTotal,
        grandTotal: bill.grandTotal,
        placeOfSupplyIntraState,
        tdsAmount: bill.tdsAmount,
      });

      for (const line of bill.lines) {
        if (!line.purchaseOrderLineId) continue;
        const { data: poLine, error } = await supabase
          .from('finance_purchase_order_lines')
          .select('quantity_billed')
          .eq('id', line.purchaseOrderLineId)
          .maybeSingle();
        if (error || !poLine) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update billed quantity.', 500);
        }
        const next = round2(num(poLine.quantity_billed as number | string) + line.quantity);
        const { error: updErr } = await supabase
          .from('finance_purchase_order_lines')
          .update({ quantity_billed: next })
          .eq('id', line.purchaseOrderLineId);
        if (updErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }

      const { error } = await supabase
        .from('finance_vendor_bills')
        .update({
          status: 'posted',
          journal_id: journalId,
          place_of_supply_state: placeOfSupplyState,
          is_intra_state: placeOfSupplyIntraState,
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      if (bill.purchaseOrderId) {
        const po = await loadPurchaseOrder(bill.purchaseOrderId);
        const allBilled = po.lines.every((line) => line.quantityBilled + 0.0001 >= line.quantity);
        if (allBilled) {
          await supabase.from('finance_purchase_orders').update({ status: 'billed' }).eq('id', po.id);
        }
      }

      const posted = await loadBill(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bill.post',
        entityType: 'finance_vendor_bill',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },

    async listPayments(actor: RequestUser): Promise<VendorPayment[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase
        .from('finance_vendor_payments')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list payments.', 500);
      return Promise.all((data ?? []).map((row) => loadPayment(row.id as string)));
    },

    async getPayment(actor: RequestUser, id: string): Promise<VendorPayment> {
      requirePurchaseView(actor);
      return loadPayment(id);
    },

    async createPayment(
      actor: RequestUser,
      input: {
        vendorId: string;
        paymentDate?: string;
        amount: number;
        bankAccountId?: string | null;
        method?: string;
        reference?: string;
        notes?: string;
        allocations: { billId: string; amount: number }[];
      },
      meta: RequestMeta,
    ): Promise<VendorPayment> {
      requirePurchaseManage(actor);
      if (!(input.amount > 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Payment amount must be greater than zero.', 400);
      }
      if (!input.allocations?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one allocation is required.', 400);
      }
      const allocSum = round2(input.allocations.reduce((sum, a) => sum + a.amount, 0));
      if (Math.round(allocSum * 100) !== Math.round(input.amount * 100)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocations must sum to the payment amount.', 400);
      }
      for (const alloc of input.allocations) {
        if (!(alloc.amount > 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation amount must be greater than zero.', 400);
        }
        const bill = await loadBill(alloc.billId);
        if (bill.vendorId !== input.vendorId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation bill belongs to another vendor.', 400);
        }
        if (!['posted', 'partially_paid'].includes(bill.status)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only posted bills can be paid.', 400);
        }
        if (alloc.amount > bill.amountDue + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation exceeds bill amount due.', 400);
        }
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'payment_made');
      const { data, error } = await supabase
        .from('finance_vendor_payments')
        .insert({
          document_number: documentNumber,
          vendor_id: input.vendorId,
          payment_date: input.paymentDate ?? todayIsoDate(),
          amount: input.amount,
          bank_account_id: input.bankAccountId ?? null,
          method: input.method?.trim() || 'bank_transfer',
          reference: input.reference?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create payment.', 500);
      }
      const { error: allocErr } = await supabase.from('finance_vendor_payment_allocations').insert(
        input.allocations.map((a) => ({
          payment_id: data.id,
          bill_id: a.billId,
          amount: a.amount,
        })),
      );
      if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, allocErr.message, 500);
      const created = await loadPayment(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.payment.create',
        entityType: 'finance_vendor_payment',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, amount: created.amount },
        ...meta,
      });
      return created;
    },

    async postPayment(actor: RequestUser, id: string, meta: RequestMeta): Promise<VendorPayment> {
      requirePurchaseManage(actor);
      const payment = await loadPayment(id);
      if (payment.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft payments can be posted.', 400);
      }
      if (!payment.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account is required to post a payment.', 400);
      }
      const journalId = await postVendorPaymentJournal(supabase, {
        paymentId: payment.id,
        paymentNumber: payment.documentNumber,
        paymentDate: payment.paymentDate,
        createdBy: actor.employeeId,
        amount: payment.amount,
        bankAccountId: payment.bankAccountId,
      });

      for (const alloc of payment.allocations) {
        const bill = await loadBill(alloc.billId);
        const amountPaid = round2(bill.amountPaid + alloc.amount);
        const status =
          amountPaid + 0.0001 >= bill.grandTotal ? 'paid' : amountPaid > 0 ? 'partially_paid' : bill.status;
        const { error } = await supabase
          .from('finance_vendor_bills')
          .update({ amount_paid: amountPaid, status })
          .eq('id', bill.id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const { error } = await supabase
        .from('finance_vendor_payments')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const posted = await loadPayment(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.payment.post',
        entityType: 'finance_vendor_payment',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },

    async listCredits(actor: RequestUser): Promise<VendorCredit[]> {
      requirePurchaseView(actor);
      const { data, error } = await supabase
        .from('finance_vendor_credits')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list vendor credits.', 500);
      return Promise.all((data ?? []).map((row) => loadCredit(row.id as string)));
    },

    async getCredit(actor: RequestUser, id: string): Promise<VendorCredit> {
      requirePurchaseView(actor);
      return loadCredit(id);
    },

    async createCredit(
      actor: RequestUser,
      input: {
        vendorId: string;
        billId?: string | null;
        creditDate?: string;
        reason?: string;
        lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
      },
      meta: RequestMeta,
    ): Promise<VendorCredit> {
      requirePurchaseManage(actor);
      if (!input.lines?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one credit line is required.', 400);
      }
      if (input.billId) {
        const bill = await loadBill(input.billId);
        if (bill.vendorId !== input.vendorId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bill does not belong to this vendor.', 400);
        }
      }
      const prepared = input.lines.map((line, index) => {
        if (!line.description?.trim()) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Credit line description is required.', 400);
        }
        const { amount, taxAmount } = lineAmount(line.quantity, line.rate, line.taxPercent);
        return {
          line_order: index,
          description: line.description.trim(),
          quantity: line.quantity,
          rate: line.rate,
          tax_percent: line.taxPercent,
          amount,
          tax_amount: taxAmount,
        };
      });
      const subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
      const documentNumber = await allocateDocumentNumber(supabase, 'vendor_credit');
      const { data, error } = await supabase
        .from('finance_vendor_credits')
        .insert({
          document_number: documentNumber,
          vendor_id: input.vendorId,
          bill_id: input.billId ?? null,
          credit_date: input.creditDate ?? todayIsoDate(),
          reason: input.reason?.trim() ?? '',
          status: 'draft',
          subtotal,
          tax_total: taxTotal,
          grand_total: round2(subtotal + taxTotal),
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create vendor credit.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_vendor_credit_lines')
        .insert(prepared.map((line) => ({ ...line, credit_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadCredit(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.vendor_credit.create',
        entityType: 'finance_vendor_credit',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, vendorId: created.vendorId },
        ...meta,
      });
      return created;
    },

    async postCredit(actor: RequestUser, id: string, meta: RequestMeta): Promise<VendorCredit> {
      requirePurchaseManage(actor);
      const credit = await loadCredit(id);
      if (credit.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft credits can be posted.', 400);
      }
      const expenseAccountId = await resolveExpenseAccountId(supabase, null);
      const placeOfSupplyIntraState = await isIntraState(supabase, credit.vendorId);
      const journalId = await postVendorCreditJournal(supabase, {
        creditId: credit.id,
        creditNumber: credit.documentNumber,
        creditDate: credit.creditDate,
        createdBy: actor.employeeId,
        expenseAccountId,
        subtotal: credit.subtotal,
        taxTotal: credit.taxTotal,
        grandTotal: credit.grandTotal,
        placeOfSupplyIntraState,
      });
      const { error } = await supabase
        .from('finance_vendor_credits')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const posted = await loadCredit(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.vendor_credit.post',
        entityType: 'finance_vendor_credit',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },
  };
}
