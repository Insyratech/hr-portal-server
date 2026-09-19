export type FinanceOrgGstProfile = {
  id: string;
  organizationId: string;
  label: string;
  gstin: string;
  legalName: string;
  tradeName: string;
  cin: string | null;
  pan: string | null;
  stateCode: string | null;
  stateName: string | null;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  logoStoragePath: string | null;
  logoUrl: string | null;
  registrationType: 'regular' | 'composition' | 'unregistered' | null;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceOrgAddress = {
  id: string;
  organizationId: string;
  label: string;
  addressType: 'registered' | 'operating' | 'billing' | 'shipping' | 'factory' | 'other';
  line1: string;
  line2: string;
  city: string;
  stateCode: string | null;
  stateName: string | null;
  postalCode: string;
  countryCode: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceOrgOfficer = {
  id: string;
  organizationId: string;
  role: 'ceo' | 'director' | 'other';
  fullName: string;
  designation: string;
  email: string | null;
  phone: string | null;
  din: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceVendorDocumentType =
  | 'income_tax'
  | 'sales_tax_license'
  | 'msme_ssi_license'
  | 'gst_certificate'
  | 'pan_card'
  | 'cancelled_cheque'
  | 'iso_certificate'
  | 'other';

export type FinanceVendorDocument = {
  id: string;
  vendorId: string;
  documentType: FinanceVendorDocumentType;
  fileName: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string | null;
  createdAt: string;
};

export type FinanceVendorPrincipalCustomer = {
  id: string;
  vendorId: string;
  customerNameAddress: string;
  productSupplied: string;
  sortOrder: number;
};

export type FinanceVendorRegistration = {
  id: string;
  displayName: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  telephone: string | null;
  fax: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  stateName: string | null;
  billingAddress: string;
  registeredAddress: string;
  factoryAddress: string;
  shippingAddress: string;
  paymentTermsDays: number;
  currencyCode: string;
  status: 'active' | 'inactive';
  notes: string;
  establishmentType: string;
  constitution: string;
  yearEstablished: string;
  salesTaxRegNo: string | null;
  factoryLicenseNo: string | null;
  businessProfile: string;
  bankNameAddress: string;
  bankAccountNo: string | null;
  ifsc: string | null;
  micr: string | null;
  creditLimit: number | null;
  contactPersonName: string;
  contactPersonDesignation: string;
  contactPersonMobile: string | null;
  declarationName: string;
  declarationDesignation: string;
  declarationPlace: string;
  declarationDate: string | null;
  vendorSignaturePath: string | null;
  orgGstProfileId: string | null;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  officeInspectedBy: string;
  officeInspectionDate: string | null;
  vendorCode: string | null;
  officeApprovedBy: string;
  officeDecision: 'approved' | 'rejected' | 'pending' | null;
  principalCustomers: FinanceVendorPrincipalCustomer[];
  documents: FinanceVendorDocument[];
  orgGstProfile: FinanceOrgGstProfile | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceVendorPrintPayload = {
  vendor: FinanceVendorRegistration;
  letterhead: FinanceOrgGstProfile | null;
};

export type FinanceSignedUpload = {
  path: string;
  token: string;
  bucket: string;
};
