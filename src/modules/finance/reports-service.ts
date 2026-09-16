import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canViewPurchaseOverview, canViewReports, canViewSalesOverview } from './access';
import { createGstService } from './gst-service';
import type {
  ActivityRow,
  AgingBucket,
  AgingPartyRow,
  AgingReport,
  BalanceSheetReport,
  BankingReconSummaryRow,
  CashFlowReport,
  DashboardTrendPoint,
  FinanceDashboard,
  InvoiceDetailRow,
  MoneyRow,
  NamedAmountRow,
  PoStatusRow,
  ProfitAndLossReport,
  PurchaseOverview,
  ReportCatalogItem,
  SalesOverview,
  TaxSummaryReport,
} from './reports-types';

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  system_role: string | null;
};

type JournalLite = {
  id: string;
  entry_number: string;
  entry_date: string;
  memo: string;
  source_type: string;
  source_id: string | null;
};

type LineAgg = { debit: number; credit: number };

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function todayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000);
}

function addDaysIso(isoDate: string, deltaDays: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Same-length window immediately before `fromDate` (inclusive). */
function shiftRangeBack(fromDate: string, toDate: string): { fromDate: string; toDate: string } {
  const lengthDays = daysBetween(fromDate, toDate) + 1;
  const priorToDate = addDaysIso(fromDate, -1);
  const priorFromDate = addDaysIso(priorToDate, -(lengthDays - 1));
  return { fromDate: priorFromDate, toDate: priorToDate };
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function monthPeriodLabel(period: string): string {
  const [y, m] = period.split('-');
  const monthIndex = Number(m) - 1;
  const label = MONTH_LABELS[monthIndex] ?? m;
  return `${label} ${y?.slice(2) ?? ''}`.trim();
}

function buildMonthlyTrend(
  rows: Array<{ date: string; amount: number }>,
  fromDate: string,
  toDate: string,
): DashboardTrendPoint[] {
  const buckets = new Map<string, number>();
  let cursor = `${fromDate.slice(0, 7)}-01`;
  const endPeriod = toDate.slice(0, 7);
  while (cursor.slice(0, 7) <= endPeriod) {
    buckets.set(cursor.slice(0, 7), 0);
    const [y, m] = cursor.split('-').map(Number);
    const next = m === 12 ? new Date(Date.UTC(y + 1, 0, 1)) : new Date(Date.UTC(y, m, 1));
    cursor = next.toISOString().slice(0, 10);
  }
  for (const row of rows) {
    if (row.date < fromDate || row.date > toDate) continue;
    const period = row.date.slice(0, 7);
    if (!buckets.has(period)) continue;
    buckets.set(period, round2((buckets.get(period) ?? 0) + row.amount));
  }
  return [...buckets.entries()].map(([period, amount]) => ({
    period,
    label: monthPeriodLabel(period),
    amount,
  }));
}

function requireReportsView(actor: RequestUser): void {
  if (!canViewReports(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view finance reports.', 403);
  }
}

function requireSalesOverviewView(actor: RequestUser): void {
  if (!canViewSalesOverview(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the sales overview.', 403);
  }
}

function requirePurchaseOverviewView(actor: RequestUser): void {
  if (!canViewPurchaseOverview(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the purchase overview.', 403);
  }
}

function requireDateRange(fromDate?: string, toDate?: string): { fromDate: string; toDate: string } {
  if (!fromDate || !toDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'fromDate and toDate are required.', 400);
  }
  if (fromDate > toDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'fromDate must be on or before toDate.', 400);
  }
  return { fromDate, toDate };
}

function requireAsOf(asOfDate?: string): string {
  if (!asOfDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'asOfDate is required.', 400);
  }
  return asOfDate;
}

function emptyAgingBucket(): AgingBucket {
  return { current: 0, days1to30: 0, days31to60: 0, days61plus: 0, total: 0 };
}

function addToBucket(bucket: AgingBucket, amount: number, daysPastDue: number): void {
  const amt = round2(amount);
  if (amt <= 0) return;
  if (daysPastDue <= 0) bucket.current = round2(bucket.current + amt);
  else if (daysPastDue <= 30) bucket.days1to30 = round2(bucket.days1to30 + amt);
  else if (daysPastDue <= 60) bucket.days31to60 = round2(bucket.days31to60 + amt);
  else bucket.days61plus = round2(bucket.days61plus + amt);
  bucket.total = round2(bucket.total + amt);
}

function sumBuckets(a: AgingBucket, b: AgingBucket): AgingBucket {
  return {
    current: round2(a.current + b.current),
    days1to30: round2(a.days1to30 + b.days1to30),
    days31to60: round2(a.days31to60 + b.days31to60),
    days61plus: round2(a.days61plus + b.days61plus),
    total: round2(a.total + b.total),
  };
}

function journalHref(sourceType: string, sourceId: string | null): string {
  switch (sourceType) {
    case 'customer_invoice':
      return sourceId ? `/finance/invoices` : `/finance/journals`;
    case 'customer_payment':
      return `/finance/payments-received`;
    case 'customer_credit_note':
      return `/finance/credit-notes`;
    case 'vendor_bill':
      return `/finance/bills`;
    case 'vendor_payment':
      return `/finance/payments`;
    case 'vendor_credit':
      return `/finance/vendor-credits`;
    case 'direct_expense':
    case 'expense':
      return `/finance/expenses`;
    case 'expense_claim':
      return `/finance/expense-claims`;
    case 'expense_reimbursement':
      return `/finance/reimbursements`;
    case 'bank_categorization':
      return `/finance/banking/transactions`;
    case 'opening_balance':
      return `/finance/opening-balances`;
    default:
      return `/finance/journals`;
  }
}

function activityHref(action: string, entityType: string, entityId: string | null): string | null {
  const a = action.toLowerCase();
  if (a.includes('invoice')) return '/finance/invoices';
  if (a.includes('bill')) return '/finance/bills';
  if (a.includes('customer_payment') || a.includes('payments.received')) return '/finance/payments-received';
  if (a.includes('vendor_payment') || a.includes('payment.')) return '/finance/payments';
  if (a.includes('purchase_order') || a.includes('po.')) return '/finance/purchase-orders';
  if (a.includes('indent')) return '/finance/indents';
  if (a.includes('expense_claim')) return '/finance/expense-claims';
  if (a.includes('expense')) return '/finance/expenses';
  if (a.includes('journal') || a.includes('opening')) return '/finance/journals';
  if (a.includes('bank')) return '/finance/banking/transactions';
  if (a.includes('gst') || a.includes('einvoice') || a.includes('eway') || a.includes('gstn')) {
    return '/finance/gst/outward';
  }
  if (entityType.includes('customer')) return '/finance/customers';
  if (entityType.includes('vendor')) return '/finance/vendors';
  if (entityId) return '/finance/journals';
  return null;
}

function cashFlowCategory(sourceType: string): 'operating' | 'investing' | 'financing' {
  if (sourceType === 'opening_balance' || sourceType === 'manual' || sourceType === 'journal_reverse') {
    return 'financing';
  }
  if (sourceType === 'fixed_asset' || sourceType === 'asset_purchase') {
    return 'investing';
  }
  return 'operating';
}

function sourceLabel(sourceType: string): string {
  return sourceType
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const REPORT_CATALOG: ReportCatalogItem[] = [
  {
    pack: 'overview',
    packLabel: 'Business overview',
    id: 'profit-loss',
    title: 'Profit and loss',
    description: 'Income and expense for a period from posted journals.',
    href: '/finance/reports/profit-loss',
  },
  {
    pack: 'overview',
    packLabel: 'Business overview',
    id: 'balance-sheet',
    title: 'Balance sheet',
    description: 'Assets, liabilities, and equity as of a date.',
    href: '/finance/reports/balance-sheet',
  },
  {
    pack: 'overview',
    packLabel: 'Business overview',
    id: 'cash-flow',
    title: 'Cash flow',
    description: 'Opening cash, period movements, and closing cash.',
    href: '/finance/reports/cash-flow',
  },
  {
    pack: 'sales',
    packLabel: 'Sales',
    id: 'sales-by-customer',
    title: 'Sales by customer',
    description: 'Posted invoice totals grouped by customer.',
    href: '/finance/reports/sales-by-customer',
  },
  {
    pack: 'sales',
    packLabel: 'Sales',
    id: 'sales-by-item',
    title: 'Sales by item',
    description: 'Posted invoice line amounts grouped by item.',
    href: '/finance/reports/sales-by-item',
  },
  {
    pack: 'sales',
    packLabel: 'Sales',
    id: 'invoice-details',
    title: 'Invoice details',
    description: 'Line listing of posted invoices in the period.',
    href: '/finance/reports/invoice-details',
  },
  {
    pack: 'receivables',
    packLabel: 'Receivables',
    id: 'ar-aging',
    title: 'AR aging',
    description: 'Open invoice balances by age bucket.',
    href: '/finance/reports/ar-aging',
  },
  {
    pack: 'receivables',
    packLabel: 'Receivables',
    id: 'customer-balances',
    title: 'Customer balances',
    description: 'Outstanding receivable by customer.',
    href: '/finance/reports/customer-balances',
  },
  {
    pack: 'payables',
    packLabel: 'Payables',
    id: 'ap-aging',
    title: 'AP aging',
    description: 'Open bill balances by age bucket.',
    href: '/finance/reports/ap-aging',
  },
  {
    pack: 'payables',
    packLabel: 'Payables',
    id: 'vendor-balances',
    title: 'Vendor balances',
    description: 'Outstanding payable by vendor.',
    href: '/finance/reports/vendor-balances',
  },
  {
    pack: 'payables',
    packLabel: 'Payables',
    id: 'po-status',
    title: 'PO status',
    description: 'Open purchase orders still in progress.',
    href: '/finance/reports/po-status',
  },
  {
    pack: 'purchases',
    packLabel: 'Purchases',
    id: 'purchases-by-vendor',
    title: 'Purchases by vendor',
    description: 'Posted bill totals grouped by vendor.',
    href: '/finance/reports/purchases-by-vendor',
  },
  {
    pack: 'purchases',
    packLabel: 'Purchases',
    id: 'purchases-by-item',
    title: 'Purchases by item',
    description: 'Posted bill line amounts grouped by item.',
    href: '/finance/reports/purchases-by-item',
  },
  {
    pack: 'tax',
    packLabel: 'Tax',
    id: 'tax-summary',
    title: 'Tax summary',
    description: 'GST outward/inward and ITC summary for the period.',
    href: '/finance/reports/tax-summary',
  },
  {
    pack: 'banking',
    packLabel: 'Banking',
    id: 'banking-reconciliation',
    title: 'Banking reconciliation',
    description: 'Unmatched / matched / categorized counts per bank account.',
    href: '/finance/reports/banking-reconciliation',
  },
  {
    pack: 'activity',
    packLabel: 'Activity',
    id: 'activity',
    title: 'Document activity',
    description: 'Recent finance audit log entries.',
    href: '/finance/reports/activity',
  },
];

async function loadAccounts(supabase: SupabaseClient, ids?: string[]): Promise<Map<string, AccountRow>> {
  let query = supabase.from('finance_accounts').select('id, code, name, account_type, system_role');
  if (ids?.length) query = query.in('id', [...new Set(ids)]);
  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load accounts.', 500);
  }
  return new Map(((data ?? []) as AccountRow[]).map((row) => [row.id, row]));
}

async function loadPostedJournals(
  supabase: SupabaseClient,
  opts: { fromDate?: string; toDate?: string; asOfDate?: string },
): Promise<JournalLite[]> {
  let query = supabase
    .from('finance_journal_entries')
    .select('id, entry_number, entry_date, memo, source_type, source_id')
    .eq('status', 'posted');
  if (opts.asOfDate) query = query.lte('entry_date', opts.asOfDate);
  if (opts.fromDate) query = query.gte('entry_date', opts.fromDate);
  if (opts.toDate) query = query.lte('entry_date', opts.toDate);
  const { data, error } = await query.order('entry_date', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journals.', 500);
  }
  return (data ?? []) as JournalLite[];
}

async function aggregateJournalLines(
  supabase: SupabaseClient,
  journalIds: string[],
): Promise<Map<string, LineAgg>> {
  const unique = [...new Set(journalIds.filter(Boolean))];
  const totals = new Map<string, LineAgg>();
  if (!unique.length) return totals;

  // Chunk to avoid oversized IN lists
  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('finance_journal_lines')
      .select('account_id, debit, credit')
      .in('journal_id', chunk);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal lines.', 500);
    }
    for (const row of (data ?? []) as Array<{ account_id: string; debit: number | string; credit: number | string }>) {
      const current = totals.get(row.account_id) ?? { debit: 0, credit: 0 };
      current.debit = round2(current.debit + num(row.debit));
      current.credit = round2(current.credit + num(row.credit));
      totals.set(row.account_id, current);
    }
  }
  return totals;
}

async function loadJournalLinesDetailed(
  supabase: SupabaseClient,
  journalIds: string[],
): Promise<Array<{ journal_id: string; account_id: string; debit: number; credit: number }>> {
  const unique = [...new Set(journalIds.filter(Boolean))];
  const lines: Array<{ journal_id: string; account_id: string; debit: number; credit: number }> = [];
  if (!unique.length) return lines;
  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('finance_journal_lines')
      .select('journal_id, account_id, debit, credit')
      .in('journal_id', chunk);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal lines.', 500);
    }
    for (const row of (data ?? []) as Array<{
      journal_id: string;
      account_id: string;
      debit: number | string;
      credit: number | string;
    }>) {
      lines.push({
        journal_id: row.journal_id,
        account_id: row.account_id,
        debit: num(row.debit),
        credit: num(row.credit),
      });
    }
  }
  return lines;
}

async function resolveCashAccountIds(supabase: SupabaseClient): Promise<Set<string>> {
  const accounts = await loadAccounts(supabase);
  const ids = new Set<string>();
  for (const account of accounts.values()) {
    if (account.system_role === 'bank' || account.system_role === 'cash') {
      ids.add(account.id);
    }
  }
  const { data, error } = await supabase.from('finance_bank_accounts').select('gl_account_id');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank accounts.', 500);
  }
  for (const row of (data ?? []) as Array<{ gl_account_id: string }>) {
    if (row.gl_account_id) ids.add(row.gl_account_id);
  }
  return ids;
}

async function nameMap(
  supabase: SupabaseClient,
  table: 'finance_customers' | 'finance_vendors' | 'finance_items',
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const nameCol = table === 'finance_items' ? 'name' : 'display_name';
  const { data, error } = await supabase.from(table).select(`id, ${nameCol}`).in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load ${table}.`, 500);
  }
  return new Map(
    ((data ?? []) as Array<Record<string, string>>).map((row) => [row.id, row[nameCol] ?? '']),
  );
}

function moneyRowsFromAgg(
  totals: Map<string, LineAgg>,
  accounts: Map<string, AccountRow>,
  accountType: string,
  side: 'debit' | 'credit',
): MoneyRow[] {
  const rows: MoneyRow[] = [];
  for (const [accountId, sums] of totals.entries()) {
    const account = accounts.get(accountId);
    if (!account || account.account_type !== accountType) continue;
    const net = round2(sums.debit - sums.credit);
    const amount = side === 'debit' ? (net > 0 ? net : 0) : net < 0 ? round2(-net) : 0;
    // For P&L: income is net credit, expense is net debit
    if (accountType === 'income') {
      const incomeAmt = round2(sums.credit - sums.debit);
      if (incomeAmt === 0) continue;
      rows.push({
        key: accountId,
        label: `${account.code} · ${account.name}`,
        amount: incomeAmt,
        drill: { entityType: 'account', entityId: accountId, label: account.name, href: '/finance/ledger' },
      });
      continue;
    }
    if (accountType === 'expense') {
      const expenseAmt = round2(sums.debit - sums.credit);
      if (expenseAmt === 0) continue;
      rows.push({
        key: accountId,
        label: `${account.code} · ${account.name}`,
        amount: expenseAmt,
        drill: { entityType: 'account', entityId: accountId, label: account.name, href: '/finance/ledger' },
      });
      continue;
    }
    if (amount === 0) continue;
    rows.push({
      key: accountId,
      label: `${account.code} · ${account.name}`,
      amount,
      drill: { entityType: 'account', entityId: accountId, label: account.name, href: '/finance/ledger' },
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

function bsRowsFromAgg(
  totals: Map<string, LineAgg>,
  accounts: Map<string, AccountRow>,
  accountType: 'asset' | 'liability' | 'equity',
): MoneyRow[] {
  const rows: MoneyRow[] = [];
  for (const [accountId, sums] of totals.entries()) {
    const account = accounts.get(accountId);
    if (!account || account.account_type !== accountType) continue;
    const net = round2(sums.debit - sums.credit);
    // Assets: debit nature; liabilities/equity: credit nature
    const amount =
      accountType === 'asset' ? net : round2(-net);
    if (amount === 0) continue;
    rows.push({
      key: accountId,
      label: `${account.code} · ${account.name}`,
      amount,
      drill: { entityType: 'account', entityId: accountId, label: account.name, href: '/finance/trial-balance' },
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

async function computePeriodCashAndPl(
  supabase: SupabaseClient,
  fromDate: string,
  toDate: string,
  cashAccountIds: Set<string>,
): Promise<{ cashFlowNet: number; incomeVsExpenseNet: number }> {
  const periodJournals = await loadPostedJournals(supabase, { fromDate, toDate });
  const periodLines = await loadJournalLinesDetailed(
    supabase,
    periodJournals.map((j) => j.id),
  );
  let cashIn = 0;
  let cashOut = 0;
  const incomeExpense = new Map<string, LineAgg>();
  for (const line of periodLines) {
    if (cashAccountIds.has(line.account_id)) {
      cashIn = round2(cashIn + line.debit);
      cashOut = round2(cashOut + line.credit);
    }
    const current = incomeExpense.get(line.account_id) ?? { debit: 0, credit: 0 };
    current.debit = round2(current.debit + line.debit);
    current.credit = round2(current.credit + line.credit);
    incomeExpense.set(line.account_id, current);
  }
  const accounts = await loadAccounts(supabase, [...incomeExpense.keys()]);
  let income = 0;
  let expense = 0;
  for (const [accountId, sums] of incomeExpense.entries()) {
    const account = accounts.get(accountId);
    if (!account) continue;
    if (account.account_type === 'income') income = round2(income + (sums.credit - sums.debit));
    if (account.account_type === 'expense') expense = round2(expense + (sums.debit - sums.credit));
  }
  return {
    cashFlowNet: round2(cashIn - cashOut),
    incomeVsExpenseNet: round2(income - expense),
  };
}

function sumOpenReceivables(
  invoices: Array<{
    invoice_date?: string | null;
    due_date: string | null;
    grand_total: number | string;
    amount_paid: number | string;
    status: string;
  }>,
  asOfDate: string,
  opts?: { filterByInvoiceDate?: boolean; statusAwareOverdue?: boolean },
): { current: number; overdue: number; total: number; overdueCount: number } {
  let current = 0;
  let overdue = 0;
  let overdueCount = 0;
  for (const inv of invoices) {
    if (opts?.filterByInvoiceDate && inv.invoice_date && inv.invoice_date > asOfDate) continue;
    const amountDue = round2(num(inv.grand_total) - num(inv.amount_paid));
    if (amountDue <= 0) continue;
    const duePast = Boolean(inv.due_date) && inv.due_date! < asOfDate;
    const overdueFlag = opts?.statusAwareOverdue
      ? duePast &&
        (inv.status === 'overdue' || inv.status === 'sent' || inv.status === 'partially_paid')
      : duePast;
    if (overdueFlag) {
      overdue = round2(overdue + amountDue);
      overdueCount += 1;
    } else {
      current = round2(current + amountDue);
    }
  }
  return { current, overdue, total: round2(current + overdue), overdueCount };
}

function sumOpenPayables(
  bills: Array<{
    bill_date?: string | null;
    due_date: string | null;
    grand_total: number | string;
    amount_paid: number | string;
    tds_amount?: number | string;
  }>,
  asOfDate: string,
  opts?: { filterByBillDate?: boolean },
): { current: number; overdue: number; total: number; overdueCount: number } {
  let current = 0;
  let overdue = 0;
  let overdueCount = 0;
  for (const bill of bills) {
    if (opts?.filterByBillDate && bill.bill_date && bill.bill_date > asOfDate) continue;
    const amountDue = round2(num(bill.grand_total) - num(bill.tds_amount) - num(bill.amount_paid));
    if (amountDue <= 0) continue;
    const isOverdue = Boolean(bill.due_date) && bill.due_date! < asOfDate;
    if (isOverdue) {
      overdue = round2(overdue + amountDue);
      overdueCount += 1;
    } else {
      current = round2(current + amountDue);
    }
  }
  return { current, overdue, total: round2(current + overdue), overdueCount };
}

export function createFinanceReportsService(supabase: SupabaseClient) {
  return {
    getCatalog(actor: RequestUser): ReportCatalogItem[] {
      requireReportsView(actor);
      return REPORT_CATALOG;
    },

    async getDashboard(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<FinanceDashboard> {
      requireReportsView(actor);
      const toDate = input.toDate || todayIsoDate();
      const fromDate =
        input.fromDate ||
        (() => {
          const [y, m] = toDate.split('-');
          return `${y}-${m}-01`;
        })();
      if (fromDate > toDate) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'fromDate must be on or before toDate.', 400);
      }
      const asOfDate = toDate;
      const priorRange = shiftRangeBack(fromDate, toDate);
      const priorAsOf = priorRange.toDate;

      const [
        invoiceRes,
        billRes,
        salesInvoiceRes,
        periodJournals,
        cashAccountIds,
        indentCountRes,
        claimCountRes,
        unmatchedTxnRes,
        draftBillRes,
        recentJournalsRes,
        tbJournals,
      ] = await Promise.all([
        supabase
          .from('finance_invoices')
          .select('id, status, due_date, invoice_date, grand_total, amount_paid, journal_id')
          .not('journal_id', 'is', null)
          .neq('status', 'void'),
        supabase
          .from('finance_vendor_bills')
          .select('id, status, due_date, bill_date, grand_total, amount_paid, tds_amount')
          .in('status', ['posted', 'partially_paid']),
        supabase
          .from('finance_invoices')
          .select('invoice_date, grand_total, journal_id, status')
          .not('journal_id', 'is', null)
          .neq('status', 'void')
          .gte('invoice_date', fromDate)
          .lte('invoice_date', toDate),
        loadPostedJournals(supabase, { fromDate, toDate }),
        resolveCashAccountIds(supabase),
        supabase
          .from('finance_purchase_indents')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'submitted'),
        supabase
          .from('finance_expense_claims')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'submitted'),
        supabase
          .from('finance_bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'unmatched'),
        supabase
          .from('finance_vendor_bills')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'draft'),
        supabase
          .from('finance_journal_entries')
          .select('id, entry_number, entry_date, memo, source_type, source_id')
          .eq('status', 'posted')
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(15),
        loadPostedJournals(supabase, { asOfDate }),
      ]);

      if (invoiceRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load receivables.', 500);
      }
      if (billRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load payables.', 500);
      }
      if (salesInvoiceRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load sales trend.', 500);
      }

      const invoiceRows = (invoiceRes.data ?? []) as Array<{
        status: string;
        due_date: string | null;
        invoice_date: string | null;
        grand_total: number | string;
        amount_paid: number | string;
      }>;
      const billRows = (billRes.data ?? []) as Array<{
        status: string;
        due_date: string | null;
        bill_date: string | null;
        grand_total: number | string;
        amount_paid: number | string;
        tds_amount: number | string;
      }>;

      const recv = sumOpenReceivables(invoiceRows, asOfDate, { statusAwareOverdue: true });
      const pay = sumOpenPayables(billRows, asOfDate);
      const priorRecv = sumOpenReceivables(invoiceRows, priorAsOf, {
        filterByInvoiceDate: true,
        statusAwareOverdue: false,
      });
      const priorPay = sumOpenPayables(billRows, priorAsOf, { filterByBillDate: true });

      const periodLines = await loadJournalLinesDetailed(
        supabase,
        periodJournals.map((j) => j.id),
      );
      const journalById = new Map(periodJournals.map((j) => [j.id, j]));

      let cashIn = 0;
      let cashOut = 0;
      const incomeExpense = new Map<string, LineAgg>();
      for (const line of periodLines) {
        if (cashAccountIds.has(line.account_id)) {
          cashIn = round2(cashIn + line.debit);
          cashOut = round2(cashOut + line.credit);
        }
        const journal = journalById.get(line.journal_id);
        if (!journal) continue;
        const current = incomeExpense.get(line.account_id) ?? { debit: 0, credit: 0 };
        current.debit = round2(current.debit + line.debit);
        current.credit = round2(current.credit + line.credit);
        incomeExpense.set(line.account_id, current);
      }

      const accounts = await loadAccounts(supabase, [...incomeExpense.keys()]);
      let income = 0;
      let expense = 0;
      for (const [accountId, sums] of incomeExpense.entries()) {
        const account = accounts.get(accountId);
        if (!account) continue;
        if (account.account_type === 'income') income = round2(income + (sums.credit - sums.debit));
        if (account.account_type === 'expense') expense = round2(expense + (sums.debit - sums.credit));
      }

      const priorPeriodMetrics = await computePeriodCashAndPl(
        supabase,
        priorRange.fromDate,
        priorRange.toDate,
        cashAccountIds,
      );

      const salesTrend = buildMonthlyTrend(
        ((salesInvoiceRes.data ?? []) as Array<{ invoice_date: string; grand_total: number | string }>).map(
          (row) => ({ date: row.invoice_date, amount: num(row.grand_total) }),
        ),
        fromDate,
        toDate,
      );

      const attention: FinanceDashboard['attention'] = [];
      const submittedIndents = indentCountRes.count ?? 0;
      const submittedClaims = claimCountRes.count ?? 0;
      const unmatchedTxns = unmatchedTxnRes.count ?? 0;
      const draftBills = draftBillRes.count ?? 0;
      if (submittedIndents > 0) {
        attention.push({
          id: 'submitted-indents',
          kind: 'approval',
          label: 'Submitted indents awaiting approval',
          count: submittedIndents,
          href: '/finance/indents',
        });
      }
      if (submittedClaims > 0) {
        attention.push({
          id: 'submitted-claims',
          kind: 'approval',
          label: 'Submitted expense claims',
          count: submittedClaims,
          href: '/finance/expense-claims',
        });
      }
      if (recv.overdueCount > 0) {
        attention.push({
          id: 'overdue-invoices',
          kind: 'overdue',
          label: 'Overdue invoices',
          count: recv.overdueCount,
          href: '/finance/invoices',
        });
      }
      if (unmatchedTxns > 0) {
        attention.push({
          id: 'unmatched-bank',
          kind: 'banking',
          label: 'Unmatched bank transactions',
          count: unmatchedTxns,
          href: '/finance/banking/transactions',
        });
      }
      if (draftBills > 0) {
        attention.push({
          id: 'draft-bills',
          kind: 'draft',
          label: 'Draft vendor bills',
          count: draftBills,
          href: '/finance/bills',
        });
      }

      const recentRows = (recentJournalsRes.data ?? []) as JournalLite[];
      const recentLines = await loadJournalLinesDetailed(
        supabase,
        recentRows.map((j) => j.id),
      );
      const amountByJournal = new Map<string, number>();
      for (const line of recentLines) {
        amountByJournal.set(line.journal_id, round2((amountByJournal.get(line.journal_id) ?? 0) + line.debit));
      }

      const recentTransactions = recentRows.map((row) => ({
        id: row.id,
        date: row.entry_date,
        label: row.memo || `${sourceLabel(row.source_type)} · ${row.entry_number}`,
        amount: amountByJournal.get(row.id) ?? 0,
        sourceType: row.source_type,
        href: journalHref(row.source_type, row.source_id),
      }));

      const tbTotals = await aggregateJournalLines(
        supabase,
        tbJournals.map((j) => j.id),
      );
      let tbDebit = 0;
      let tbCredit = 0;
      for (const sums of tbTotals.values()) {
        const net = round2(sums.debit - sums.credit);
        if (net > 0) tbDebit = round2(tbDebit + net);
        else if (net < 0) tbCredit = round2(tbCredit + -net);
      }

      return {
        fromDate,
        toDate,
        asOfDate,
        receivables: {
          current: recv.current,
          overdue: recv.overdue,
          total: recv.total,
        },
        payables: {
          current: pay.current,
          overdue: pay.overdue,
          total: pay.total,
        },
        cashFlow: {
          inflow: cashIn,
          outflow: cashOut,
          net: round2(cashIn - cashOut),
        },
        incomeVsExpense: {
          income,
          expense,
          net: round2(income - expense),
        },
        salesTrend,
        priorPeriod: {
          fromDate: priorRange.fromDate,
          toDate: priorRange.toDate,
          receivablesTotal: priorRecv.total,
          payablesTotal: priorPay.total,
          cashFlowNet: priorPeriodMetrics.cashFlowNet,
          incomeVsExpenseNet: priorPeriodMetrics.incomeVsExpenseNet,
        },
        attention,
        recentTransactions,
        trialBalanceBalanced: tbDebit === tbCredit,
        trialBalanceTotalDebit: tbDebit,
        trialBalanceTotalCredit: tbCredit,
      };
    },

    async getSalesOverview(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<SalesOverview> {
      requireSalesOverviewView(actor);
      const { fromDate, toDate } = requireDateRange(
        input.fromDate ||
          (() => {
            const t = todayIsoDate();
            const [y, m] = t.split('-');
            return `${y}-${m}-01`;
          })(),
        input.toDate || todayIsoDate(),
      );
      const priorRange = shiftRangeBack(fromDate, toDate);
      const asOfDate = toDate;

      const [
        rangeInvoicesRes,
        priorInvoicesRes,
        openInvoicesRes,
        paymentsRes,
        quotesRes,
        ordersRes,
        draftInvoicesRes,
      ] = await Promise.all([
        supabase
          .from('finance_invoices')
          .select('id, customer_id, status, invoice_date, due_date, grand_total, amount_paid, journal_id')
          .not('journal_id', 'is', null)
          .neq('status', 'void')
          .gte('invoice_date', fromDate)
          .lte('invoice_date', toDate),
        supabase
          .from('finance_invoices')
          .select('grand_total')
          .not('journal_id', 'is', null)
          .neq('status', 'void')
          .gte('invoice_date', priorRange.fromDate)
          .lte('invoice_date', priorRange.toDate),
        supabase
          .from('finance_invoices')
          .select('id, status, due_date, grand_total, amount_paid, journal_id')
          .not('journal_id', 'is', null)
          .neq('status', 'void'),
        supabase
          .from('finance_customer_payments')
          .select('amount, payment_date, status')
          .eq('status', 'posted')
          .gte('payment_date', fromDate)
          .lte('payment_date', toDate),
        supabase
          .from('finance_sales_quotes')
          .select('id', { count: 'exact', head: true })
          .in('status', ['draft', 'sent']),
        supabase
          .from('finance_sales_orders')
          .select('id', { count: 'exact', head: true })
          .in('status', ['confirmed', 'partially_delivered', 'delivered', 'partially_invoiced']),
        supabase
          .from('finance_invoices')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'draft'),
      ]);

      if (rangeInvoicesRes.error || priorInvoicesRes.error || openInvoicesRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices for sales overview.', 500);
      }
      if (paymentsRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer payments.', 500);
      }

      const rangeInvoices = (rangeInvoicesRes.data ?? []) as Array<{
        id: string;
        customer_id: string;
        status: string;
        invoice_date: string;
        grand_total: number | string;
      }>;
      let invoicedTotal = 0;
      const byStatus = new Map<string, { count: number; amount: number }>();
      const byCustomer = new Map<string, { amount: number; count: number }>();
      for (const inv of rangeInvoices) {
        const amount = num(inv.grand_total);
        invoicedTotal = round2(invoicedTotal + amount);
        const statusAgg = byStatus.get(inv.status) ?? { count: 0, amount: 0 };
        statusAgg.count += 1;
        statusAgg.amount = round2(statusAgg.amount + amount);
        byStatus.set(inv.status, statusAgg);
        const cust = byCustomer.get(inv.customer_id) ?? { amount: 0, count: 0 };
        cust.amount = round2(cust.amount + amount);
        cust.count += 1;
        byCustomer.set(inv.customer_id, cust);
      }

      const priorInvoicedTotal = round2(
        ((priorInvoicesRes.data ?? []) as Array<{ grand_total: number | string }>).reduce(
          (sum, row) => sum + num(row.grand_total),
          0,
        ),
      );

      const paymentsReceived = round2(
        ((paymentsRes.data ?? []) as Array<{ amount: number | string }>).reduce(
          (sum, row) => sum + num(row.amount),
          0,
        ),
      );

      const openRecv = sumOpenReceivables(
        (openInvoicesRes.data ?? []) as Array<{
          status: string;
          due_date: string | null;
          grand_total: number | string;
          amount_paid: number | string;
        }>,
        asOfDate,
        { statusAwareOverdue: true },
      );

      const names = await nameMap(supabase, 'finance_customers', [...byCustomer.keys()]);
      const topCustomers = [...byCustomer.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? 'Customer',
          amount: agg.amount,
          count: agg.count,
          href: '/finance/customers',
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);

      return {
        fromDate,
        toDate,
        invoicedTotal,
        invoicedCount: rangeInvoices.length,
        paymentsReceived,
        outstanding: openRecv.total,
        overdueAmount: openRecv.overdue,
        overdueCount: openRecv.overdueCount,
        quotesOpen: quotesRes.count ?? 0,
        ordersOpen: ordersRes.count ?? 0,
        invoicesDraft: draftInvoicesRes.count ?? 0,
        priorInvoicedTotal,
        trend: buildMonthlyTrend(
          rangeInvoices.map((inv) => ({ date: inv.invoice_date, amount: num(inv.grand_total) })),
          fromDate,
          toDate,
        ),
        byStatus: [...byStatus.entries()]
          .map(([status, agg]) => ({ status, count: agg.count, amount: agg.amount }))
          .sort((a, b) => b.amount - a.amount),
        topCustomers,
      };
    },

    async getPurchaseOverview(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<PurchaseOverview> {
      requirePurchaseOverviewView(actor);
      const { fromDate, toDate } = requireDateRange(
        input.fromDate ||
          (() => {
            const t = todayIsoDate();
            const [y, m] = t.split('-');
            return `${y}-${m}-01`;
          })(),
        input.toDate || todayIsoDate(),
      );
      const priorRange = shiftRangeBack(fromDate, toDate);
      const asOfDate = toDate;

      const [
        rangeBillsRes,
        priorBillsRes,
        openBillsRes,
        paymentsRes,
        indentsRes,
        posRes,
        draftBillsRes,
      ] = await Promise.all([
        supabase
          .from('finance_vendor_bills')
          .select('id, vendor_id, status, bill_date, due_date, grand_total, amount_paid, tds_amount, journal_id')
          .not('journal_id', 'is', null)
          .neq('status', 'void')
          .neq('status', 'draft')
          .gte('bill_date', fromDate)
          .lte('bill_date', toDate),
        supabase
          .from('finance_vendor_bills')
          .select('grand_total')
          .not('journal_id', 'is', null)
          .neq('status', 'void')
          .neq('status', 'draft')
          .gte('bill_date', priorRange.fromDate)
          .lte('bill_date', priorRange.toDate),
        supabase
          .from('finance_vendor_bills')
          .select('id, status, due_date, grand_total, amount_paid, tds_amount')
          .in('status', ['posted', 'partially_paid']),
        supabase
          .from('finance_vendor_payments')
          .select('amount, payment_date, status')
          .eq('status', 'posted')
          .gte('payment_date', fromDate)
          .lte('payment_date', toDate),
        supabase
          .from('finance_purchase_indents')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'submitted'),
        supabase
          .from('finance_purchase_orders')
          .select('id', { count: 'exact', head: true })
          .in('status', ['draft', 'approved', 'issued', 'partially_received', 'received']),
        supabase
          .from('finance_vendor_bills')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'draft'),
      ]);

      if (rangeBillsRes.error || priorBillsRes.error || openBillsRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bills for purchase overview.', 500);
      }
      if (paymentsRes.error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor payments.', 500);
      }

      const rangeBills = (rangeBillsRes.data ?? []) as Array<{
        id: string;
        vendor_id: string;
        status: string;
        bill_date: string;
        grand_total: number | string;
      }>;
      let billedTotal = 0;
      const byStatus = new Map<string, { count: number; amount: number }>();
      const byVendor = new Map<string, { amount: number; count: number }>();
      for (const bill of rangeBills) {
        const amount = num(bill.grand_total);
        billedTotal = round2(billedTotal + amount);
        const statusAgg = byStatus.get(bill.status) ?? { count: 0, amount: 0 };
        statusAgg.count += 1;
        statusAgg.amount = round2(statusAgg.amount + amount);
        byStatus.set(bill.status, statusAgg);
        const vendor = byVendor.get(bill.vendor_id) ?? { amount: 0, count: 0 };
        vendor.amount = round2(vendor.amount + amount);
        vendor.count += 1;
        byVendor.set(bill.vendor_id, vendor);
      }

      const priorBilledTotal = round2(
        ((priorBillsRes.data ?? []) as Array<{ grand_total: number | string }>).reduce(
          (sum, row) => sum + num(row.grand_total),
          0,
        ),
      );

      const paymentsMade = round2(
        ((paymentsRes.data ?? []) as Array<{ amount: number | string }>).reduce(
          (sum, row) => sum + num(row.amount),
          0,
        ),
      );

      const openPay = sumOpenPayables(
        (openBillsRes.data ?? []) as Array<{
          due_date: string | null;
          grand_total: number | string;
          amount_paid: number | string;
          tds_amount: number | string;
        }>,
        asOfDate,
      );

      const names = await nameMap(supabase, 'finance_vendors', [...byVendor.keys()]);
      const topVendors = [...byVendor.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? 'Vendor',
          amount: agg.amount,
          count: agg.count,
          href: '/finance/vendors',
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);

      return {
        fromDate,
        toDate,
        billedTotal,
        billedCount: rangeBills.length,
        paymentsMade,
        outstanding: openPay.total,
        overdueAmount: openPay.overdue,
        overdueCount: openPay.overdueCount,
        indentsPending: indentsRes.count ?? 0,
        posOpen: posRes.count ?? 0,
        billsDraft: draftBillsRes.count ?? 0,
        priorBilledTotal,
        trend: buildMonthlyTrend(
          rangeBills.map((bill) => ({ date: bill.bill_date, amount: num(bill.grand_total) })),
          fromDate,
          toDate,
        ),
        byStatus: [...byStatus.entries()]
          .map(([status, agg]) => ({ status, count: agg.count, amount: agg.amount }))
          .sort((a, b) => b.amount - a.amount),
        topVendors,
      };
    },

    async getProfitAndLoss(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<ProfitAndLossReport> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const journals = await loadPostedJournals(supabase, { fromDate, toDate });
      const totals = await aggregateJournalLines(
        supabase,
        journals.map((j) => j.id),
      );
      const accounts = await loadAccounts(supabase, [...totals.keys()]);
      const income = moneyRowsFromAgg(totals, accounts, 'income', 'credit');
      const expenses = moneyRowsFromAgg(totals, accounts, 'expense', 'debit');
      const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
      const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));
      return {
        fromDate,
        toDate,
        income,
        expenses,
        totalIncome,
        totalExpenses,
        netProfit: round2(totalIncome - totalExpenses),
      };
    },

    async getBalanceSheet(actor: RequestUser, input: { asOfDate?: string }): Promise<BalanceSheetReport> {
      requireReportsView(actor);
      const asOfDate = requireAsOf(input.asOfDate);
      const journals = await loadPostedJournals(supabase, { asOfDate });
      const totals = await aggregateJournalLines(
        supabase,
        journals.map((j) => j.id),
      );
      const accounts = await loadAccounts(supabase, [...totals.keys()]);
      const assets = bsRowsFromAgg(totals, accounts, 'asset');
      const liabilities = bsRowsFromAgg(totals, accounts, 'liability');
      const equity = bsRowsFromAgg(totals, accounts, 'equity');

      // Include current period P&L as equity plug for balance check
      let retained = 0;
      for (const [accountId, sums] of totals.entries()) {
        const account = accounts.get(accountId);
        if (!account) continue;
        if (account.account_type === 'income') retained = round2(retained + (sums.credit - sums.debit));
        if (account.account_type === 'expense') retained = round2(retained - (sums.debit - sums.credit));
      }
      if (retained !== 0) {
        equity.push({
          key: 'current-earnings',
          label: 'Current year earnings',
          amount: retained,
          drill: { entityType: 'report', entityId: 'profit-loss', label: 'P&L', href: '/finance/reports/profit-loss' },
        });
      }

      const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
      const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
      const totalEquity = round2(equity.reduce((s, r) => s + r.amount, 0));
      const isBalanced = totalAssets === round2(totalLiabilities + totalEquity);

      // If still out of balance (rounding / unclassified), add plug
      if (!isBalanced) {
        const plug = round2(totalAssets - totalLiabilities - totalEquity);
        equity.push({
          key: 'balancing-plug',
          label: 'Balancing adjustment',
          amount: plug,
          drill: null,
        });
      }

      const totalEquityFinal = round2(equity.reduce((s, r) => s + r.amount, 0));
      return {
        asOfDate,
        assets,
        liabilities,
        equity,
        totalAssets,
        totalLiabilities,
        totalEquity: totalEquityFinal,
        isBalanced: totalAssets === round2(totalLiabilities + totalEquityFinal),
      };
    },

    async getCashFlow(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<CashFlowReport> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const cashIds = await resolveCashAccountIds(supabase);

      // Opening = cumulative cash/bank activity strictly before fromDate
      const dayBefore = (() => {
        const d = new Date(`${fromDate}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const openingJournals =
        fromDate > '1900-01-01' ? await loadPostedJournals(supabase, { asOfDate: dayBefore }) : [];
      // Exclude anything on/after fromDate in case of timezone edge cases
      const openingIds = openingJournals.filter((j) => j.entry_date < fromDate).map((j) => j.id);
      const openingLines = await loadJournalLinesDetailed(supabase, openingIds);
      let openingCash = 0;
      for (const line of openingLines) {
        if (!cashIds.has(line.account_id)) continue;
        openingCash = round2(openingCash + line.debit - line.credit);
      }

      const periodJournals = await loadPostedJournals(supabase, { fromDate, toDate });
      const periodLines = await loadJournalLinesDetailed(
        supabase,
        periodJournals.map((j) => j.id),
      );
      const journalById = new Map(periodJournals.map((j) => [j.id, j]));

      const bySource = new Map<string, { inflow: number; outflow: number }>();
      for (const line of periodLines) {
        if (!cashIds.has(line.account_id)) continue;
        const journal = journalById.get(line.journal_id);
        if (!journal) continue;
        const current = bySource.get(journal.source_type) ?? { inflow: 0, outflow: 0 };
        current.inflow = round2(current.inflow + line.debit);
        current.outflow = round2(current.outflow + line.credit);
        bySource.set(journal.source_type, current);
      }

      const operating: MoneyRow[] = [];
      const investing: MoneyRow[] = [];
      const financing: MoneyRow[] = [];
      for (const [sourceType, sums] of bySource.entries()) {
        const net = round2(sums.inflow - sums.outflow);
        if (net === 0 && sums.inflow === 0 && sums.outflow === 0) continue;
        const row: MoneyRow = {
          key: sourceType,
          label: sourceLabel(sourceType),
          amount: net,
          drill: {
            entityType: 'source_type',
            entityId: sourceType,
            label: sourceLabel(sourceType),
            href: journalHref(sourceType, null),
          },
        };
        const cat = cashFlowCategory(sourceType);
        if (cat === 'operating') operating.push(row);
        else if (cat === 'investing') investing.push(row);
        else financing.push(row);
      }

      const netChange = round2(
        [...operating, ...investing, ...financing].reduce((s, r) => s + r.amount, 0),
      );
      return {
        fromDate,
        toDate,
        operating: operating.sort((a, b) => a.label.localeCompare(b.label)),
        investing: investing.sort((a, b) => a.label.localeCompare(b.label)),
        financing: financing.sort((a, b) => a.label.localeCompare(b.label)),
        netChange,
        openingCash,
        closingCash: round2(openingCash + netChange),
      };
    },

    async getSalesByCustomer(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data, error } = await supabase
        .from('finance_invoices')
        .select('id, customer_id, grand_total, journal_id, status, invoice_date')
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .gte('invoice_date', fromDate)
        .lte('invoice_date', toDate);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices.', 500);
      }
      const rows = (data ?? []) as Array<{
        customer_id: string;
        grand_total: number | string;
      }>;
      const byCustomer = new Map<string, { amount: number; count: number }>();
      for (const row of rows) {
        const current = byCustomer.get(row.customer_id) ?? { amount: 0, count: 0 };
        current.amount = round2(current.amount + num(row.grand_total));
        current.count += 1;
        byCustomer.set(row.customer_id, current);
      }
      const names = await nameMap(supabase, 'finance_customers', [...byCustomer.keys()]);
      return [...byCustomer.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? 'Customer',
          amount: agg.amount,
          count: agg.count,
          href: '/finance/customers',
        }))
        .sort((a, b) => b.amount - a.amount);
    },

    async getSalesByItem(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data: invoices, error } = await supabase
        .from('finance_invoices')
        .select('id')
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .gte('invoice_date', fromDate)
        .lte('invoice_date', toDate);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices.', 500);
      }
      const invoiceIds = ((invoices ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (!invoiceIds.length) return [];
      const { data: lines, error: lineErr } = await supabase
        .from('finance_invoice_lines')
        .select('item_id, description, amount, tax_amount')
        .in('invoice_id', invoiceIds);
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoice lines.', 500);
      }
      const byItem = new Map<string, { name: string; amount: number; count: number }>();
      for (const line of (lines ?? []) as Array<{
        item_id: string | null;
        description: string;
        amount: number | string;
        tax_amount: number | string;
      }>) {
        const key = line.item_id ?? `desc:${line.description}`;
        const current = byItem.get(key) ?? { name: line.description, amount: 0, count: 0 };
        current.amount = round2(current.amount + num(line.amount) + num(line.tax_amount));
        current.count += 1;
        byItem.set(key, current);
      }
      const itemIds = [...byItem.keys()].filter((k) => !k.startsWith('desc:'));
      const names = await nameMap(supabase, 'finance_items', itemIds);
      return [...byItem.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? agg.name,
          amount: agg.amount,
          count: agg.count,
          href: '/finance/items',
        }))
        .sort((a, b) => b.amount - a.amount);
    },

    async getInvoiceDetails(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<InvoiceDetailRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data, error } = await supabase
        .from('finance_invoices')
        .select(
          'id, document_number, invoice_date, customer_id, status, grand_total, amount_paid, journal_id',
        )
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .gte('invoice_date', fromDate)
        .lte('invoice_date', toDate)
        .order('invoice_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices.', 500);
      }
      const rows = (data ?? []) as Array<{
        id: string;
        document_number: string;
        invoice_date: string;
        customer_id: string;
        status: string;
        grand_total: number | string;
        amount_paid: number | string;
      }>;
      const names = await nameMap(
        supabase,
        'finance_customers',
        rows.map((r) => r.customer_id),
      );
      return rows.map((row) => ({
        id: row.id,
        documentNumber: row.document_number,
        invoiceDate: row.invoice_date,
        customerName: names.get(row.customer_id) ?? null,
        status: row.status,
        grandTotal: num(row.grand_total),
        amountPaid: num(row.amount_paid),
        amountDue: round2(num(row.grand_total) - num(row.amount_paid)),
        href: '/finance/invoices',
      }));
    },

    async getArAging(actor: RequestUser, input: { asOfDate?: string }): Promise<AgingReport> {
      requireReportsView(actor);
      const asOfDate = requireAsOf(input.asOfDate);
      const { data, error } = await supabase
        .from('finance_invoices')
        .select('id, customer_id, due_date, grand_total, amount_paid, status, journal_id')
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .neq('status', 'paid');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load invoices for AR aging.', 500);
      }
      const byParty = new Map<string, AgingBucket>();
      for (const inv of (data ?? []) as Array<{
        customer_id: string;
        due_date: string | null;
        grand_total: number | string;
        amount_paid: number | string;
      }>) {
        const due = round2(num(inv.grand_total) - num(inv.amount_paid));
        if (due <= 0) continue;
        const dueDate = inv.due_date ?? asOfDate;
        const daysPast = daysBetween(dueDate, asOfDate);
        const bucket = byParty.get(inv.customer_id) ?? emptyAgingBucket();
        addToBucket(bucket, due, daysPast);
        byParty.set(inv.customer_id, bucket);
      }
      const names = await nameMap(supabase, 'finance_customers', [...byParty.keys()]);
      const rows: AgingPartyRow[] = [...byParty.entries()]
        .map(([partyId, buckets]) => ({
          partyId,
          partyName: names.get(partyId) ?? 'Customer',
          buckets,
          href: '/finance/customers',
        }))
        .sort((a, b) => b.buckets.total - a.buckets.total);
      const totals = rows.reduce((acc, row) => sumBuckets(acc, row.buckets), emptyAgingBucket());
      return { asOfDate, totals, rows };
    },

    async getCustomerBalances(
      actor: RequestUser,
      input: { asOfDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const asOfDate = requireAsOf(input.asOfDate);
      const aging = await this.getArAging(actor, { asOfDate });
      return aging.rows.map((row) => ({
        id: row.partyId,
        name: row.partyName,
        amount: row.buckets.total,
        href: row.href,
      }));
    },

    async getApAging(actor: RequestUser, input: { asOfDate?: string }): Promise<AgingReport> {
      requireReportsView(actor);
      const asOfDate = requireAsOf(input.asOfDate);
      const { data, error } = await supabase
        .from('finance_vendor_bills')
        .select('id, vendor_id, due_date, grand_total, amount_paid, tds_amount, status')
        .in('status', ['posted', 'partially_paid']);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bills for AP aging.', 500);
      }
      const byParty = new Map<string, AgingBucket>();
      for (const bill of (data ?? []) as Array<{
        vendor_id: string;
        due_date: string | null;
        grand_total: number | string;
        amount_paid: number | string;
        tds_amount: number | string;
      }>) {
        const due = round2(num(bill.grand_total) - num(bill.tds_amount) - num(bill.amount_paid));
        if (due <= 0) continue;
        const dueDate = bill.due_date ?? asOfDate;
        const daysPast = daysBetween(dueDate, asOfDate);
        const bucket = byParty.get(bill.vendor_id) ?? emptyAgingBucket();
        addToBucket(bucket, due, daysPast);
        byParty.set(bill.vendor_id, bucket);
      }
      const names = await nameMap(supabase, 'finance_vendors', [...byParty.keys()]);
      const rows: AgingPartyRow[] = [...byParty.entries()]
        .map(([partyId, buckets]) => ({
          partyId,
          partyName: names.get(partyId) ?? 'Vendor',
          buckets,
          href: '/finance/vendors',
        }))
        .sort((a, b) => b.buckets.total - a.buckets.total);
      const totals = rows.reduce((acc, row) => sumBuckets(acc, row.buckets), emptyAgingBucket());
      return { asOfDate, totals, rows };
    },

    async getVendorBalances(
      actor: RequestUser,
      input: { asOfDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const asOfDate = requireAsOf(input.asOfDate);
      const aging = await this.getApAging(actor, { asOfDate });
      return aging.rows.map((row) => ({
        id: row.partyId,
        name: row.partyName,
        amount: row.buckets.total,
        href: row.href,
      }));
    },

    async getPoStatus(actor: RequestUser): Promise<PoStatusRow[]> {
      requireReportsView(actor);
      const { data, error } = await supabase
        .from('finance_purchase_orders')
        .select('id, document_number, order_date, vendor_id, status, grand_total')
        .in('status', ['draft', 'approved', 'issued', 'partially_received', 'received'])
        .order('order_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load purchase orders.', 500);
      }
      const rows = (data ?? []) as Array<{
        id: string;
        document_number: string;
        order_date: string;
        vendor_id: string;
        status: string;
        grand_total: number | string;
      }>;
      const names = await nameMap(
        supabase,
        'finance_vendors',
        rows.map((r) => r.vendor_id),
      );
      return rows.map((row) => ({
        id: row.id,
        documentNumber: row.document_number,
        orderDate: row.order_date,
        vendorName: names.get(row.vendor_id) ?? null,
        status: row.status,
        grandTotal: num(row.grand_total),
        href: '/finance/purchase-orders',
      }));
    },

    async getPurchasesByVendor(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data, error } = await supabase
        .from('finance_vendor_bills')
        .select('vendor_id, grand_total, status, bill_date, journal_id')
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .neq('status', 'draft')
        .gte('bill_date', fromDate)
        .lte('bill_date', toDate);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bills.', 500);
      }
      const byVendor = new Map<string, { amount: number; count: number }>();
      for (const row of (data ?? []) as Array<{ vendor_id: string; grand_total: number | string }>) {
        const current = byVendor.get(row.vendor_id) ?? { amount: 0, count: 0 };
        current.amount = round2(current.amount + num(row.grand_total));
        current.count += 1;
        byVendor.set(row.vendor_id, current);
      }
      const names = await nameMap(supabase, 'finance_vendors', [...byVendor.keys()]);
      return [...byVendor.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? 'Vendor',
          amount: agg.amount,
          count: agg.count,
          href: '/finance/vendors',
        }))
        .sort((a, b) => b.amount - a.amount);
    },

    async getPurchasesByItem(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<NamedAmountRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data: bills, error } = await supabase
        .from('finance_vendor_bills')
        .select('id')
        .not('journal_id', 'is', null)
        .neq('status', 'void')
        .neq('status', 'draft')
        .gte('bill_date', fromDate)
        .lte('bill_date', toDate);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bills.', 500);
      }
      const billIds = ((bills ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (!billIds.length) return [];
      const { data: lines, error: lineErr } = await supabase
        .from('finance_vendor_bill_lines')
        .select('item_id, description, amount, tax_amount')
        .in('bill_id', billIds);
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bill lines.', 500);
      }
      const byItem = new Map<string, { name: string; amount: number; count: number }>();
      for (const line of (lines ?? []) as Array<{
        item_id: string | null;
        description: string;
        amount: number | string;
        tax_amount: number | string;
      }>) {
        const key = line.item_id ?? `desc:${line.description}`;
        const current = byItem.get(key) ?? { name: line.description, amount: 0, count: 0 };
        current.amount = round2(current.amount + num(line.amount) + num(line.tax_amount));
        current.count += 1;
        byItem.set(key, current);
      }
      const itemIds = [...byItem.keys()].filter((k) => !k.startsWith('desc:'));
      const names = await nameMap(supabase, 'finance_items', itemIds);
      return [...byItem.entries()]
        .map(([id, agg]) => ({
          id,
          name: names.get(id) ?? agg.name,
          amount: agg.amount,
          count: agg.count,
          href: '/finance/items',
        }))
        .sort((a, b) => b.amount - a.amount);
    },

    async getTaxSummary(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<TaxSummaryReport> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      try {
        const summary = await createGstService(supabase).getPeriodSummary(actor, { fromDate, toDate });
        return {
          ...summary,
          links: [
            { label: 'Outward register', href: '/finance/gst/outward' },
            { label: 'Inward / ITC', href: '/finance/gst/inward' },
            { label: 'HSN summary', href: '/finance/gst/hsn' },
          ],
        };
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 403) {
          return {
            fromDate,
            toDate,
            outwardTaxable: 0,
            outwardTax: 0,
            inwardTaxable: 0,
            inwardTax: 0,
            itcEligible: 0,
            itcClaimed: 0,
            netGstLiability: 0,
            tdsDeducted: 0,
            links: [
              { label: 'Outward register', href: '/finance/gst/outward' },
              { label: 'Inward / ITC', href: '/finance/gst/inward' },
              { label: 'HSN summary', href: '/finance/gst/hsn' },
            ],
          };
        }
        throw err;
      }
    },

    async getBankingReconciliationSummary(actor: RequestUser): Promise<BankingReconSummaryRow[]> {
      requireReportsView(actor);
      const { data: accounts, error: accErr } = await supabase
        .from('finance_bank_accounts')
        .select('id, display_name')
        .order('display_name', { ascending: true });
      if (accErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank accounts.', 500);
      }
      const { data: txns, error: txnErr } = await supabase
        .from('finance_bank_transactions')
        .select('bank_account_id, status');
      if (txnErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank transactions.', 500);
      }
      const counts = new Map<string, { unmatched: number; matched: number; categorized: number }>();
      for (const txn of (txns ?? []) as Array<{ bank_account_id: string; status: string }>) {
        const current = counts.get(txn.bank_account_id) ?? {
          unmatched: 0,
          matched: 0,
          categorized: 0,
        };
        if (txn.status === 'unmatched') current.unmatched += 1;
        else if (txn.status === 'matched') current.matched += 1;
        else if (txn.status === 'categorized') current.categorized += 1;
        counts.set(txn.bank_account_id, current);
      }
      return ((accounts ?? []) as Array<{ id: string; display_name: string }>).map((account) => {
        const c = counts.get(account.id) ?? { unmatched: 0, matched: 0, categorized: 0 };
        return {
          bankAccountId: account.id,
          bankAccountName: account.display_name,
          unmatchedCount: c.unmatched,
          matchedCount: c.matched,
          categorizedCount: c.categorized,
          href: '/finance/banking/reconciliation',
        };
      });
    },

    async getActivity(
      actor: RequestUser,
      input: { fromDate?: string; toDate?: string },
    ): Promise<ActivityRow[]> {
      requireReportsView(actor);
      const { fromDate, toDate } = requireDateRange(input.fromDate, input.toDate);
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, created_at, actor_id, action, entity_type, entity_id')
        .like('action', 'finance.%')
        .gte('created_at', `${fromDate}T00:00:00.000Z`)
        .lte('created_at', `${toDate}T23:59:59.999Z`)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load activity.', 500);
      }
      return ((data ?? []) as Array<{
        id: string;
        created_at: string;
        actor_id: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
      }>).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        href: activityHref(row.action, row.entity_type, row.entity_id),
      }));
    },
  };
}
