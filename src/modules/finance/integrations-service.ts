import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../../config/env';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageIntegrations, canViewIntegrations, type RequestMeta } from './access';
import { createGspProvider, type GspMode } from './gsp-provider';
import type {
  EinvoiceRecord,
  EwayBillRecord,
  GstnSyncJob,
  IntegrationSettings,
  PaymentCheckoutIntent,
} from './integrations-types';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type SettingsRow = {
  id: string;
  gsp_mode: 'sandbox' | 'live';
  payment_gateway_enabled: boolean;
  payment_gateway_provider: 'none' | 'razorpay' | 'stripe';
  bank_feed_enabled: boolean;
  bank_feed_provider: 'none' | 'account_aggregator' | 'manual_api';
  notes: string;
  updated_at: string;
};

type EinvoiceRow = {
  id: string;
  invoice_id: string;
  provider_mode: 'sandbox' | 'live';
  status: 'pending' | 'generated' | 'cancelled' | 'failed';
  irn: string | null;
  ack_number: string | null;
  ack_date: string | null;
  signed_qr: string | null;
  irp_status: string;
  error_code: string;
  error_message: string;
  generated_at: string | null;
  created_at: string;
};

type EwayRow = {
  id: string;
  source_type: 'invoice' | 'delivery_note';
  source_id: string;
  provider_mode: 'sandbox' | 'live';
  status: 'pending' | 'generated' | 'cancelled' | 'failed';
  ewb_number: string | null;
  transporter_id: string;
  transporter_name: string;
  vehicle_number: string;
  transport_mode: 'road' | 'rail' | 'air' | 'ship';
  distance_km: number | string;
  from_place: string;
  to_place: string;
  valid_until: string | null;
  error_message: string;
  generated_at: string | null;
  created_at: string;
};

type GstnJobRow = {
  id: string;
  job_type: 'gstr1_push' | 'gstr2b_pull';
  period_year: number;
  period_month: number;
  provider_mode: 'sandbox' | 'live';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  row_count: number;
  reference_id: string;
  error_message: string;
  created_at: string;
  finished_at: string | null;
};

type CheckoutRow = {
  id: string;
  invoice_id: string;
  customer_id: string;
  amount: number | string;
  currency_code: string;
  provider: string;
  status: 'created' | 'pending' | 'paid' | 'failed' | 'cancelled';
  provider_reference: string;
  checkout_url: string;
  error_message: string;
  created_at: string;
};

function requireView(actor: RequestUser): void {
  if (!canViewIntegrations(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view finance integrations.', 403);
  }
}

function requireManage(actor: RequestUser): void {
  if (!canManageIntegrations(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage finance integrations.', 403);
  }
}

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function monthBounds(periodYear: number, periodMonth: number): { fromDate: string; toDate: string } {
  const month = String(periodMonth).padStart(2, '0');
  const lastDay = new Date(periodYear, periodMonth, 0).getDate();
  return {
    fromDate: `${periodYear}-${month}-01`,
    toDate: `${periodYear}-${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

function mapEinvoice(
  row: EinvoiceRow,
  invoiceNumber: string | null,
): EinvoiceRecord {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber,
    providerMode: row.provider_mode,
    status: row.status,
    irn: row.irn,
    ackNumber: row.ack_number,
    ackDate: row.ack_date,
    signedQr: row.signed_qr,
    irpStatus: row.irp_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

function mapEway(row: EwayRow, sourceNumber: string | null): EwayBillRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceNumber,
    providerMode: row.provider_mode,
    status: row.status,
    ewbNumber: row.ewb_number,
    transporterId: row.transporter_id,
    transporterName: row.transporter_name,
    vehicleNumber: row.vehicle_number,
    transportMode: row.transport_mode,
    distanceKm: num(row.distance_km),
    fromPlace: row.from_place,
    toPlace: row.to_place,
    validUntil: row.valid_until,
    errorMessage: row.error_message,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

function mapGstnJob(row: GstnJobRow): GstnSyncJob {
  return {
    id: row.id,
    jobType: row.job_type,
    periodYear: row.period_year,
    periodMonth: row.period_month,
    providerMode: row.provider_mode,
    status: row.status,
    rowCount: row.row_count,
    referenceId: row.reference_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function mapCheckout(row: CheckoutRow, invoiceNumber: string | null): PaymentCheckoutIntent {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber,
    customerId: row.customer_id,
    amount: num(row.amount),
    currencyCode: row.currency_code,
    provider: row.provider,
    status: row.status,
    providerReference: row.provider_reference,
    checkoutUrl: row.checkout_url,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function envReadiness(env: ReturnType<typeof loadEnv>) {
  return {
    gspMode: env.FINANCE_GSP_MODE,
    gspCredentialsConfigured: Boolean(
      env.FINANCE_GSP_BASE_URL && env.FINANCE_GSP_CLIENT_ID && env.FINANCE_GSP_CLIENT_SECRET,
    ),
    paymentGatewayConfigured: Boolean(
      env.FINANCE_PAYMENT_GATEWAY_PROVIDER !== 'none' &&
        env.FINANCE_PAYMENT_GATEWAY_KEY_ID &&
        env.FINANCE_PAYMENT_GATEWAY_KEY_SECRET,
    ),
    bankFeedConfigured: Boolean(
      env.FINANCE_BANK_FEED_PROVIDER !== 'none' && env.FINANCE_BANK_FEED_API_KEY,
    ),
  };
}

function mapSettings(row: SettingsRow, env: ReturnType<typeof loadEnv>): IntegrationSettings {
  return {
    id: row.id,
    gspMode: row.gsp_mode,
    paymentGatewayEnabled: row.payment_gateway_enabled,
    paymentGatewayProvider: row.payment_gateway_provider,
    bankFeedEnabled: row.bank_feed_enabled,
    bankFeedProvider: row.bank_feed_provider,
    notes: row.notes,
    env: envReadiness(env),
    updatedAt: row.updated_at,
  };
}

export function createIntegrationsService(supabase: SupabaseClient) {
  const env = loadEnv();

  async function loadSettingsRow(): Promise<SettingsRow> {
    const { data, error } = await supabase
      .from('finance_integration_settings')
      .select('*')
      .eq('organization_id', ORG_ID)
      .maybeSingle();
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load integration settings.', 500);
    }
    if (!data) {
      const { data: created, error: createErr } = await supabase
        .from('finance_integration_settings')
        .insert({ organization_id: ORG_ID, gsp_mode: 'sandbox' })
        .select('*')
        .single();
      if (createErr || !created) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          createErr?.message ?? 'Failed to create integration settings.',
          500,
        );
      }
      return created as SettingsRow;
    }
    return data as SettingsRow;
  }

  async function getProvider() {
    const settings = await loadSettingsRow();
    return { settings, provider: createGspProvider(env, settings.gsp_mode as GspMode) };
  }

  async function invoiceNumberMap(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length) return map;
    const { data } = await supabase.from('finance_invoices').select('id, document_number').in('id', ids);
    for (const row of data ?? []) {
      map.set(row.id as string, row.document_number as string);
    }
    return map;
  }

  async function deliveryNoteNumberMap(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length) return map;
    const { data } = await supabase
      .from('finance_delivery_notes')
      .select('id, document_number')
      .in('id', ids);
    for (const row of data ?? []) {
      map.set(row.id as string, row.document_number as string);
    }
    return map;
  }

  return {
    async getSettings(actor: RequestUser): Promise<IntegrationSettings> {
      requireView(actor);
      return mapSettings(await loadSettingsRow(), env);
    },

    async updateSettings(
      actor: RequestUser,
      input: {
        gspMode?: 'sandbox' | 'live';
        paymentGatewayEnabled?: boolean;
        paymentGatewayProvider?: 'none' | 'razorpay' | 'stripe';
        bankFeedEnabled?: boolean;
        bankFeedProvider?: 'none' | 'account_aggregator' | 'manual_api';
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<IntegrationSettings> {
      requireManage(actor);
      const current = await loadSettingsRow();
      const patch: Record<string, unknown> = { updated_by: actor.employeeId };
      if (input.gspMode !== undefined) patch.gsp_mode = input.gspMode;
      if (input.paymentGatewayEnabled !== undefined) {
        patch.payment_gateway_enabled = input.paymentGatewayEnabled;
      }
      if (input.paymentGatewayProvider !== undefined) {
        patch.payment_gateway_provider = input.paymentGatewayProvider;
      }
      if (input.bankFeedEnabled !== undefined) patch.bank_feed_enabled = input.bankFeedEnabled;
      if (input.bankFeedProvider !== undefined) patch.bank_feed_provider = input.bankFeedProvider;
      if (input.notes !== undefined) patch.notes = input.notes.trim();

      const { data, error } = await supabase
        .from('finance_integration_settings')
        .update(patch)
        .eq('id', current.id)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update settings.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.integrations.settings.update',
        entityType: 'finance_integration_settings',
        entityId: current.id,
        oldValues: current as unknown as Record<string, unknown>,
        newValues: data as unknown as Record<string, unknown>,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return mapSettings(data as SettingsRow, env);
    },

    async listEinvoices(actor: RequestUser): Promise<EinvoiceRecord[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_einvoices')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list e-invoices.', 500);
      }
      const rows = (data ?? []) as EinvoiceRow[];
      const numbers = await invoiceNumberMap(rows.map((r) => r.invoice_id));
      return rows.map((row) => mapEinvoice(row, numbers.get(row.invoice_id) ?? null));
    },

    async getEinvoiceByInvoice(actor: RequestUser, invoiceId: string): Promise<EinvoiceRecord | null> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_einvoices')
        .select('*')
        .eq('invoice_id', invoiceId)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load e-invoice.', 500);
      }
      if (!data) return null;
      const numbers = await invoiceNumberMap([invoiceId]);
      return mapEinvoice(data as EinvoiceRow, numbers.get(invoiceId) ?? null);
    },

    async generateEinvoice(
      actor: RequestUser,
      invoiceId: string,
      meta: RequestMeta,
    ): Promise<EinvoiceRecord> {
      requireManage(actor);
      const { data: invoice, error: invErr } = await supabase
        .from('finance_invoices')
        .select('*')
        .eq('id', invoiceId)
        .maybeSingle();
      if (invErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice.', 500);
      }
      if (!invoice) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Invoice not found.', 404);
      }
      if (!(invoice.journal_id as string | null)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Invoice must be posted (journal posted) before generating IRN.',
          400,
        );
      }

      const { data: existing } = await supabase
        .from('finance_einvoices')
        .select('*')
        .eq('invoice_id', invoiceId)
        .maybeSingle();
      if (existing && (existing as EinvoiceRow).status === 'generated') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'E-invoice IRN already generated for this invoice.',
          400,
        );
      }

      const [{ data: org }, { data: customer }] = await Promise.all([
        supabase.from('finance_organizations').select('gstin').eq('id', ORG_ID).maybeSingle(),
        supabase
          .from('finance_customers')
          .select('gstin')
          .eq('id', invoice.customer_id as string)
          .maybeSingle(),
      ]);
      const sellerGstin = ((org?.gstin as string | null) ?? env.FINANCE_GSP_GSTIN ?? '').trim();
      if (!sellerGstin) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Organisation GSTIN is required to generate e-invoice.',
          400,
        );
      }

      const { settings, provider } = await getProvider();
      const taxableValue = num(invoice.subtotal as number | string);
      const taxTotal = num(invoice.tax_total as number | string);
      const grandTotal = num(invoice.grand_total as number | string);
      const isIntraState = Boolean(invoice.is_intra_state);

      let result;
      try {
        result = await provider.generateEinvoice({
          invoiceId,
          documentNumber: invoice.document_number as string,
          invoiceDate: invoice.invoice_date as string,
          sellerGstin,
          buyerGstin: ((customer?.gstin as string | null) ?? null)?.trim() || null,
          taxableValue,
          taxTotal,
          grandTotal,
          isIntraState,
        });
      } catch (cause) {
        const message = cause instanceof AppError ? cause.message : 'GSP e-invoice generation failed.';
        const failPayload = {
          invoice_id: invoiceId,
          provider_mode: settings.gsp_mode,
          status: 'failed' as const,
          error_code: 'GSP_ERROR',
          error_message: message,
          generated_by: actor.employeeId,
        };
        if (existing) {
          await supabase.from('finance_einvoices').update(failPayload).eq('id', (existing as EinvoiceRow).id);
        } else {
          await supabase.from('finance_einvoices').insert(failPayload);
        }
        throw cause instanceof AppError
          ? cause
          : new AppError(API_ERROR_CODES.INTERNAL_ERROR, message, 502);
      }

      const upsertPayload = {
        invoice_id: invoiceId,
        provider_mode: result.mode,
        status: 'generated' as const,
        irn: result.irn,
        ack_number: result.ackNumber,
        ack_date: result.ackDate,
        signed_qr: result.signedQr,
        signed_invoice: result.signedInvoice,
        irp_status: result.irpStatus,
        error_code: '',
        error_message: '',
        request_payload: result.requestPayload,
        response_payload: result.responsePayload,
        generated_at: new Date().toISOString(),
        generated_by: actor.employeeId,
      };

      const { data: saved, error: saveErr } = existing
        ? await supabase
            .from('finance_einvoices')
            .update(upsertPayload)
            .eq('id', (existing as EinvoiceRow).id)
            .select('*')
            .single()
        : await supabase.from('finance_einvoices').insert(upsertPayload).select('*').single();

      if (saveErr || !saved) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          saveErr?.message ?? 'Failed to save e-invoice.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.integrations.einvoice.generate',
        entityType: 'finance_einvoices',
        entityId: (saved as EinvoiceRow).id,
        newValues: { invoiceId, irn: result.irn, mode: result.mode },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return mapEinvoice(saved as EinvoiceRow, invoice.document_number as string);
    },

    async cancelEinvoice(
      actor: RequestUser,
      id: string,
      input: { reason?: string },
      meta: RequestMeta,
    ): Promise<EinvoiceRecord> {
      requireManage(actor);
      const { data, error } = await supabase.from('finance_einvoices').select('*').eq('id', id).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load e-invoice.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'E-invoice not found.', 404);
      }
      const row = data as EinvoiceRow;
      if (row.status !== 'generated') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only generated e-invoices can be cancelled.',
          400,
        );
      }
      const reason = (input.reason ?? '').trim() || 'Cancelled';
      const { data: updated, error: updErr } = await supabase
        .from('finance_einvoices')
        .update({
          status: 'cancelled',
          cancel_reason: reason,
          irp_status: 'CNL',
        })
        .eq('id', id)
        .select('*')
        .single();
      if (updErr || !updated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr?.message ?? 'Failed to cancel.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.integrations.einvoice.cancel',
        entityType: 'finance_einvoices',
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: 'cancelled', reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      const numbers = await invoiceNumberMap([row.invoice_id]);
      return mapEinvoice(updated as EinvoiceRow, numbers.get(row.invoice_id) ?? null);
    },

    async listEwayBills(actor: RequestUser): Promise<EwayBillRecord[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_eway_bills')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list e-way bills.', 500);
      }
      const rows = (data ?? []) as EwayRow[];
      const invoiceIds = rows.filter((r) => r.source_type === 'invoice').map((r) => r.source_id);
      const dnIds = rows.filter((r) => r.source_type === 'delivery_note').map((r) => r.source_id);
      const [invMap, dnMap] = await Promise.all([
        invoiceNumberMap(invoiceIds),
        deliveryNoteNumberMap(dnIds),
      ]);
      return rows.map((row) =>
        mapEway(
          row,
          row.source_type === 'invoice'
            ? (invMap.get(row.source_id) ?? null)
            : (dnMap.get(row.source_id) ?? null),
        ),
      );
    },

    async generateEwayBill(
      actor: RequestUser,
      input: {
        sourceType: 'invoice' | 'delivery_note';
        sourceId: string;
        transporterId?: string;
        transporterName?: string;
        vehicleNumber?: string;
        transportMode?: 'road' | 'rail' | 'air' | 'ship';
        distanceKm?: number;
        fromPlace?: string;
        toPlace?: string;
      },
      meta: RequestMeta,
    ): Promise<EwayBillRecord> {
      requireManage(actor);

      let documentNumber = '';
      let documentDate = '';
      let grandTotal = 0;

      if (input.sourceType === 'invoice') {
        const { data: invoice, error } = await supabase
          .from('finance_invoices')
          .select('*')
          .eq('id', input.sourceId)
          .maybeSingle();
        if (error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice.', 500);
        }
        if (!invoice) {
          throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Invoice not found.', 404);
        }
        if (!(invoice.journal_id as string | null)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Invoice must be posted before generating e-Way Bill.',
            400,
          );
        }
        documentNumber = invoice.document_number as string;
        documentDate = invoice.invoice_date as string;
        grandTotal = num(invoice.grand_total as number | string);
      } else {
        const { data: note, error } = await supabase
          .from('finance_delivery_notes')
          .select('*')
          .eq('id', input.sourceId)
          .maybeSingle();
        if (error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load delivery note.', 500);
        }
        if (!note) {
          throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Delivery note not found.', 404);
        }
        if ((note.status as string) !== 'delivered') {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Delivery note must be delivered before generating e-Way Bill.',
            400,
          );
        }
        documentNumber = note.document_number as string;
        documentDate = (note.delivery_date as string) || (note.created_at as string).slice(0, 10);
        grandTotal = 0;
      }

      const { data: existing } = await supabase
        .from('finance_eway_bills')
        .select('*')
        .eq('source_type', input.sourceType)
        .eq('source_id', input.sourceId)
        .maybeSingle();
      if (existing && (existing as EwayRow).status === 'generated') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'E-Way Bill already generated for this source.',
          400,
        );
      }

      const { settings, provider } = await getProvider();
      let result;
      try {
        result = await provider.generateEwayBill({
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          documentNumber,
          documentDate,
          transporterId: input.transporterId,
          transporterName: input.transporterName,
          vehicleNumber: input.vehicleNumber,
          transportMode: input.transportMode,
          distanceKm: input.distanceKm,
          fromPlace: input.fromPlace,
          toPlace: input.toPlace,
          grandTotal,
        });
      } catch (cause) {
        const message = cause instanceof AppError ? cause.message : 'GSP e-Way generation failed.';
        const failPayload = {
          source_type: input.sourceType,
          source_id: input.sourceId,
          provider_mode: settings.gsp_mode,
          status: 'failed' as const,
          transporter_id: input.transporterId?.trim() ?? '',
          transporter_name: input.transporterName?.trim() ?? '',
          vehicle_number: input.vehicleNumber?.trim() ?? '',
          transport_mode: input.transportMode ?? 'road',
          distance_km: input.distanceKm ?? 0,
          from_place: input.fromPlace?.trim() ?? '',
          to_place: input.toPlace?.trim() ?? '',
          error_message: message,
          generated_by: actor.employeeId,
        };
        if (existing) {
          await supabase.from('finance_eway_bills').update(failPayload).eq('id', (existing as EwayRow).id);
        } else {
          await supabase.from('finance_eway_bills').insert(failPayload);
        }
        throw cause instanceof AppError
          ? cause
          : new AppError(API_ERROR_CODES.INTERNAL_ERROR, message, 502);
      }

      const upsertPayload = {
        source_type: input.sourceType,
        source_id: input.sourceId,
        provider_mode: result.mode,
        status: 'generated' as const,
        ewb_number: result.ewbNumber,
        transporter_id: input.transporterId?.trim() ?? '',
        transporter_name: input.transporterName?.trim() ?? '',
        vehicle_number: input.vehicleNumber?.trim() ?? '',
        transport_mode: input.transportMode ?? 'road',
        distance_km: input.distanceKm ?? 0,
        from_place: input.fromPlace?.trim() ?? '',
        to_place: input.toPlace?.trim() ?? '',
        valid_until: result.validUntil || null,
        error_code: '',
        error_message: '',
        request_payload: result.requestPayload,
        response_payload: result.responsePayload,
        generated_at: new Date().toISOString(),
        generated_by: actor.employeeId,
      };

      const { data: saved, error: saveErr } = existing
        ? await supabase
            .from('finance_eway_bills')
            .update(upsertPayload)
            .eq('id', (existing as EwayRow).id)
            .select('*')
            .single()
        : await supabase.from('finance_eway_bills').insert(upsertPayload).select('*').single();

      if (saveErr || !saved) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          saveErr?.message ?? 'Failed to save e-Way Bill.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.integrations.eway.generate',
        entityType: 'finance_eway_bills',
        entityId: (saved as EwayRow).id,
        newValues: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          ewbNumber: result.ewbNumber,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return mapEway(saved as EwayRow, documentNumber);
    },

    async listGstnJobs(actor: RequestUser): Promise<GstnSyncJob[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_gstn_sync_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list GSTN jobs.', 500);
      }
      return ((data ?? []) as GstnJobRow[]).map(mapGstnJob);
    },

    async pushGstr1(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number },
      meta: RequestMeta,
    ): Promise<GstnSyncJob> {
      requireManage(actor);
      if (input.periodMonth < 1 || input.periodMonth > 12) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'periodMonth must be 1–12.', 400);
      }
      const { fromDate, toDate } = monthBounds(input.periodYear, input.periodMonth);
      const { data: invoices, error: invErr } = await supabase
        .from('finance_invoices')
        .select('id, subtotal, tax_total, grand_total')
        .gte('invoice_date', fromDate)
        .lte('invoice_date', toDate)
        .not('journal_id', 'is', null);
      if (invErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices for GSTR-1.', 500);
      }
      const rows = invoices ?? [];
      const rowCount = rows.length;
      const summary = {
        fromDate,
        toDate,
        invoiceCount: rowCount,
        taxableValue: rows.reduce((s, r) => s + num(r.subtotal as number | string), 0),
        taxTotal: rows.reduce((s, r) => s + num(r.tax_total as number | string), 0),
        grandTotal: rows.reduce((s, r) => s + num(r.grand_total as number | string), 0),
      };

      const { settings, provider } = await getProvider();
      const { data: job, error: jobErr } = await supabase
        .from('finance_gstn_sync_jobs')
        .insert({
          job_type: 'gstr1_push',
          period_year: input.periodYear,
          period_month: input.periodMonth,
          provider_mode: settings.gsp_mode,
          status: 'running',
          row_count: rowCount,
          request_payload: { periodYear: input.periodYear, periodMonth: input.periodMonth, summary },
          created_by: actor.employeeId,
          started_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (jobErr || !job) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, jobErr?.message ?? 'Failed to create job.', 500);
      }

      try {
        const result = await provider.pushGstr1({
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
          rowCount,
          summary,
        });
        const { data: finished, error: finErr } = await supabase
          .from('finance_gstn_sync_jobs')
          .update({
            status: 'succeeded',
            reference_id: result.referenceId,
            response_payload: result.responsePayload,
            finished_at: new Date().toISOString(),
          })
          .eq('id', (job as GstnJobRow).id)
          .select('*')
          .single();
        if (finErr || !finished) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, finErr?.message ?? 'Failed to finish job.', 500);
        }
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance.integrations.gstn.gstr1_push',
          entityType: 'finance_gstn_sync_jobs',
          entityId: (finished as GstnJobRow).id,
          newValues: { periodYear: input.periodYear, periodMonth: input.periodMonth, rowCount },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        return mapGstnJob(finished as GstnJobRow);
      } catch (cause) {
        const message = cause instanceof AppError ? cause.message : 'GSTR-1 push failed.';
        await supabase
          .from('finance_gstn_sync_jobs')
          .update({
            status: 'failed',
            error_message: message,
            finished_at: new Date().toISOString(),
          })
          .eq('id', (job as GstnJobRow).id);
        throw cause instanceof AppError
          ? cause
          : new AppError(API_ERROR_CODES.INTERNAL_ERROR, message, 502);
      }
    },

    async pullGstr2b(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number },
      meta: RequestMeta,
    ): Promise<GstnSyncJob> {
      requireManage(actor);
      if (input.periodMonth < 1 || input.periodMonth > 12) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'periodMonth must be 1–12.', 400);
      }

      const { settings, provider } = await getProvider();
      const { data: job, error: jobErr } = await supabase
        .from('finance_gstn_sync_jobs')
        .insert({
          job_type: 'gstr2b_pull',
          period_year: input.periodYear,
          period_month: input.periodMonth,
          provider_mode: settings.gsp_mode,
          status: 'running',
          request_payload: { periodYear: input.periodYear, periodMonth: input.periodMonth },
          created_by: actor.employeeId,
          started_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (jobErr || !job) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, jobErr?.message ?? 'Failed to create job.', 500);
      }

      try {
        const result = await provider.pullGstr2b({
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
        });
        const { data: finished, error: finErr } = await supabase
          .from('finance_gstn_sync_jobs')
          .update({
            status: 'succeeded',
            row_count: result.rowCount,
            reference_id: result.referenceId,
            response_payload: result.responsePayload,
            finished_at: new Date().toISOString(),
          })
          .eq('id', (job as GstnJobRow).id)
          .select('*')
          .single();
        if (finErr || !finished) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, finErr?.message ?? 'Failed to finish job.', 500);
        }
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance.integrations.gstn.gstr2b_pull',
          entityType: 'finance_gstn_sync_jobs',
          entityId: (finished as GstnJobRow).id,
          newValues: {
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
            rowCount: result.rowCount,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        return mapGstnJob(finished as GstnJobRow);
      } catch (cause) {
        const message = cause instanceof AppError ? cause.message : 'GSTR-2B pull failed.';
        await supabase
          .from('finance_gstn_sync_jobs')
          .update({
            status: 'failed',
            error_message: message,
            finished_at: new Date().toISOString(),
          })
          .eq('id', (job as GstnJobRow).id);
        throw cause instanceof AppError
          ? cause
          : new AppError(API_ERROR_CODES.INTERNAL_ERROR, message, 502);
      }
    },

    async createPaymentCheckout(
      actor: RequestUser,
      input: { invoiceId: string },
      meta: RequestMeta,
    ): Promise<PaymentCheckoutIntent> {
      requireManage(actor);
      const settings = await loadSettingsRow();
      if (!settings.payment_gateway_enabled || settings.payment_gateway_provider === 'none') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Payment gateway is not enabled. Enable it under Integrations settings.',
          400,
        );
      }
      const keysConfigured =
        env.FINANCE_PAYMENT_GATEWAY_KEY_ID.length > 0 &&
        env.FINANCE_PAYMENT_GATEWAY_KEY_SECRET.length > 0;
      // Without live keys we still create a sandbox-like intent (no Razorpay/Stripe call).

      const { data: invoice, error: invErr } = await supabase
        .from('finance_invoices')
        .select('*')
        .eq('id', input.invoiceId)
        .maybeSingle();
      if (invErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice.', 500);
      }
      if (!invoice) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Invoice not found.', 404);
      }
      if (!(invoice.journal_id as string | null)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only posted invoices can create payment checkouts.',
          400,
        );
      }
      const outstanding =
        num(invoice.grand_total as number | string) - num(invoice.amount_paid as number | string);
      if (!(outstanding > 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invoice has no outstanding balance.', 400);
      }

      const provider = settings.payment_gateway_provider;
      const portalBase = env.PORTAL_PUBLIC_URL.replace(/\/$/, '');
      const checkoutUrl = keysConfigured
        ? `${portalBase || 'about:blank'}/finance/payments?checkout=pending`
        : 'about:blank';
      const providerReference = keysConfigured
        ? `PENDING-${provider.toUpperCase()}`
        : `SANDBOX-${Date.now()}`;

      const { data: created, error: createErr } = await supabase
        .from('finance_payment_checkout_intents')
        .insert({
          invoice_id: input.invoiceId,
          customer_id: invoice.customer_id as string,
          amount: outstanding,
          currency_code: 'INR',
          provider,
          status: 'created',
          provider_reference: providerReference,
          checkout_url: checkoutUrl,
          error_message: keysConfigured
            ? ''
            : 'Gateway keys not configured; placeholder checkout URL only. See docs/finance_gsp_runbook.md.',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (createErr || !created) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          createErr?.message ?? 'Failed to create checkout intent.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.integrations.payment_checkout.create',
        entityType: 'finance_payment_checkout_intents',
        entityId: (created as CheckoutRow).id,
        newValues: { invoiceId: input.invoiceId, amount: outstanding, provider },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return mapCheckout(created as CheckoutRow, invoice.document_number as string);
    },

    async listPaymentCheckouts(actor: RequestUser): Promise<PaymentCheckoutIntent[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_payment_checkout_intents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list payment checkouts.', 500);
      }
      const rows = (data ?? []) as CheckoutRow[];
      const numbers = await invoiceNumberMap(rows.map((r) => r.invoice_id));
      return rows.map((row) => mapCheckout(row, numbers.get(row.invoice_id) ?? null));
    },
  };
}
