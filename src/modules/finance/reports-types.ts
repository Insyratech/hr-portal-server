export type ReportDrillRef = {
  entityType: string;
  entityId: string;
  label: string;
  href: string;
};

export type MoneyRow = {
  key: string;
  label: string;
  amount: number;
  drill?: ReportDrillRef | null;
};

export type DashboardTrendPoint = { period: string; label: string; amount: number };

export type FinanceDashboard = {
  fromDate: string;
  toDate: string;
  asOfDate: string;
  receivables: { current: number; overdue: number; total: number };
  payables: { current: number; overdue: number; total: number };
  cashFlow: { inflow: number; outflow: number; net: number };
  incomeVsExpense: { income: number; expense: number; net: number };
  salesTrend: DashboardTrendPoint[];
  priorPeriod: {
    fromDate: string;
    toDate: string;
    receivablesTotal: number;
    payablesTotal: number;
    cashFlowNet: number;
    incomeVsExpenseNet: number;
  };
  attention: Array<{
    id: string;
    kind: string;
    label: string;
    count: number;
    href: string;
  }>;
  recentTransactions: Array<{
    id: string;
    date: string;
    label: string;
    amount: number;
    sourceType: string;
    href: string;
  }>;
  trialBalanceBalanced: boolean;
  trialBalanceTotalDebit: number;
  trialBalanceTotalCredit: number;
};

export type SalesOverview = {
  fromDate: string;
  toDate: string;
  invoicedTotal: number;
  invoicedCount: number;
  paymentsReceived: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  quotesOpen: number;
  ordersOpen: number;
  invoicesDraft: number;
  priorInvoicedTotal: number;
  trend: DashboardTrendPoint[];
  byStatus: Array<{ status: string; count: number; amount: number }>;
  topCustomers: NamedAmountRow[];
};

export type PurchaseOverview = {
  fromDate: string;
  toDate: string;
  billedTotal: number;
  billedCount: number;
  paymentsMade: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  indentsPending: number;
  posOpen: number;
  billsDraft: number;
  priorBilledTotal: number;
  trend: DashboardTrendPoint[];
  byStatus: Array<{ status: string; count: number; amount: number }>;
  topVendors: NamedAmountRow[];
};

export type ReportCatalogItem = {
  pack: string;
  packLabel: string;
  id: string;
  title: string;
  description: string;
  href: string;
};

export type ProfitAndLossReport = {
  fromDate: string;
  toDate: string;
  income: MoneyRow[];
  expenses: MoneyRow[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
};

export type BalanceSheetReport = {
  asOfDate: string;
  assets: MoneyRow[];
  liabilities: MoneyRow[];
  equity: MoneyRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isBalanced: boolean;
};

export type CashFlowReport = {
  fromDate: string;
  toDate: string;
  operating: MoneyRow[];
  investing: MoneyRow[];
  financing: MoneyRow[];
  netChange: number;
  openingCash: number;
  closingCash: number;
};

export type NamedAmountRow = {
  id: string;
  name: string;
  amount: number;
  count?: number;
  href?: string;
};

export type AgingBucket = {
  current: number;
  days1to30: number;
  days31to60: number;
  days61plus: number;
  total: number;
};

export type AgingPartyRow = {
  partyId: string;
  partyName: string;
  buckets: AgingBucket;
  href: string;
};

export type AgingReport = {
  asOfDate: string;
  totals: AgingBucket;
  rows: AgingPartyRow[];
};

export type InvoiceDetailRow = {
  id: string;
  documentNumber: string;
  invoiceDate: string;
  customerName: string | null;
  status: string;
  grandTotal: number;
  amountPaid: number;
  amountDue: number;
  href: string;
};

export type PoStatusRow = {
  id: string;
  documentNumber: string;
  orderDate: string;
  vendorName: string | null;
  status: string;
  grandTotal: number;
  href: string;
};

export type BankingReconSummaryRow = {
  bankAccountId: string;
  bankAccountName: string;
  unmatchedCount: number;
  matchedCount: number;
  categorizedCount: number;
  href: string;
};

export type ActivityRow = {
  id: string;
  createdAt: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  href: string | null;
};

export type TaxSummaryReport = {
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
  links: Array<{ label: string; href: string }>;
};
