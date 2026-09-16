export type IndentLineInput = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit?: string;
  estimatedRate: number;
};

export type PurchaseIndentLine = IndentLineInput & {
  id: string;
  lineOrder: number;
  amount: number;
};

export type PurchaseIndent = {
  id: string;
  documentNumber: string;
  requestedBy: string;
  requesterName: string | null;
  departmentId: string | null;
  requiredDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  purpose: string;
  justification: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'converted';
  estimatedTotal: number;
  reviewerId: string | null;
  reviewerComment: string | null;
  decidedAt: string | null;
  lines: PurchaseIndentLine[];
  createdAt: string;
  updatedAt: string;
};

export type PoLineInput = {
  itemId?: string | null;
  description: string;
  quantity: number;
  unit?: string;
  rate: number;
  taxPercent: number;
};

export type PurchaseOrderLine = PoLineInput & {
  id: string;
  lineOrder: number;
  amount: number;
  taxAmount: number;
  quantityReceived: number;
  quantityBilled: number;
};

export type PurchaseOrder = {
  id: string;
  documentNumber: string;
  vendorId: string;
  vendorName: string | null;
  indentId: string | null;
  rfqId: string | null;
  vendorQuoteId: string | null;
  orderDate: string;
  expectedDelivery: string | null;
  billingAddress: string;
  deliveryAddress: string;
  paymentTermsDays: number;
  notes: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  lines: PurchaseOrderLine[];
  createdAt: string;
  updatedAt: string;
};

export type PurchaseReceiptLine = {
  id: string;
  purchaseOrderLineId: string;
  quantityReceived: number;
  description: string;
};

export type PurchaseReceipt = {
  id: string;
  documentNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string | null;
  receiptDate: string;
  notes: string;
  status: string;
  lines: PurchaseReceiptLine[];
  createdAt: string;
};

export type VendorBillLine = {
  id: string;
  purchaseOrderLineId: string | null;
  itemId: string | null;
  expenseAccountId: string | null;
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  taxPercent: number;
  amount: number;
  taxAmount: number;
  hsnSac: string;
};

export type VendorBill = {
  id: string;
  documentNumber: string;
  vendorId: string;
  vendorName: string | null;
  purchaseOrderId: string | null;
  receiptId: string | null;
  billDate: string;
  dueDate: string | null;
  vendorInvoiceNumber: string | null;
  notes: string;
  status: string;
  matchStatus: string;
  matchNotes: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  amountDue: number;
  placeOfSupplyState: string | null;
  isIntraState: boolean | null;
  tdsSection: string;
  tdsPercent: number;
  tdsAmount: number;
  itcEligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed';
  lines: VendorBillLine[];
  createdAt: string;
};

export type VendorPaymentAllocation = {
  billId: string;
  billNumber: string | null;
  amount: number;
};

export type VendorPayment = {
  id: string;
  documentNumber: string;
  vendorId: string;
  vendorName: string | null;
  paymentDate: string;
  amount: number;
  bankAccountId: string | null;
  method: string;
  reference: string;
  notes: string;
  status: string;
  allocations: VendorPaymentAllocation[];
  createdAt: string;
};

export type VendorCredit = {
  id: string;
  documentNumber: string;
  vendorId: string;
  vendorName: string | null;
  billId: string | null;
  creditDate: string;
  reason: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  lines: {
    id: string;
    description: string;
    quantity: number;
    rate: number;
    taxPercent: number;
    amount: number;
    taxAmount: number;
  }[];
  createdAt: string;
};

export type Rfq = {
  id: string;
  documentNumber: string;
  indentId: string | null;
  title: string;
  status: string;
  notes: string;
  vendorIds: string[];
  lines: { id: string; itemId: string | null; description: string; quantity: number; unit: string }[];
  createdAt: string;
};

export type VendorQuote = {
  id: string;
  documentNumber: string;
  rfqId: string;
  vendorId: string;
  vendorName: string | null;
  quoteDate: string;
  deliveryDays: number;
  shippingAmount: number;
  notes: string;
  status: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  lines: {
    id: string;
    description: string;
    quantity: number;
    unit: string;
    rate: number;
    taxPercent: number;
    amount: number;
    taxAmount: number;
  }[];
  createdAt: string;
};

export type PurchaseOrderPrint = {
  organization: {
    legalName: string;
    tradeName: string;
    gstin: string | null;
    addressLine1: string;
    city: string;
    stateName: string | null;
    postalCode: string;
  };
  order: PurchaseOrder;
  vendor: {
    displayName: string;
    gstin: string | null;
    billingAddress: string;
    stateName: string | null;
  };
};
