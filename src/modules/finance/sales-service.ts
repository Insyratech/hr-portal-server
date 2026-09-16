import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageSales, canViewSales, type RequestMeta } from './access';
import {
  postCustomerCreditNoteJournal,
  postCustomerInvoiceJournal,
  postCustomerPaymentJournal,
} from './posting';
import type {
  CustomerCreditNote,
  CustomerPayment,
  DeliveryNote,
  SalesDocumentPrint,
  SalesInvoice,
  SalesLineInput,
  SalesOrder,
  SalesQuote,
} from './sales-types';
import { allocateDocumentNumber, lineAmount } from './series-allocate';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type QuoteRow = {
  id: string;
  document_number: string;
  customer_id: string;
  quote_date: string;
  expiry_date: string | null;
  status: SalesQuote['status'];
  notes: string;
  terms: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  created_at: string;
  updated_at: string;
};

type QuoteLineRow = {
  id: string;
  quote_id: string;
  line_order: number;
  item_id: string | null;
  description: string;
  quantity: number | string;
  unit: string;
  rate: number | string;
  tax_percent: number | string;
  amount: number | string;
  tax_amount: number | string;
};

type SoRow = {
  id: string;
  document_number: string;
  customer_id: string;
  quote_id: string | null;
  order_date: string;
  expected_delivery: string | null;
  billing_address: string;
  shipping_address: string;
  notes: string;
  status: string;
  subtotal: number | string;
  tax_total: number | string;
  grand_total: number | string;
  created_at: string;
  updated_at: string;
};

type SoLineRow = {
  id: string;
  sales_order_id: string;
  line_order: number;
  item_id: string | null;
  description: string;
  quantity: number | string;
  unit: string;
  rate: number | string;
  tax_percent: number | string;
  amount: number | string;
  tax_amount: number | string;
  quantity_delivered: number | string;
  quantity_invoiced: number | string;
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

function requireSalesView(actor: RequestUser): void {
  if (!canViewSales(actor) && !canManageSales(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view sales documents.', 403);
  }
}

function requireSalesManage(actor: RequestUser): void {
  if (!canManageSales(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage sales documents.', 403);
  }
}

async function customerNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('finance_customers').select('id, display_name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer names.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.display_name as string]));
}

async function resolveIncomeAccountId(
  supabase: SupabaseClient,
  itemId: string | null | undefined,
  explicit?: string | null,
): Promise<string> {
  if (explicit) return explicit;
  if (itemId) {
    const { data } = await supabase.from('finance_items').select('income_account_id').eq('id', itemId).maybeSingle();
    if (data?.income_account_id) return data.income_account_id as string;
  }
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id')
    .eq('system_role', 'sales')
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Sales income account is missing.', 500);
  }
  return data.id as string;
}

async function isIntraState(supabase: SupabaseClient, customerId: string): Promise<boolean> {
  const [{ data: org }, { data: customer }] = await Promise.all([
    supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle(),
    supabase.from('finance_customers').select('state_code').eq('id', customerId).maybeSingle(),
  ]);
  const orgState = (org?.state_code as string | null) ?? null;
  const customerState = (customer?.state_code as string | null) ?? null;
  return Boolean(orgState && customerState && orgState === customerState);
}

function validateSalesLines(lines: SalesLineInput[]): void {
  if (!lines.length) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one line is required.', 400);
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

function prepareSalesLines(lines: SalesLineInput[]) {
  return lines.map((line, index) => {
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
    };
  });
}

function mapQuote(row: QuoteRow, lines: QuoteLineRow[], customerName: string | null): SalesQuote {
  return {
    id: row.id,
    documentNumber: row.document_number,
    customerId: row.customer_id,
    customerName,
    quoteDate: row.quote_date,
    expiryDate: row.expiry_date,
    status: row.status,
    notes: row.notes,
    terms: row.terms,
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
        lineOrder: line.line_order,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSalesOrder(row: SoRow, lines: SoLineRow[], customerName: string | null): SalesOrder {
  return {
    id: row.id,
    documentNumber: row.document_number,
    customerId: row.customer_id,
    customerName,
    quoteId: row.quote_id,
    orderDate: row.order_date,
    expectedDelivery: row.expected_delivery,
    billingAddress: row.billing_address,
    shippingAddress: row.shipping_address,
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
        quantityDelivered: num(line.quantity_delivered),
        quantityInvoiced: num(line.quantity_invoiced),
        lineOrder: line.line_order,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function invoiceStatusAfterPost(dueDate: string | null): 'sent' | 'overdue' {
  if (dueDate && dueDate < todayIsoDate()) return 'overdue';
  return 'sent';
}

export function createSalesService(supabase: SupabaseClient) {
  async function loadQuote(id: string): Promise<SalesQuote> {
    const { data, error } = await supabase.from('finance_sales_quotes').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load quote.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Sales quote not found.', 404);
    const row = data as QuoteRow;
    const { data: lines, error: lineErr } = await supabase
      .from('finance_sales_quote_lines')
      .select('*')
      .eq('quote_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load quote lines.', 500);
    const names = await customerNames(supabase, [row.customer_id]);
    return mapQuote(row, (lines ?? []) as QuoteLineRow[], names.get(row.customer_id) ?? null);
  }

  async function loadSalesOrder(id: string): Promise<SalesOrder> {
    const { data, error } = await supabase.from('finance_sales_orders').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load sales order.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Sales order not found.', 404);
    const row = data as SoRow;
    const { data: lines, error: lineErr } = await supabase
      .from('finance_sales_order_lines')
      .select('*')
      .eq('sales_order_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load sales order lines.', 500);
    const names = await customerNames(supabase, [row.customer_id]);
    return mapSalesOrder(row, (lines ?? []) as SoLineRow[], names.get(row.customer_id) ?? null);
  }

  async function loadDeliveryNote(id: string): Promise<DeliveryNote> {
    const { data, error } = await supabase.from('finance_delivery_notes').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load delivery note.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Delivery note not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_delivery_note_lines')
      .select('*')
      .eq('delivery_note_id', id);
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load delivery note lines.', 500);
    const { data: so } = await supabase
      .from('finance_sales_orders')
      .select('document_number')
      .eq('id', data.sales_order_id as string)
      .maybeSingle();
    const names = await customerNames(supabase, [data.customer_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      salesOrderId: data.sales_order_id as string,
      salesOrderNumber: (so?.document_number as string | undefined) ?? null,
      customerId: data.customer_id as string,
      customerName: names.get(data.customer_id as string) ?? null,
      deliveryDate: data.delivery_date as string,
      notes: data.notes as string,
      status: data.status as string,
      lines: ((lines ?? []) as {
        id: string;
        sales_order_line_id: string;
        quantity_delivered: number | string;
        description: string;
      }[]).map((line) => ({
        id: line.id,
        salesOrderLineId: line.sales_order_line_id,
        quantityDelivered: num(line.quantity_delivered),
        description: line.description,
      })),
      createdAt: data.created_at as string,
    };
  }

  async function loadInvoice(id: string): Promise<SalesInvoice> {
    const { data, error } = await supabase.from('finance_invoices').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Invoice not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_invoice_lines')
      .select('*')
      .eq('invoice_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice lines.', 500);
    const names = await customerNames(supabase, [data.customer_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      customerId: data.customer_id as string,
      customerName: names.get(data.customer_id as string) ?? null,
      salesOrderId: (data.sales_order_id as string | null) ?? null,
      deliveryNoteId: (data.delivery_note_id as string | null) ?? null,
      quoteId: (data.quote_id as string | null) ?? null,
      invoiceDate: data.invoice_date as string,
      dueDate: (data.due_date as string | null) ?? null,
      notes: data.notes as string,
      status: data.status as string,
      subtotal: num(data.subtotal as number | string),
      taxTotal: num(data.tax_total as number | string),
      grandTotal: num(data.grand_total as number | string),
      amountPaid: num(data.amount_paid as number | string),
      journalId: (data.journal_id as string | null) ?? null,
      lines: ((lines ?? []) as {
        id: string;
        sales_order_line_id: string | null;
        item_id: string | null;
        income_account_id: string | null;
        description: string;
        quantity: number | string;
        unit: string;
        rate: number | string;
        tax_percent: number | string;
        amount: number | string;
        tax_amount: number | string;
      }[]).map((line) => ({
        id: line.id,
        salesOrderLineId: line.sales_order_line_id,
        itemId: line.item_id,
        incomeAccountId: line.income_account_id,
        description: line.description,
        quantity: num(line.quantity),
        unit: line.unit,
        rate: num(line.rate),
        taxPercent: num(line.tax_percent),
        amount: num(line.amount),
        taxAmount: num(line.tax_amount),
      })),
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }

  async function loadCustomerPayment(id: string): Promise<CustomerPayment> {
    const { data, error } = await supabase.from('finance_customer_payments').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer payment.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer payment not found.', 404);
    const { data: allocs, error: allocErr } = await supabase
      .from('finance_customer_payment_allocations')
      .select('*')
      .eq('payment_id', id);
    if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payment allocations.', 500);
    const invoiceIds = (allocs ?? []).map((a) => a.invoice_id as string);
    const invoiceNumberMap = new Map<string, string>();
    if (invoiceIds.length) {
      const { data: invoices } = await supabase
        .from('finance_invoices')
        .select('id, document_number')
        .in('id', invoiceIds);
      for (const inv of invoices ?? []) {
        invoiceNumberMap.set(inv.id as string, inv.document_number as string);
      }
    }
    const names = await customerNames(supabase, [data.customer_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      customerId: data.customer_id as string,
      customerName: names.get(data.customer_id as string) ?? null,
      paymentDate: data.payment_date as string,
      amount: num(data.amount as number | string),
      bankAccountId: (data.bank_account_id as string | null) ?? null,
      method: data.method as string,
      reference: data.reference as string,
      notes: data.notes as string,
      status: data.status as string,
      journalId: (data.journal_id as string | null) ?? null,
      allocations: ((allocs ?? []) as { id: string; invoice_id: string; amount: number | string }[]).map((a) => ({
        id: a.id,
        invoiceId: a.invoice_id,
        invoiceNumber: invoiceNumberMap.get(a.invoice_id) ?? null,
        amount: num(a.amount),
      })),
      createdAt: data.created_at as string,
    };
  }

  async function loadCreditNote(id: string): Promise<CustomerCreditNote> {
    const { data, error } = await supabase.from('finance_credit_notes').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load credit note.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Credit note not found.', 404);
    const { data: lines, error: lineErr } = await supabase
      .from('finance_credit_note_lines')
      .select('*')
      .eq('credit_note_id', id)
      .order('line_order');
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load credit note lines.', 500);
    const names = await customerNames(supabase, [data.customer_id as string]);
    return {
      id: data.id as string,
      documentNumber: data.document_number as string,
      customerId: data.customer_id as string,
      customerName: names.get(data.customer_id as string) ?? null,
      invoiceId: (data.invoice_id as string | null) ?? null,
      creditDate: data.credit_date as string,
      reason: data.reason as string,
      status: data.status as string,
      subtotal: num(data.subtotal as number | string),
      taxTotal: num(data.tax_total as number | string),
      grandTotal: num(data.grand_total as number | string),
      journalId: (data.journal_id as string | null) ?? null,
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

  async function refreshSoFulfillmentStatus(salesOrderId: string): Promise<void> {
    const so = await loadSalesOrder(salesOrderId);
    if (so.status === 'draft' || so.status === 'cancelled') return;
    const allInvoiced = so.lines.every((line) => line.quantityInvoiced + 0.0001 >= line.quantity);
    const anyInvoiced = so.lines.some((line) => line.quantityInvoiced > 0);
    const allDelivered = so.lines.every((line) => line.quantityDelivered + 0.0001 >= line.quantity);
    const anyDelivered = so.lines.some((line) => line.quantityDelivered > 0);
    let status = so.status;
    if (allInvoiced) status = 'invoiced';
    else if (anyInvoiced) status = 'partially_invoiced';
    else if (allDelivered) status = 'delivered';
    else if (anyDelivered) status = 'partially_delivered';
    else status = 'confirmed';
    if (status !== so.status) {
      const { error } = await supabase.from('finance_sales_orders').update({ status }).eq('id', salesOrderId);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
    }
  }

  async function refreshInvoiceOverdueStatuses(): Promise<void> {
    const today = todayIsoDate();
    const { error } = await supabase
      .from('finance_invoices')
      .update({ status: 'overdue' })
      .eq('status', 'sent')
      .lt('due_date', today)
      .not('due_date', 'is', null);
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to refresh overdue invoices.', 500);
  }

  async function buildPrintParty(customerId: string): Promise<{
    organization: SalesDocumentPrint['organization'];
    customer: SalesDocumentPrint['customer'];
  }> {
    const [{ data: org, error: orgErr }, { data: customer, error: customerErr }] = await Promise.all([
      supabase.from('finance_organizations').select('*').eq('id', ORG_ID).maybeSingle(),
      supabase.from('finance_customers').select('*').eq('id', customerId).maybeSingle(),
    ]);
    if (orgErr || !org) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load organization.', 500);
    if (customerErr || !customer) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
    return {
      organization: {
        legalName: org.legal_name as string,
        tradeName: org.trade_name as string,
        addressLine1: org.address_line1 as string,
        city: org.city as string,
        postalCode: org.postal_code as string,
        gstin: (org.gstin as string | null) ?? null,
      },
      customer: {
        displayName: customer.display_name as string,
        gstin: (customer.gstin as string | null) ?? null,
        billingAddress: customer.billing_address as string,
      },
    };
  }

  async function insertInvoiceWithLines(input: {
    customerId: string;
    salesOrderId?: string | null;
    deliveryNoteId?: string | null;
    quoteId?: string | null;
    invoiceDate: string;
    dueDate?: string | null;
    notes?: string;
    createdBy: string;
    lines: {
      sales_order_line_id: string | null;
      item_id: string | null;
      income_account_id: string;
      description: string;
      quantity: number;
      unit: string;
      rate: number;
      tax_percent: number;
      amount: number;
      tax_amount: number;
      line_order: number;
    }[];
  }): Promise<SalesInvoice> {
    if (!input.lines.length) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No remaining quantity available to invoice.', 400);
    }
    const subtotal = round2(input.lines.reduce((sum, line) => sum + line.amount, 0));
    const taxTotal = round2(input.lines.reduce((sum, line) => sum + line.tax_amount, 0));
    const documentNumber = await allocateDocumentNumber(supabase, 'invoice');
    const { data, error } = await supabase
      .from('finance_invoices')
      .insert({
        document_number: documentNumber,
        customer_id: input.customerId,
        sales_order_id: input.salesOrderId ?? null,
        delivery_note_id: input.deliveryNoteId ?? null,
        quote_id: input.quoteId ?? null,
        invoice_date: input.invoiceDate,
        due_date: input.dueDate ?? null,
        notes: input.notes?.trim() ?? '',
        status: 'draft',
        subtotal,
        tax_total: taxTotal,
        grand_total: round2(subtotal + taxTotal),
        amount_paid: 0,
        created_by: input.createdBy,
      })
      .select('*')
      .single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create invoice.', 500);
    }
    const { error: lineErr } = await supabase
      .from('finance_invoice_lines')
      .insert(input.lines.map((line) => ({ ...line, invoice_id: data.id })));
    if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
    return loadInvoice(data.id as string);
  }

  return {
    async listQuotes(actor: RequestUser): Promise<SalesQuote[]> {
      requireSalesView(actor);
      const { data, error } = await supabase
        .from('finance_sales_quotes')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list quotes.', 500);
      return Promise.all((data ?? []).map((row) => loadQuote(row.id as string)));
    },

    async getQuote(actor: RequestUser, id: string): Promise<SalesQuote> {
      requireSalesView(actor);
      return loadQuote(id);
    },

    async createQuote(
      actor: RequestUser,
      input: {
        customerId: string;
        quoteDate?: string;
        expiryDate?: string | null;
        notes?: string;
        terms?: string;
        lines: SalesLineInput[];
      },
      meta: RequestMeta,
    ): Promise<SalesQuote> {
      requireSalesManage(actor);
      validateSalesLines(input.lines);
      const { data: customer } = await supabase
        .from('finance_customers')
        .select('id')
        .eq('id', input.customerId)
        .maybeSingle();
      if (!customer) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
      const prepared = prepareSalesLines(input.lines);
      const subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
      const documentNumber = await allocateDocumentNumber(supabase, 'quote');
      const { data, error } = await supabase
        .from('finance_sales_quotes')
        .insert({
          document_number: documentNumber,
          customer_id: input.customerId,
          quote_date: input.quoteDate ?? todayIsoDate(),
          expiry_date: input.expiryDate ?? null,
          notes: input.notes?.trim() ?? '',
          terms: input.terms?.trim() ?? '',
          status: 'draft',
          subtotal,
          tax_total: taxTotal,
          grand_total: round2(subtotal + taxTotal),
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create quote.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_sales_quote_lines')
        .insert(prepared.map((line) => ({ ...line, quote_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadQuote(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.quote.create',
        entityType: 'finance_sales_quote',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, customerId: created.customerId },
        ...meta,
      });
      return created;
    },

    async updateQuote(
      actor: RequestUser,
      id: string,
      input: {
        quoteDate?: string;
        expiryDate?: string | null;
        notes?: string;
        terms?: string;
        lines?: SalesLineInput[];
      },
      meta: RequestMeta,
    ): Promise<SalesQuote> {
      requireSalesManage(actor);
      const existing = await loadQuote(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft quotes can be edited.', 400);
      }
      const patch: Record<string, unknown> = {};
      if (input.quoteDate !== undefined) patch.quote_date = input.quoteDate;
      if (input.expiryDate !== undefined) patch.expiry_date = input.expiryDate;
      if (input.notes !== undefined) patch.notes = input.notes.trim();
      if (input.terms !== undefined) patch.terms = input.terms.trim();
      if (input.lines) {
        validateSalesLines(input.lines);
        const prepared = prepareSalesLines(input.lines);
        patch.subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
        patch.tax_total = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
        patch.grand_total = round2(num(patch.subtotal as number) + num(patch.tax_total as number));
        const { error: delErr } = await supabase.from('finance_sales_quote_lines').delete().eq('quote_id', id);
        if (delErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, delErr.message, 500);
        const { error: insErr } = await supabase
          .from('finance_sales_quote_lines')
          .insert(prepared.map((line) => ({ ...line, quote_id: id })));
        if (insErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, insErr.message, 500);
      }
      if (Object.keys(patch).length) {
        const { error } = await supabase.from('finance_sales_quotes').update(patch).eq('id', id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      const updated = await loadQuote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.quote.update',
        entityType: 'finance_sales_quote',
        entityId: id,
        oldValues: { status: existing.status, grandTotal: existing.grandTotal },
        newValues: { status: updated.status, grandTotal: updated.grandTotal },
        ...meta,
      });
      return updated;
    },

    async sendQuote(actor: RequestUser, id: string, meta: RequestMeta): Promise<SalesQuote> {
      requireSalesManage(actor);
      const existing = await loadQuote(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft quotes can be sent.', 400);
      }
      if (!existing.lines.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Quote must have at least one line.', 400);
      }
      const { error } = await supabase.from('finance_sales_quotes').update({ status: 'sent' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadQuote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.quote.send',
        entityType: 'finance_sales_quote',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'sent' },
        ...meta,
      });
      return updated;
    },

    async decideQuote(
      actor: RequestUser,
      id: string,
      input: { decision: 'accept' | 'decline' },
      meta: RequestMeta,
    ): Promise<SalesQuote> {
      requireSalesManage(actor);
      const existing = await loadQuote(id);
      if (existing.status !== 'sent') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only sent quotes can be accepted or declined.', 400);
      }
      const status = input.decision === 'accept' ? 'accepted' : 'declined';
      const { error } = await supabase.from('finance_sales_quotes').update({ status }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadQuote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: input.decision === 'accept' ? 'finance.quote.accept' : 'finance.quote.decline',
        entityType: 'finance_sales_quote',
        entityId: id,
        oldValues: { status: 'sent' },
        newValues: { status },
        ...meta,
      });
      return updated;
    },

    async expireQuote(actor: RequestUser, id: string, meta: RequestMeta): Promise<SalesQuote> {
      requireSalesManage(actor);
      const existing = await loadQuote(id);
      if (existing.status !== 'sent') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only sent quotes can be expired.', 400);
      }
      const pastExpiry = Boolean(existing.expiryDate && existing.expiryDate < todayIsoDate());
      const { error } = await supabase.from('finance_sales_quotes').update({ status: 'expired' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadQuote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.quote.expire',
        entityType: 'finance_sales_quote',
        entityId: id,
        oldValues: { status: 'sent' },
        newValues: { status: 'expired', pastExpiry },
        ...meta,
      });
      return updated;
    },

    async createSalesOrder(
      actor: RequestUser,
      input: {
        customerId: string;
        quoteId?: string | null;
        orderDate?: string;
        expectedDelivery?: string | null;
        billingAddress?: string;
        shippingAddress?: string;
        notes?: string;
        lines: SalesLineInput[];
      },
      meta: RequestMeta,
    ): Promise<SalesOrder> {
      requireSalesManage(actor);
      validateSalesLines(input.lines);
      const { data: customer } = await supabase
        .from('finance_customers')
        .select('billing_address')
        .eq('id', input.customerId)
        .maybeSingle();
      if (!customer) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer not found.', 404);
      const prepared = prepareSalesLines(input.lines).map((line) => ({
        ...line,
        quantity_delivered: 0,
        quantity_invoiced: 0,
      }));
      const subtotal = round2(prepared.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round2(prepared.reduce((sum, line) => sum + line.tax_amount, 0));
      const documentNumber = await allocateDocumentNumber(supabase, 'sales_order');
      const { data, error } = await supabase
        .from('finance_sales_orders')
        .insert({
          document_number: documentNumber,
          customer_id: input.customerId,
          quote_id: input.quoteId ?? null,
          order_date: input.orderDate ?? todayIsoDate(),
          expected_delivery: input.expectedDelivery ?? null,
          billing_address: input.billingAddress ?? (customer.billing_address as string) ?? '',
          shipping_address: input.shippingAddress ?? '',
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
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create sales order.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_sales_order_lines')
        .insert(prepared.map((line) => ({ ...line, sales_order_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadSalesOrder(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.sales_order.create',
        entityType: 'finance_sales_order',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, customerId: created.customerId },
        ...meta,
      });
      return created;
    },

    async createSalesOrderFromQuote(
      actor: RequestUser,
      input: {
        quoteId: string;
        orderDate?: string;
        expectedDelivery?: string | null;
        billingAddress?: string;
        shippingAddress?: string;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<SalesOrder> {
      requireSalesManage(actor);
      const quote = await loadQuote(input.quoteId);
      if (!['accepted', 'sent'].includes(quote.status)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Sales order can only be created from an accepted or sent quote.',
          400,
        );
      }
      const created = await this.createSalesOrder(
        actor,
        {
          customerId: quote.customerId,
          quoteId: quote.id,
          orderDate: input.orderDate,
          expectedDelivery: input.expectedDelivery,
          billingAddress: input.billingAddress,
          shippingAddress: input.shippingAddress,
          notes: input.notes ?? quote.notes,
          lines: quote.lines.map((line) => ({
            itemId: line.itemId,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            rate: line.rate,
            taxPercent: line.taxPercent,
          })),
        },
        meta,
      );
      const { error } = await supabase
        .from('finance_sales_quotes')
        .update({ status: 'converted' })
        .eq('id', quote.id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      return created;
    },

    async convertQuoteToSalesOrder(actor: RequestUser, quoteId: string, meta: RequestMeta): Promise<SalesOrder> {
      return this.createSalesOrderFromQuote(actor, { quoteId }, meta);
    },

    async convertQuoteToInvoice(actor: RequestUser, quoteId: string, meta: RequestMeta): Promise<SalesInvoice> {
      return this.createInvoiceFromQuote(actor, { quoteId }, meta);
    },

    async confirmSalesOrder(actor: RequestUser, id: string, meta: RequestMeta): Promise<SalesOrder> {
      requireSalesManage(actor);
      const existing = await loadSalesOrder(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft sales orders can be confirmed.', 400);
      }
      const { error } = await supabase.from('finance_sales_orders').update({ status: 'confirmed' }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadSalesOrder(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.sales_order.confirm',
        entityType: 'finance_sales_order',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'confirmed' },
        ...meta,
      });
      return updated;
    },

    async listSalesOrders(actor: RequestUser): Promise<SalesOrder[]> {
      requireSalesView(actor);
      const { data, error } = await supabase
        .from('finance_sales_orders')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list sales orders.', 500);
      return Promise.all((data ?? []).map((row) => loadSalesOrder(row.id as string)));
    },

    async getSalesOrder(actor: RequestUser, id: string): Promise<SalesOrder> {
      requireSalesView(actor);
      return loadSalesOrder(id);
    },

    async getQuotePrint(actor: RequestUser, id: string): Promise<SalesDocumentPrint> {
      requireSalesView(actor);
      const quote = await loadQuote(id);
      const parties = await buildPrintParty(quote.customerId);
      return {
        ...parties,
        document: {
          type: 'quote',
          documentNumber: quote.documentNumber,
          date: quote.quoteDate,
          status: quote.status,
          notes: quote.notes,
          subtotal: quote.subtotal,
          taxTotal: quote.taxTotal,
          grandTotal: quote.grandTotal,
          lines: quote.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            rate: line.rate,
            taxPercent: line.taxPercent,
            amount: line.amount,
            taxAmount: line.taxAmount,
          })),
        },
      };
    },

    async listDeliveryNotes(actor: RequestUser): Promise<DeliveryNote[]> {
      requireSalesView(actor);
      const { data, error } = await supabase
        .from('finance_delivery_notes')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list delivery notes.', 500);
      return Promise.all((data ?? []).map((row) => loadDeliveryNote(row.id as string)));
    },

    async getDeliveryNote(actor: RequestUser, id: string): Promise<DeliveryNote> {
      requireSalesView(actor);
      return loadDeliveryNote(id);
    },

    async createDeliveryNoteFromSalesOrder(
      actor: RequestUser,
      input: {
        salesOrderId: string;
        deliveryDate?: string;
        notes?: string;
        lines: { salesOrderLineId: string; quantityDelivered: number }[];
      },
      meta: RequestMeta,
    ): Promise<DeliveryNote> {
      requireSalesManage(actor);
      const so = await loadSalesOrder(input.salesOrderId);
      if (!['confirmed', 'partially_delivered', 'delivered', 'partially_invoiced'].includes(so.status)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Delivery notes require a confirmed sales order.',
          400,
        );
      }
      if (!input.lines?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one delivery line is required.', 400);
      }
      const soLineMap = new Map(so.lines.map((line) => [line.id, line]));
      for (const line of input.lines) {
        const soLine = soLineMap.get(line.salesOrderLineId);
        if (!soLine) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Delivery line does not belong to this sales order.', 400);
        }
        if (!(line.quantityDelivered > 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Delivered quantity must be greater than zero.', 400);
        }
        const remaining = round2(soLine.quantity - soLine.quantityDelivered);
        if (line.quantityDelivered > remaining + 0.0001) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Delivered quantity exceeds remaining sales order quantity.',
            400,
          );
        }
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'delivery_note');
      const { data, error } = await supabase
        .from('finance_delivery_notes')
        .insert({
          document_number: documentNumber,
          sales_order_id: input.salesOrderId,
          customer_id: so.customerId,
          delivery_date: input.deliveryDate ?? todayIsoDate(),
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create delivery note.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_delivery_note_lines').insert(
        input.lines.map((line) => ({
          delivery_note_id: data.id,
          sales_order_line_id: line.salesOrderLineId,
          quantity_delivered: line.quantityDelivered,
          description: soLineMap.get(line.salesOrderLineId)?.description || '',
        })),
      );
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadDeliveryNote(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.delivery_note.create',
        entityType: 'finance_delivery_note',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, salesOrderId: input.salesOrderId },
        ...meta,
      });
      return created;
    },

    async postDeliveryNote(actor: RequestUser, id: string, meta: RequestMeta): Promise<DeliveryNote> {
      requireSalesManage(actor);
      const note = await loadDeliveryNote(id);
      if (note.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft delivery notes can be posted.', 400);
      }
      const so = await loadSalesOrder(note.salesOrderId);
      for (const line of note.lines) {
        const soLine = so.lines.find((l) => l.id === line.salesOrderLineId);
        if (!soLine) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Delivery line missing on sales order.', 400);
        }
        const nextQty = round2(soLine.quantityDelivered + line.quantityDelivered);
        if (nextQty > soLine.quantity + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Posting would over-deliver a sales order line.', 400);
        }
        const { error } = await supabase
          .from('finance_sales_order_lines')
          .update({ quantity_delivered: nextQty })
          .eq('id', soLine.id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      await refreshSoFulfillmentStatus(note.salesOrderId);
      const { error: dnErr } = await supabase
        .from('finance_delivery_notes')
        .update({ status: 'delivered' })
        .eq('id', id);
      if (dnErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, dnErr.message, 500);
      const posted = await loadDeliveryNote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.delivery_note.post',
        entityType: 'finance_delivery_note',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'delivered' },
        ...meta,
      });
      return posted;
    },

    async getDeliveryNotePrint(actor: RequestUser, id: string): Promise<SalesDocumentPrint> {
      requireSalesView(actor);
      const note = await loadDeliveryNote(id);
      const parties = await buildPrintParty(note.customerId);
      return {
        ...parties,
        document: {
          type: 'delivery_note',
          documentNumber: note.documentNumber,
          date: note.deliveryDate,
          status: note.status,
          notes: note.notes,
          lines: note.lines.map((line) => ({
            description: line.description,
            quantity: line.quantityDelivered,
          })),
        },
      };
    },

    async listInvoices(actor: RequestUser): Promise<SalesInvoice[]> {
      requireSalesView(actor);
      await refreshInvoiceOverdueStatuses();
      const { data, error } = await supabase
        .from('finance_invoices')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list invoices.', 500);
      return Promise.all((data ?? []).map((row) => loadInvoice(row.id as string)));
    },

    async getInvoice(actor: RequestUser, id: string): Promise<SalesInvoice> {
      requireSalesView(actor);
      return loadInvoice(id);
    },

    async refreshInvoiceOverdueStatuses(actor: RequestUser): Promise<void> {
      requireSalesView(actor);
      await refreshInvoiceOverdueStatuses();
    },

    async createInvoiceFromSalesOrder(
      actor: RequestUser,
      input: {
        salesOrderId: string;
        deliveryNoteId?: string | null;
        invoiceDate?: string;
        dueDate?: string | null;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<SalesInvoice> {
      requireSalesManage(actor);
      const so = await loadSalesOrder(input.salesOrderId);
      type InvoiceLineDraft = {
        sales_order_line_id: string;
        item_id: string | null;
        income_account_id: string;
        description: string;
        quantity: number;
        unit: string;
        rate: number;
        tax_percent: number;
        amount: number;
        tax_amount: number;
        line_order: number;
      };
      const drafts: InvoiceLineDraft[] = [];

      if (input.deliveryNoteId) {
        const note = await loadDeliveryNote(input.deliveryNoteId);
        if (note.salesOrderId !== so.id) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Delivery note does not belong to this sales order.', 400);
        }
        if (note.status !== 'delivered') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only posted delivery notes can be invoiced.', 400);
        }
        let order = 0;
        for (const dnLine of note.lines) {
          const soLine = so.lines.find((l) => l.id === dnLine.salesOrderLineId);
          if (!soLine) continue;
          const remaining = round2(soLine.quantity - soLine.quantityInvoiced);
          const qty = Math.min(dnLine.quantityDelivered, remaining);
          if (qty <= 0) continue;
          const incomeAccountId = await resolveIncomeAccountId(supabase, soLine.itemId);
          const { amount, taxAmount } = lineAmount(qty, soLine.rate, soLine.taxPercent);
          drafts.push({
            sales_order_line_id: soLine.id,
            item_id: soLine.itemId ?? null,
            income_account_id: incomeAccountId,
            description: soLine.description,
            quantity: qty,
            unit: soLine.unit || 'nos',
            rate: soLine.rate,
            tax_percent: soLine.taxPercent,
            amount,
            tax_amount: taxAmount,
            line_order: order++,
          });
        }
      } else {
        let order = 0;
        for (const soLine of so.lines) {
          const qty = round2(soLine.quantity - soLine.quantityInvoiced);
          if (qty <= 0) continue;
          const incomeAccountId = await resolveIncomeAccountId(supabase, soLine.itemId);
          const { amount, taxAmount } = lineAmount(qty, soLine.rate, soLine.taxPercent);
          drafts.push({
            sales_order_line_id: soLine.id,
            item_id: soLine.itemId ?? null,
            income_account_id: incomeAccountId,
            description: soLine.description,
            quantity: qty,
            unit: soLine.unit || 'nos',
            rate: soLine.rate,
            tax_percent: soLine.taxPercent,
            amount,
            tax_amount: taxAmount,
            line_order: order++,
          });
        }
      }

      const created = await insertInvoiceWithLines({
        customerId: so.customerId,
        salesOrderId: so.id,
        deliveryNoteId: input.deliveryNoteId ?? null,
        quoteId: so.quoteId,
        invoiceDate: input.invoiceDate ?? todayIsoDate(),
        dueDate: input.dueDate ?? null,
        notes: input.notes,
        createdBy: actor.employeeId,
        lines: drafts,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.invoice.create',
        entityType: 'finance_invoice',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, salesOrderId: so.id },
        ...meta,
      });
      return created;
    },

    async createInvoiceFromQuote(
      actor: RequestUser,
      input: {
        quoteId: string;
        invoiceDate?: string;
        dueDate?: string | null;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<SalesInvoice> {
      requireSalesManage(actor);
      const quote = await loadQuote(input.quoteId);
      if (!['accepted', 'sent'].includes(quote.status)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Invoice can only be created from an accepted or sent quote.',
          400,
        );
      }
      const drafts = [];
      let order = 0;
      for (const line of quote.lines) {
        const incomeAccountId = await resolveIncomeAccountId(supabase, line.itemId);
        const { amount, taxAmount } = lineAmount(line.quantity, line.rate, line.taxPercent);
        drafts.push({
          sales_order_line_id: null as string | null,
          item_id: line.itemId ?? null,
          income_account_id: incomeAccountId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit || 'nos',
          rate: line.rate,
          tax_percent: line.taxPercent,
          amount,
          tax_amount: taxAmount,
          line_order: order++,
        });
      }
      const created = await insertInvoiceWithLines({
        customerId: quote.customerId,
        quoteId: quote.id,
        invoiceDate: input.invoiceDate ?? todayIsoDate(),
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? quote.notes,
        createdBy: actor.employeeId,
        lines: drafts,
      });
      const { error } = await supabase
        .from('finance_sales_quotes')
        .update({ status: 'converted' })
        .eq('id', quote.id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.invoice.create_from_quote',
        entityType: 'finance_invoice',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, quoteId: quote.id },
        ...meta,
      });
      return created;
    },

    async sendInvoice(actor: RequestUser, id: string, meta: RequestMeta): Promise<SalesInvoice> {
      requireSalesManage(actor);
      const existing = await loadInvoice(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft invoices can be sent.', 400);
      }
      const status = invoiceStatusAfterPost(existing.dueDate);
      const { error } = await supabase.from('finance_invoices').update({ status }).eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const updated = await loadInvoice(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.invoice.send',
        entityType: 'finance_invoice',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status },
        ...meta,
      });
      return updated;
    },

    async postInvoice(actor: RequestUser, id: string, meta: RequestMeta): Promise<SalesInvoice> {
      requireSalesManage(actor);
      const invoice = await loadInvoice(id);
      if (!['draft', 'sent', 'overdue'].includes(invoice.status)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft or sent invoices can be posted.', 400);
      }
      if (invoice.journalId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invoice already has a journal entry.', 400);
      }
      const incomeAccountId =
        invoice.lines[0]?.incomeAccountId ??
        (await resolveIncomeAccountId(supabase, invoice.lines[0]?.itemId ?? null));
      const placeOfSupplyIntraState = await isIntraState(supabase, invoice.customerId);
      const [{ data: org }, { data: customer }] = await Promise.all([
        supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle(),
        supabase.from('finance_customers').select('state_code').eq('id', invoice.customerId).maybeSingle(),
      ]);
      const placeOfSupplyState =
        ((customer?.state_code as string | null) ?? (org?.state_code as string | null) ?? null);
      const journalId = await postCustomerInvoiceJournal(supabase, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.documentNumber,
        invoiceDate: invoice.invoiceDate,
        createdBy: actor.employeeId,
        incomeAccountId,
        subtotal: invoice.subtotal,
        taxTotal: invoice.taxTotal,
        grandTotal: invoice.grandTotal,
        placeOfSupplyIntraState,
      });

      for (const line of invoice.lines) {
        if (!line.salesOrderLineId) continue;
        const { data: soLine, error } = await supabase
          .from('finance_sales_order_lines')
          .select('quantity_invoiced')
          .eq('id', line.salesOrderLineId)
          .maybeSingle();
        if (error || !soLine) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update invoiced quantity.', 500);
        }
        const next = round2(num(soLine.quantity_invoiced as number | string) + line.quantity);
        const { error: updErr } = await supabase
          .from('finance_sales_order_lines')
          .update({ quantity_invoiced: next })
          .eq('id', line.salesOrderLineId);
        if (updErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }

      const status = invoiceStatusAfterPost(invoice.dueDate);
      const { error } = await supabase
        .from('finance_invoices')
        .update({
          status,
          journal_id: journalId,
          amount_paid: 0,
          place_of_supply_state: placeOfSupplyState,
          is_intra_state: placeOfSupplyIntraState,
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      if (invoice.salesOrderId) {
        await refreshSoFulfillmentStatus(invoice.salesOrderId);
      }

      const posted = await loadInvoice(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.invoice.post',
        entityType: 'finance_invoice',
        entityId: id,
        oldValues: { status: invoice.status },
        newValues: { status, journalId },
        ...meta,
      });
      return posted;
    },

    async getInvoicePrint(actor: RequestUser, id: string): Promise<SalesDocumentPrint> {
      requireSalesView(actor);
      const invoice = await loadInvoice(id);
      const parties = await buildPrintParty(invoice.customerId);
      const { data: einvoiceRow } = await supabase
        .from('finance_einvoices')
        .select('irn, ack_number, signed_qr, status')
        .eq('invoice_id', id)
        .eq('status', 'generated')
        .maybeSingle();
      const einvoice =
        einvoiceRow && (einvoiceRow.irn as string | null)
          ? {
              irn: einvoiceRow.irn as string,
              ackNumber: (einvoiceRow.ack_number as string | null) ?? null,
              signedQr: (einvoiceRow.signed_qr as string | null) ?? null,
            }
          : null;
      return {
        ...parties,
        document: {
          type: 'invoice',
          documentNumber: invoice.documentNumber,
          date: invoice.invoiceDate,
          status: invoice.status,
          notes: invoice.notes,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          grandTotal: invoice.grandTotal,
          lines: invoice.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            rate: line.rate,
            taxPercent: line.taxPercent,
            amount: line.amount,
            taxAmount: line.taxAmount,
          })),
          einvoice,
        },
      };
    },

    async listCustomerPayments(actor: RequestUser): Promise<CustomerPayment[]> {
      requireSalesView(actor);
      const { data, error } = await supabase
        .from('finance_customer_payments')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list customer payments.', 500);
      return Promise.all((data ?? []).map((row) => loadCustomerPayment(row.id as string)));
    },

    async getCustomerPayment(actor: RequestUser, id: string): Promise<CustomerPayment> {
      requireSalesView(actor);
      return loadCustomerPayment(id);
    },

    async createCustomerPayment(
      actor: RequestUser,
      input: {
        customerId: string;
        paymentDate?: string;
        amount: number;
        bankAccountId: string;
        method?: string;
        reference?: string;
        notes?: string;
        allocations: { invoiceId: string; amount: number }[];
      },
      meta: RequestMeta,
    ): Promise<CustomerPayment> {
      requireSalesManage(actor);
      if (!(input.amount > 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Payment amount must be greater than zero.', 400);
      }
      if (!input.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account is required.', 400);
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
        const invoice = await loadInvoice(alloc.invoiceId);
        if (invoice.customerId !== input.customerId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation invoice belongs to another customer.', 400);
        }
        if (!invoice.journalId || !['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Only posted (sent/overdue/partially paid) invoices can receive payments.',
            400,
          );
        }
        const outstanding = round2(invoice.grandTotal - invoice.amountPaid);
        if (alloc.amount > outstanding + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation exceeds invoice outstanding.', 400);
        }
      }
      const documentNumber = await allocateDocumentNumber(supabase, 'payment_received');
      const { data, error } = await supabase
        .from('finance_customer_payments')
        .insert({
          document_number: documentNumber,
          customer_id: input.customerId,
          payment_date: input.paymentDate ?? todayIsoDate(),
          amount: input.amount,
          bank_account_id: input.bankAccountId,
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
      const { error: allocErr } = await supabase.from('finance_customer_payment_allocations').insert(
        input.allocations.map((a) => ({
          payment_id: data.id,
          invoice_id: a.invoiceId,
          amount: a.amount,
        })),
      );
      if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, allocErr.message, 500);
      const created = await loadCustomerPayment(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.customer_payment.create',
        entityType: 'finance_customer_payment',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, amount: created.amount },
        ...meta,
      });
      return created;
    },

    async postCustomerPayment(actor: RequestUser, id: string, meta: RequestMeta): Promise<CustomerPayment> {
      requireSalesManage(actor);
      const payment = await loadCustomerPayment(id);
      if (payment.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft payments can be posted.', 400);
      }
      if (!payment.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account is required to post a payment.', 400);
      }
      const journalId = await postCustomerPaymentJournal(supabase, {
        paymentId: payment.id,
        paymentNumber: payment.documentNumber,
        paymentDate: payment.paymentDate,
        createdBy: actor.employeeId,
        amount: payment.amount,
        bankAccountId: payment.bankAccountId,
      });

      for (const alloc of payment.allocations) {
        const invoice = await loadInvoice(alloc.invoiceId);
        const amountPaid = round2(invoice.amountPaid + alloc.amount);
        const status =
          amountPaid + 0.0001 >= invoice.grandTotal ? 'paid' : amountPaid > 0 ? 'partially_paid' : invoice.status;
        const { error } = await supabase
          .from('finance_invoices')
          .update({ amount_paid: amountPaid, status })
          .eq('id', invoice.id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const { error } = await supabase
        .from('finance_customer_payments')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const posted = await loadCustomerPayment(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.customer_payment.post',
        entityType: 'finance_customer_payment',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },

    async listCreditNotes(actor: RequestUser): Promise<CustomerCreditNote[]> {
      requireSalesView(actor);
      const { data, error } = await supabase
        .from('finance_credit_notes')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list credit notes.', 500);
      return Promise.all((data ?? []).map((row) => loadCreditNote(row.id as string)));
    },

    async getCreditNote(actor: RequestUser, id: string): Promise<CustomerCreditNote> {
      requireSalesView(actor);
      return loadCreditNote(id);
    },

    async createCreditNote(
      actor: RequestUser,
      input: {
        customerId: string;
        invoiceId?: string | null;
        creditDate?: string;
        reason?: string;
        lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
      },
      meta: RequestMeta,
    ): Promise<CustomerCreditNote> {
      requireSalesManage(actor);
      if (!input.lines?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one credit line is required.', 400);
      }
      if (input.invoiceId) {
        const invoice = await loadInvoice(input.invoiceId);
        if (invoice.customerId !== input.customerId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invoice does not belong to this customer.', 400);
        }
      }
      const prepared = input.lines.map((line, index) => {
        if (!line.description?.trim()) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Credit line description is required.', 400);
        }
        if (!(line.quantity > 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Credit line quantity must be greater than zero.', 400);
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
      const documentNumber = await allocateDocumentNumber(supabase, 'credit_note');
      const { data, error } = await supabase
        .from('finance_credit_notes')
        .insert({
          document_number: documentNumber,
          customer_id: input.customerId,
          invoice_id: input.invoiceId ?? null,
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
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create credit note.', 500);
      }
      const { error: lineErr } = await supabase
        .from('finance_credit_note_lines')
        .insert(prepared.map((line) => ({ ...line, credit_note_id: data.id })));
      if (lineErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      const created = await loadCreditNote(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.credit_note.create',
        entityType: 'finance_credit_note',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, customerId: created.customerId },
        ...meta,
      });
      return created;
    },

    async postCreditNote(actor: RequestUser, id: string, meta: RequestMeta): Promise<CustomerCreditNote> {
      requireSalesManage(actor);
      const credit = await loadCreditNote(id);
      if (credit.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft credit notes can be posted.', 400);
      }
      const incomeAccountId = await resolveIncomeAccountId(supabase, null);
      const placeOfSupplyIntraState = await isIntraState(supabase, credit.customerId);
      const journalId = await postCustomerCreditNoteJournal(supabase, {
        creditId: credit.id,
        creditNumber: credit.documentNumber,
        creditDate: credit.creditDate,
        createdBy: actor.employeeId,
        incomeAccountId,
        subtotal: credit.subtotal,
        taxTotal: credit.taxTotal,
        grandTotal: credit.grandTotal,
        placeOfSupplyIntraState,
      });
      const { error } = await supabase
        .from('finance_credit_notes')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      const posted = await loadCreditNote(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.credit_note.post',
        entityType: 'finance_credit_note',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },
  };
}
