export type FinanceOrganization = {
  id: string;
  legalName: string;
  tradeName: string;
  cin: string | null;
  pan: string | null;
  gstin: string | null;
  industry: string | null;
  countryCode: string;
  stateCode: string | null;
  stateName: string | null;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  baseCurrency: string;
  language: string;
  timeZone: string;
  fiscalYearStartMonth: number;
  gstRegistered: boolean;
  gstRegistrationType: 'regular' | 'composition' | 'unregistered' | null;
  setupCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceAccount = {
  id: string;
  code: string;
  name: string;
  accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  systemRole: string | null;
  isSystem: boolean;
  isActive: boolean;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type FinanceTaxRate = {
  id: string;
  name: string;
  ratePercent: number;
  taxType: 'cgst' | 'sgst' | 'igst' | 'cess' | 'tds';
  isActive: boolean;
};

export type FinanceTaxGroup = {
  id: string;
  name: string;
  isActive: boolean;
  rateIds: string[];
  rates: FinanceTaxRate[];
};

export type FinanceTdsRate = {
  id: string;
  section: string;
  name: string;
  ratePercent: number;
  isActive: boolean;
};

export type FinancePartyStatus = 'active' | 'inactive';

export type FinanceCustomer = {
  id: string;
  displayName: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  stateName: string | null;
  billingAddress: string;
  shippingAddress: string;
  paymentTermsDays: number;
  currencyCode: string;
  status: FinancePartyStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceVendor = {
  id: string;
  displayName: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  stateName: string | null;
  billingAddress: string;
  paymentTermsDays: number;
  currencyCode: string;
  status: FinancePartyStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceItem = {
  id: string;
  code: string;
  name: string;
  itemType: 'goods' | 'service';
  hsnSac: string | null;
  unit: string;
  saleRate: number;
  purchaseRate: number;
  incomeAccountId: string | null;
  expenseAccountId: string | null;
  taxGroupId: string | null;
  description: string;
  status: FinancePartyStatus;
  createdAt: string;
  updatedAt: string;
};

export type FinanceNumberSeries = {
  id: string;
  documentType: string;
  prefix: string;
  padLength: number;
  nextNumber: number;
  fiscalYearLabel: string;
  resetYearly: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceSetupChecklist = {
  organizationReady: boolean;
  hasTaxGroups: boolean;
  hasAccounts: boolean;
  hasCustomer: boolean;
  hasVendor: boolean;
  hasItem: boolean;
  hasSeries: boolean;
  percentComplete: number;
  steps: { id: string; label: string; done: boolean; href: string }[];
};
