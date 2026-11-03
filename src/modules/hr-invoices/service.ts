import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { assertHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { sendMail } from '../notifications/mail';
import { buildHrInvoiceMail } from './email';
import { invoiceTotal, isHrInvoiceCurrency, lineAmount, roundMoney, type HrInvoiceCurrency } from './money';
import type {
  CreateHrInvoiceInput,
  HrInvoiceClient,
  HrInvoiceDetail,
  HrInvoiceLine,
  HrInvoiceSummary,
} from './types';

const LOGO_BUCKET = 'company-logos';
const MAX_LINES = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isInvoiceRecipient(value: string): boolean {
  return EMAIL.test(value);
}

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type ClientRow = {
  id: string;
  name: string;
  address: string;
};

type InvoiceRow = {
  id: string;
  company_id: string;
  client_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  reference: string;
  currency: HrInvoiceCurrency;
  issuer_name: string;
  issuer_address: string;
  issuer_email: string;
  issuer_logo_path: string | null;
  client_name: string;
  client_address: string;
  signature_name: string;
  total: number | string;
  created_at: string;
};

type LineRow = {
  id: string;
  invoice_id: string;
  line_order: number;
  description: string;
  detail: string;
  quantity: number | string;
  unit_price: number | string;
};

function dbError(error: { message?: string; code?: string }, fallback: string): AppError {
  const message = error.message ?? '';
  if (error.code === '42P01' || message.includes('hr_invoice')) {
    return new AppError(
      API_ERROR_CODES.SERVICE_UNAVAILABLE,
      'Apply migration 092_hr_freelancer_invoices.sql, then try again.',
      503,
    );
  }
  return new AppError(API_ERROR_CODES.INTERNAL_ERROR, fallback, 500);
}

function assertHr(actor: RequestUser): void {
  assertHrDomainOwner(actor, 'manage freelancer invoices');
}

function cleanText(value: string | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanAddress(value: string | undefined): string {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim()
    .slice(0, 800);
}

function assertDate(value: string, label: string): string {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Choose a valid ${label}.`, 400);
  }
  return value;
}

function mapClient(row: ClientRow): HrInvoiceClient {
  return { id: row.id, name: row.name, address: row.address };
}

function mapLine(row: LineRow): HrInvoiceLine {
  const quantity = roundMoney(Number(row.quantity));
  const unitPrice = roundMoney(Number(row.unit_price));
  return {
    id: row.id,
    description: row.description,
    detail: row.detail,
    quantity,
    unitPrice,
    amount: lineAmount(quantity, unitPrice),
  };
}

function mapSummary(row: InvoiceRow): HrInvoiceSummary {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    reference: row.reference,
    currency: row.currency,
    companyName: row.issuer_name,
    clientName: row.client_name,
    total: roundMoney(Number(row.total)),
    createdAt: row.created_at,
  };
}

async function signedLogoUrl(supabase: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(LOGO_BUCKET).createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export function createHrInvoiceService(supabase: SupabaseClient) {
  return {
    async listClients(actor: RequestUser): Promise<HrInvoiceClient[]> {
      assertHr(actor);
      const { data, error } = await supabase
        .from('hr_invoice_clients')
        .select('id, name, address')
        .order('name', { ascending: true });
      if (error) throw dbError(error, 'Failed to list invoice clients.');
      return ((data ?? []) as ClientRow[]).map(mapClient);
    },

    async list(actor: RequestUser): Promise<HrInvoiceSummary[]> {
      assertHr(actor);
      const { data, error } = await supabase
        .from('hr_invoices')
        .select(
          'id, company_id, client_id, invoice_number, issue_date, due_date, reference, currency, issuer_name, issuer_address, issuer_email, issuer_logo_path, client_name, client_address, signature_name, total, created_at',
        )
        .order('created_at', { ascending: false });
      if (error) throw dbError(error, 'Failed to list invoices.');
      return ((data ?? []) as InvoiceRow[]).map(mapSummary);
    },

    async get(actor: RequestUser, id: string): Promise<HrInvoiceDetail> {
      assertHr(actor);
      const { data, error } = await supabase
        .from('hr_invoices')
        .select(
          'id, company_id, client_id, invoice_number, issue_date, due_date, reference, currency, issuer_name, issuer_address, issuer_email, issuer_logo_path, client_name, client_address, signature_name, total, created_at',
        )
        .eq('id', id)
        .maybeSingle();
      if (error) throw dbError(error, 'Failed to load the invoice.');
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Invoice not found.', 404);

      const { data: lineRows, error: lineError } = await supabase
        .from('hr_invoice_lines')
        .select('id, invoice_id, line_order, description, detail, quantity, unit_price')
        .eq('invoice_id', id)
        .order('line_order', { ascending: true });
      if (lineError) throw dbError(lineError, 'Failed to load invoice lines.');

      const lines = ((lineRows ?? []) as LineRow[]).map(mapLine);
      const row = data as InvoiceRow;
      return {
        ...mapSummary(row),
        total: invoiceTotal(lines),
        companyId: row.company_id,
        clientId: row.client_id,
        issuerAddress: row.issuer_address,
        issuerEmail: row.issuer_email,
        logoUrl: await signedLogoUrl(supabase, row.issuer_logo_path),
        clientAddress: row.client_address,
        signatureName: row.signature_name,
        lines,
      };
    },

    async create(actor: RequestUser, input: CreateHrInvoiceInput, meta: RequestMeta): Promise<HrInvoiceDetail> {
      assertHr(actor);
      const issueDate = assertDate(input.issueDate, 'issue date');
      const dueDate = assertDate(input.dueDate, 'due date');
      if (dueDate < issueDate) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Due date cannot be before the issue date.', 400);
      }
      if (!isHrInvoiceCurrency(input.currency)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose INR, GBP, USD, or EUR.', 400);
      }
      const issuerEmail = cleanText(input.issuerEmail, 160);
      if (!EMAIL.test(issuerEmail)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a valid email for the invoice footer.', 400);
      }
      const signatureName = cleanText(input.signatureName, 120);
      if (!signatureName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter the name that signs the invoice.', 400);
      }
      const reference = cleanText(input.reference, 80);
      if (!input.lines?.length || input.lines.length > MAX_LINES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add between 1 and 20 lines.', 400);
      }

      const lines = input.lines.map((line, index) => {
        const description = cleanText(line.description, 240);
        if (!description) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Line ${index + 1} needs a description.`, 400);
        }
        const quantity = roundMoney(Number(line.quantity));
        const unitPrice = roundMoney(Number(line.unitPrice));
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Line ${index + 1} needs a quantity above 0.`, 400);
        }
        if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100_000_000) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Line ${index + 1} needs a unit price of 0 or more.`, 400);
        }
        return {
          description,
          detail: cleanText(line.detail, 240),
          quantity,
          unitPrice,
        };
      });
      const total = invoiceTotal(lines);

      const { data: company, error: companyError } = await supabase
        .from('companies')
        .select('id, name, address, logo_storage_path, status')
        .eq('id', input.companyId)
        .maybeSingle();
      if (companyError) throw dbError(companyError, 'Failed to load the company.');
      if (!company || company.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose an active company.', 400);
      }

      const resolved = await resolveClient(supabase, actor, input);
      const client = resolved.client;
      const { data: created, error: insertError } = await supabase
        .from('hr_invoices')
        .insert({
          company_id: company.id,
          client_id: client.id,
          issue_date: issueDate,
          due_date: dueDate,
          reference,
          currency: input.currency,
          issuer_name: company.name,
          issuer_address: company.address ?? '',
          issuer_email: issuerEmail,
          issuer_logo_path: company.logo_storage_path,
          client_name: client.name,
          client_address: client.address,
          signature_name: signatureName,
          total,
          created_by: actor.employeeId,
        })
        .select('id')
        .single();
      if (insertError || !created) {
        if (resolved.created) {
          await supabase.from('hr_invoice_clients').delete().eq('id', client.id);
        }
        throw dbError(insertError ?? { message: 'insert failed' }, 'Failed to create the invoice.');
      }

      const invoiceId = created.id as string;
      const { error: lineError } = await supabase.from('hr_invoice_lines').insert(
        lines.map((line, index) => ({
          invoice_id: invoiceId,
          line_order: index + 1,
          description: line.description,
          detail: line.detail,
          quantity: line.quantity,
          unit_price: line.unitPrice,
        })),
      );
      if (lineError) {
        await supabase.from('hr_invoices').delete().eq('id', invoiceId);
        throw dbError(lineError, 'Failed to save invoice lines.');
      }

      const detail = await this.get(actor, invoiceId);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'hr_invoice.create',
        entityType: 'hr_invoice',
        entityId: invoiceId,
        newValues: {
          invoiceNumber: detail.invoiceNumber,
          companyName: detail.companyName,
          clientName: detail.clientName,
          total: detail.total,
          currency: detail.currency,
        },
        ...meta,
      });
      return detail;
    },

    async email(
      actor: RequestUser,
      id: string,
      to: string,
      meta: RequestMeta,
    ): Promise<{ sent: true; to: string }> {
      const recipient = to.trim().toLowerCase();
      if (!isInvoiceRecipient(recipient)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a valid recipient email.', 400);
      }
      const invoice = await this.get(actor, id);
      const mail = buildHrInvoiceMail(invoice);
      const result = await sendMail({
        to: [recipient],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      if (result.outcome === 'disabled') {
        throw new AppError(
          API_ERROR_CODES.SERVICE_UNAVAILABLE,
          'Email is not configured. Set the Brevo sender before sharing invoices.',
          503,
        );
      }
      if (!result.sent) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'The invoice email could not be sent.', 502);
      }
      try {
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'hr_invoice.email',
          entityType: 'hr_invoice',
          entityId: id,
          newValues: { to: recipient, invoiceNumber: invoice.invoiceNumber },
          ...meta,
        });
      } catch (error) {
        console.error('[hr-invoice] email sent but audit failed', error);
      }
      return { sent: true, to: recipient };
    },
  };
}

async function resolveClient(
  supabase: SupabaseClient,
  actor: RequestUser,
  input: CreateHrInvoiceInput,
): Promise<{ client: HrInvoiceClient; created: boolean }> {
  const clientId = input.clientId?.trim() || '';
  if (clientId) {
    const { data, error } = await supabase
      .from('hr_invoice_clients')
      .select('id, name, address')
      .eq('id', clientId)
      .maybeSingle();
    if (error) throw dbError(error, 'Failed to load the client.');
    if (!data) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'That client is no longer available.', 400);
    return { client: mapClient(data as ClientRow), created: false };
  }

  const name = cleanText(input.client?.name, 160);
  if (!name) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a previous client or enter a new one.', 400);
  }
  const address = cleanAddress(input.client?.address);
  const { data, error } = await supabase
    .from('hr_invoice_clients')
    .insert({ name, address, created_by: actor.employeeId })
    .select('id, name, address')
    .single();
  if (error || !data) throw dbError(error ?? { message: 'client insert failed' }, 'Failed to save the client.');
  return { client: mapClient(data as ClientRow), created: true };
}
