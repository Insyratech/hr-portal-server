export type SalesLineInput = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit?: string;
  rate: number;
  taxPercent: number;
  catalogNo?: string;
  hsnSac?: string;
};

export type SalesQuoteLine = SalesLineInput & {
  id: string;
  lineOrder: number;
  amount: number;
  taxAmount: number;
};

export type SalesQuote = {
  id: string;
  documentNumber: string;
  customerId: string;
  customerName: string | null;
  quoteDate: string;
  expiryDate: string | null;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted' | 'cancelled';
  notes: string;
  terms: string;
  subject: string;
  referenceText: string;
  placeOfSupply: string;
  orgGstProfileId: string | null;
  billingAddressSnapshot: string;
  shippingAddressSnapshot: string;
  customerGstinSnapshot: string | null;
  shipToName: string;
  versionNumber: number;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  lines: SalesQuoteLine[];
  createdAt: string;
  updatedAt: string;
};

export type SalesQuoteVersion = {
  id: string;
  quoteId: string;
  versionNumber: number;
  changeNote: string;
  snapshot: SalesQuote;
  createdBy: string | null;
  createdAt: string;
};

export type SalesQuoteDetail = SalesQuote & {
  versions: SalesQuoteVersion[];
  letterhead: {
    id: string;
    label: string;
    gstin: string;
    legalName: string;
    tradeName: string;
    cin: string | null;
    addressLine1: string;
    addressLine2: string;
    city: string;
    postalCode: string;
    stateName: string | null;
    logoUrl: string | null;
  } | null;
};

export type SalesOrderLine = SalesLineInput & {
  id: string;
  lineOrder: number;
  amount: number;
  taxAmount: number;
  quantityDelivered: number;
  quantityInvoiced: number;
};

export type SalesOrder = {
  id: string;
  documentNumber: string;
  customerId: string;
  customerName: string | null;
  quoteId: string | null;
  orderDate: string;
  expectedDelivery: string | null;
  billingAddress: string;
  shippingAddress: string;
  notes: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  lines: SalesOrderLine[];
  createdAt: string;
  updatedAt: string;
};

export type DeliveryNoteLine = {
  id: string;
  salesOrderLineId: string;
  quantityDelivered: number;
  description: string;
};

export type DeliveryNote = {
  id: string;
  documentNumber: string;
  salesOrderId: string;
  salesOrderNumber: string | null;
  customerId: string;
  customerName: string | null;
  deliveryDate: string;
  notes: string;
  status: string;
  lines: DeliveryNoteLine[];
  createdAt: string;
};

export type InvoiceLine = {
  id: string;
  salesOrderLineId: string | null;
  itemId: string | null;
  incomeAccountId: string | null;
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  taxPercent: number;
  amount: number;
  taxAmount: number;
};

export type SalesInvoice = {
  id: string;
  documentNumber: string;
  customerId: string;
  customerName: string | null;
  salesOrderId: string | null;
  deliveryNoteId: string | null;
  quoteId: string | null;
  invoiceDate: string;
  dueDate: string | null;
  notes: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  journalId: string | null;
  lines: InvoiceLine[];
  createdAt: string;
  updatedAt: string;
};

export type CustomerPaymentAllocation = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amount: number;
};

export type CustomerPayment = {
  id: string;
  documentNumber: string;
  customerId: string;
  customerName: string | null;
  paymentDate: string;
  amount: number;
  bankAccountId: string | null;
  method: string;
  reference: string;
  notes: string;
  status: string;
  journalId: string | null;
  allocations: CustomerPaymentAllocation[];
  createdAt: string;
};

export type CreditNoteLine = {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  taxPercent: number;
  amount: number;
  taxAmount: number;
};

export type CustomerCreditNote = {
  id: string;
  documentNumber: string;
  customerId: string;
  customerName: string | null;
  invoiceId: string | null;
  creditDate: string;
  reason: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  journalId: string | null;
  lines: CreditNoteLine[];
  createdAt: string;
};

export type SalesDocumentPrint = {
  organization: {
    legalName: string;
    tradeName: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    postalCode: string;
    stateName?: string | null;
    gstin: string | null;
    cin?: string | null;
    logoUrl?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  customer: {
    displayName: string;
    gstin: string | null;
    billingAddress: string;
    shippingAddress?: string;
    shipToName?: string;
  };
  document: {
    type: 'quote' | 'invoice' | 'delivery_note';
    documentNumber: string;
    date: string;
    expiryDate?: string | null;
    subject?: string;
    referenceText?: string;
    placeOfSupply?: string;
    status: string;
    notes: string;
    terms?: string;
    amountInWords?: string;
    subtotal?: number;
    taxTotal?: number;
    grandTotal?: number;
    lines: Array<{
      description: string;
      quantity: number;
      unit?: string;
      rate?: number;
      taxPercent?: number;
      amount?: number;
      taxAmount?: number;
      catalogNo?: string;
      hsnSac?: string;
    }>;
    einvoice?: {
      irn: string;
      ackNumber: string | null;
      signedQr: string | null;
    } | null;
  };
};
