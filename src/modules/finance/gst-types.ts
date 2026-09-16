export type GstTaxSplit = {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
};

export type GstValidationIssue = {
  code: 'missing_party_state' | 'missing_org_state' | 'missing_gstin' | 'missing_hsn';
  message: string;
};

export type GstOutwardRow = {
  documentType: 'invoice' | 'credit_note';
  documentId: string;
  documentNumber: string;
  documentDate: string;
  customerId: string;
  customerName: string | null;
  customerGstin: string | null;
  placeOfSupplyState: string | null;
  isIntraState: boolean;
  supplyType: 'B2B' | 'B2C';
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  grandTotal: number;
  /** Credit notes are negative for register totals. */
  signedTaxableValue: number;
  signedTaxTotal: number;
  issues: GstValidationIssue[];
};

export type GstInwardRow = {
  documentType: 'vendor_bill';
  documentId: string;
  documentNumber: string;
  documentDate: string;
  vendorId: string;
  vendorName: string | null;
  vendorGstin: string | null;
  placeOfSupplyState: string | null;
  isIntraState: boolean;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  grandTotal: number;
  tdsSection: string;
  tdsPercent: number;
  tdsAmount: number;
  itcEligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed';
  itcAmount: number;
  issues: GstValidationIssue[];
};

export type GstItcRow = {
  billId: string;
  documentNumber: string;
  billDate: string;
  vendorName: string | null;
  vendorGstin: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  itcEligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed';
  itcAmount: number;
};

export type GstHsnSummaryRow = {
  hsnSac: string;
  direction: 'outward' | 'inward';
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  lineCount: number;
};

export type GstPeriodSummary = {
  fromDate: string;
  toDate: string;
  outwardTaxable: number;
  outwardTax: number;
  inwardTaxable: number;
  inwardTax: number;
  itcEligible: number;
  itcClaimed: number;
  netGstLiability: number;
  tdsDeducted: number;
};

export type GstWorkbookExport = {
  filename: string;
  contentType: string;
  csv: string;
  rowCount: number;
};

export type TdsDeductionRow = {
  billId: string;
  documentNumber: string;
  billDate: string;
  vendorName: string | null;
  tdsSection: string;
  tdsPercent: number;
  taxableValue: number;
  tdsAmount: number;
  status: string;
};
