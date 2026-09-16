import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export type GspMode = 'sandbox' | 'live';

export type EinvoiceGenerateInput = {
  invoiceId: string;
  documentNumber: string;
  invoiceDate: string;
  sellerGstin: string;
  buyerGstin: string | null;
  taxableValue: number;
  taxTotal: number;
  grandTotal: number;
  isIntraState: boolean;
};

export type EinvoiceGenerateResult = {
  mode: GspMode;
  irn: string;
  ackNumber: string;
  ackDate: string;
  signedQr: string;
  signedInvoice: string;
  irpStatus: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
};

export type EwayGenerateInput = {
  sourceType: 'invoice' | 'delivery_note';
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  transporterId?: string;
  transporterName?: string;
  vehicleNumber?: string;
  transportMode?: 'road' | 'rail' | 'air' | 'ship';
  distanceKm?: number;
  fromPlace?: string;
  toPlace?: string;
  grandTotal: number;
};

export type EwayGenerateResult = {
  mode: GspMode;
  ewbNumber: string;
  validUntil: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
};

export type Gstr1PushInput = {
  periodYear: number;
  periodMonth: number;
  rowCount: number;
  summary: Record<string, unknown>;
};

export type Gstr2bPullInput = {
  periodYear: number;
  periodMonth: number;
};

export type GspProvider = {
  mode: GspMode;
  generateEinvoice(input: EinvoiceGenerateInput): Promise<EinvoiceGenerateResult>;
  generateEwayBill(input: EwayGenerateInput): Promise<EwayGenerateResult>;
  pushGstr1(input: Gstr1PushInput): Promise<{ referenceId: string; responsePayload: Record<string, unknown> }>;
  pullGstr2b(input: Gstr2bPullInput): Promise<{ referenceId: string; rowCount: number; responsePayload: Record<string, unknown> }>;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireLiveCredentials(env: Env): void {
  if (!env.FINANCE_GSP_BASE_URL || !env.FINANCE_GSP_CLIENT_ID || !env.FINANCE_GSP_CLIENT_SECRET) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'Live GSP mode requires FINANCE_GSP_BASE_URL, FINANCE_GSP_CLIENT_ID, and FINANCE_GSP_CLIENT_SECRET. See docs/finance_gsp_runbook.md.',
      400,
    );
  }
}

function createSandboxProvider(): GspProvider {
  return {
    mode: 'sandbox',
    async generateEinvoice(input) {
      const seed = `${input.documentNumber}|${input.invoiceDate}|${input.grandTotal}|${input.sellerGstin}`;
      const irn = sha256Hex(`SANDBOX-IRN|${seed}`);
      const ackNumber = `ACK${Date.now().toString().slice(-10)}`;
      const ackDate = new Date().toISOString();
      const signedQr = JSON.stringify({
        SellerGstin: input.sellerGstin || 'SANDBOXGSTIN',
        BuyerGstin: input.buyerGstin || 'URP',
        DocNo: input.documentNumber,
        DocDt: input.invoiceDate,
        TotInvVal: input.grandTotal,
        ItemCnt: 1,
        MainHsnCode: '',
        Irn: irn,
        mode: 'sandbox',
      });
      const requestPayload = {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: input.buyerGstin ? 'B2B' : 'B2C' },
        DocDtls: { Typ: 'INV', No: input.documentNumber, Dt: input.invoiceDate },
        ValDtls: {
          AssVal: input.taxableValue,
          IgstVal: input.isIntraState ? 0 : input.taxTotal,
          CgstVal: input.isIntraState ? Math.round((input.taxTotal / 2) * 100) / 100 : 0,
          SgstVal: input.isIntraState ? Math.round((input.taxTotal / 2) * 100) / 100 : 0,
          TotInvVal: input.grandTotal,
        },
      };
      return {
        mode: 'sandbox',
        irn,
        ackNumber,
        ackDate,
        signedQr,
        signedInvoice: Buffer.from(JSON.stringify({ irn, ackNumber, ...requestPayload })).toString('base64'),
        irpStatus: 'ACT',
        requestPayload,
        responsePayload: {
          Status: '1',
          Irn: irn,
          AckNo: ackNumber,
          AckDt: ackDate,
          SignedQRCode: signedQr,
          provider: 'sandbox',
        },
      };
    },
    async generateEwayBill(input) {
      const ewbNumber = `99${Date.now().toString().slice(-10)}`;
      const validUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const requestPayload = {
        supplyType: 'O',
        docType: input.sourceType === 'invoice' ? 'INV' : 'CHL',
        docNo: input.documentNumber,
        docDate: input.documentDate,
        transporterId: input.transporterId ?? '',
        vehicleNo: input.vehicleNumber ?? '',
        transMode: input.transportMode ?? 'road',
        distance: input.distanceKm ?? 0,
        fromPlace: input.fromPlace ?? '',
        toPlace: input.toPlace ?? '',
        totInvValue: input.grandTotal,
      };
      return {
        mode: 'sandbox',
        ewbNumber,
        validUntil,
        requestPayload,
        responsePayload: {
          ewayBillNo: ewbNumber,
          validUpto: validUntil,
          provider: 'sandbox',
        },
      };
    },
    async pushGstr1(input) {
      const referenceId = `SBX-GSTR1-${input.periodYear}${String(input.periodMonth).padStart(2, '0')}-${randomBytes(3).toString('hex')}`;
      return {
        referenceId,
        responsePayload: {
          status: 'succeeded',
          referenceId,
          rowCount: input.rowCount,
          summary: input.summary,
          provider: 'sandbox',
        },
      };
    },
    async pullGstr2b(input) {
      const referenceId = `SBX-GSTR2B-${input.periodYear}${String(input.periodMonth).padStart(2, '0')}-${randomBytes(3).toString('hex')}`;
      return {
        referenceId,
        rowCount: 0,
        responsePayload: {
          status: 'succeeded',
          referenceId,
          period: `${input.periodYear}-${String(input.periodMonth).padStart(2, '0')}`,
          documents: [],
          note: 'Sandbox pull returns empty 2B; wire licensed GSP for production data.',
          provider: 'sandbox',
        },
      };
    },
  };
}

/**
 * Live provider: validates credentials and POSTs to configured GSP base URL.
 * Paths are conventional placeholders — replace with your licensed GSP's API map.
 */
function createLiveProvider(env: Env): GspProvider {
  requireLiveCredentials(env);
  const base = env.FINANCE_GSP_BASE_URL.replace(/\/$/, '');

  async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': env.FINANCE_GSP_CLIENT_ID,
        'X-Client-Secret': env.FINANCE_GSP_CLIENT_SECRET,
        'X-Gstin': env.FINANCE_GSP_GSTIN,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      throw new AppError(
        API_ERROR_CODES.INTERNAL_ERROR,
        `GSP call failed (${response.status}): ${(json.message as string) || text || 'unknown error'}`,
        502,
      );
    }
    return json;
  }

  return {
    mode: 'live',
    async generateEinvoice(input) {
      const requestPayload = {
        documentNumber: input.documentNumber,
        invoiceDate: input.invoiceDate,
        sellerGstin: input.sellerGstin || env.FINANCE_GSP_GSTIN,
        buyerGstin: input.buyerGstin,
        taxableValue: input.taxableValue,
        taxTotal: input.taxTotal,
        grandTotal: input.grandTotal,
      };
      const responsePayload = await postJson('/einvoice/generate', requestPayload);
      const irn = String(responsePayload.irn ?? responsePayload.Irn ?? '');
      const signedQr = String(responsePayload.signedQr ?? responsePayload.SignedQRCode ?? '');
      if (!irn) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'GSP response missing IRN.', 502);
      }
      return {
        mode: 'live',
        irn,
        ackNumber: String(responsePayload.ackNumber ?? responsePayload.AckNo ?? ''),
        ackDate: String(responsePayload.ackDate ?? responsePayload.AckDt ?? new Date().toISOString()),
        signedQr,
        signedInvoice: String(responsePayload.signedInvoice ?? responsePayload.SignedInvoice ?? ''),
        irpStatus: String(responsePayload.irpStatus ?? responsePayload.Status ?? 'ACT'),
        requestPayload,
        responsePayload,
      };
    },
    async generateEwayBill(input) {
      const requestPayload = { ...input };
      const responsePayload = await postJson('/eway/generate', requestPayload as unknown as Record<string, unknown>);
      const ewbNumber = String(responsePayload.ewbNumber ?? responsePayload.ewayBillNo ?? '');
      if (!ewbNumber) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'GSP response missing e-Way Bill number.', 502);
      }
      return {
        mode: 'live',
        ewbNumber,
        validUntil: String(responsePayload.validUntil ?? responsePayload.validUpto ?? '').slice(0, 10),
        requestPayload: requestPayload as unknown as Record<string, unknown>,
        responsePayload,
      };
    },
    async pushGstr1(input) {
      const responsePayload = await postJson('/gstn/gstr1/push', input as unknown as Record<string, unknown>);
      return {
        referenceId: String(responsePayload.referenceId ?? responsePayload.refId ?? ''),
        responsePayload,
      };
    },
    async pullGstr2b(input) {
      const responsePayload = await postJson('/gstn/gstr2b/pull', input as unknown as Record<string, unknown>);
      return {
        referenceId: String(responsePayload.referenceId ?? responsePayload.refId ?? ''),
        rowCount: Number(responsePayload.rowCount ?? 0),
        responsePayload,
      };
    },
  };
}

export function createGspProvider(env: Env, settingsMode?: GspMode | null): GspProvider {
  const mode = settingsMode ?? env.FINANCE_GSP_MODE;
  if (mode === 'live') {
    return createLiveProvider(env);
  }
  return createSandboxProvider();
}
