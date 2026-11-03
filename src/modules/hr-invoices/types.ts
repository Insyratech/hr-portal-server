import type { HrInvoiceCurrency } from './money';

export type HrInvoiceClient = {
  id: string;
  name: string;
  address: string;
};

export type HrInvoiceLine = {
  id: string;
  description: string;
  detail: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type HrInvoiceSummary = {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  reference: string;
  currency: HrInvoiceCurrency;
  companyName: string;
  clientName: string;
  total: number;
  createdAt: string;
};

export type HrInvoiceDetail = HrInvoiceSummary & {
  companyId: string;
  clientId: string;
  issuerAddress: string;
  issuerEmail: string;
  logoUrl: string | null;
  clientAddress: string;
  signatureName: string;
  lines: HrInvoiceLine[];
};

export type CreateHrInvoiceLineInput = {
  description: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
};

export type CreateHrInvoiceInput = {
  companyId: string;
  clientId?: string | null;
  client?: { name: string; address?: string } | null;
  issueDate: string;
  dueDate: string;
  reference?: string;
  currency: string;
  issuerEmail: string;
  signatureName: string;
  lines: CreateHrInvoiceLineInput[];
};
