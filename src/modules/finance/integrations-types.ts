export type EinvoiceRecord = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  providerMode: 'sandbox' | 'live';
  status: 'pending' | 'generated' | 'cancelled' | 'failed';
  irn: string | null;
  ackNumber: string | null;
  ackDate: string | null;
  signedQr: string | null;
  irpStatus: string;
  errorCode: string;
  errorMessage: string;
  generatedAt: string | null;
  createdAt: string;
};

export type EwayBillRecord = {
  id: string;
  sourceType: 'invoice' | 'delivery_note';
  sourceId: string;
  sourceNumber: string | null;
  providerMode: 'sandbox' | 'live';
  status: 'pending' | 'generated' | 'cancelled' | 'failed';
  ewbNumber: string | null;
  transporterId: string;
  transporterName: string;
  vehicleNumber: string;
  transportMode: 'road' | 'rail' | 'air' | 'ship';
  distanceKm: number;
  fromPlace: string;
  toPlace: string;
  validUntil: string | null;
  errorMessage: string;
  generatedAt: string | null;
  createdAt: string;
};

export type GstnSyncJob = {
  id: string;
  jobType: 'gstr1_push' | 'gstr2b_pull';
  periodYear: number;
  periodMonth: number;
  providerMode: 'sandbox' | 'live';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  rowCount: number;
  referenceId: string;
  errorMessage: string;
  createdAt: string;
  finishedAt: string | null;
};

export type IntegrationSettings = {
  id: string;
  gspMode: 'sandbox' | 'live';
  paymentGatewayEnabled: boolean;
  paymentGatewayProvider: 'none' | 'razorpay' | 'stripe';
  bankFeedEnabled: boolean;
  bankFeedProvider: 'none' | 'account_aggregator' | 'manual_api';
  notes: string;
  /** Env-derived readiness (never exposes secrets). */
  env: {
    gspMode: 'sandbox' | 'live';
    gspCredentialsConfigured: boolean;
    paymentGatewayConfigured: boolean;
    bankFeedConfigured: boolean;
  };
  updatedAt: string;
};

export type PaymentCheckoutIntent = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customerId: string;
  amount: number;
  currencyCode: string;
  provider: string;
  status: 'created' | 'pending' | 'paid' | 'failed' | 'cancelled';
  providerReference: string;
  checkoutUrl: string;
  errorMessage: string;
  createdAt: string;
};
