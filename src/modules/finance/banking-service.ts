import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageBanking, canViewBanking, type RequestMeta } from './access';
import type {
  BankAccount,
  BankImportBatch,
  BankMatchCandidate,
  BankReconciliation,
  BankReconciliationReport,
  BankTransaction,
} from './banking-types';
import { postBalancedJournal } from './posting';
import { allocateDocumentNumber } from './series-allocate';

type BankAccountRow = {
  id: string;
  gl_account_id: string;
  display_name: string;
  account_kind: 'bank' | 'cash';
  bank_name: string;
  account_number_masked: string;
  currency_code: string;
  is_active: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
};

type BankTxnRow = {
  id: string;
  document_number: string;
  bank_account_id: string;
  transaction_date: string;
  description: string;
  reference: string;
  transaction_type: 'credit' | 'debit';
  amount: number | string;
  source: 'manual' | 'import';
  import_batch_id: string | null;
  status: BankTransaction['status'];
  match_type: BankTransaction['matchType'];
  match_id: string | null;
  category_account_id: string | null;
  journal_id: string | null;
  transfer_bank_account_id: string | null;
  notes: string;
  created_at: string;
};

type ImportBatchRow = {
  id: string;
  bank_account_id: string;
  filename: string;
  imported_at: string;
  imported_by: string | null;
  row_count: number;
  notes: string;
};

type ReconciliationRow = {
  id: string;
  bank_account_id: string;
  statement_date: string;
  statement_ending_balance: number | string;
  book_ending_balance: number | string;
  difference: number | string;
  unmatched_count: number;
  unmatched_amount: number | string;
  matched_count: number;
  status: 'draft' | 'completed';
  notes: string;
  completed_at: string | null;
  created_at: string;
};

type GlAccountInfo = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  systemRole: string | null;
};

const AMOUNT_TOLERANCE = 0.01;

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function amountsEqual(a: number, b: number): boolean {
  return Math.abs(round2(a) - round2(b)) <= AMOUNT_TOLERANCE;
}

function requireView(actor: RequestUser): void {
  if (!canViewBanking(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view banking data.', 403);
  }
}

function requireManage(actor: RequestUser): void {
  if (!canManageBanking(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage banking data.', 403);
  }
}

async function loadGlAccount(supabase: SupabaseClient, id: string): Promise<GlAccountInfo> {
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id, code, name, account_type, system_role')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load GL account.', 500);
  }
  if (!data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'GL account not found.', 404);
  }
  return {
    id: data.id as string,
    code: data.code as string,
    name: data.name as string,
    accountType: data.account_type as string,
    systemRole: (data.system_role as string | null) ?? null,
  };
}

async function glAccountMap(supabase: SupabaseClient, ids: string[]): Promise<Map<string, GlAccountInfo>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id, code, name, account_type, system_role')
    .in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load GL accounts.', 500);
  }
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        id: row.id as string,
        code: row.code as string,
        name: row.name as string,
        accountType: row.account_type as string,
        systemRole: (row.system_role as string | null) ?? null,
      },
    ]),
  );
}

async function bankAccountNameMap(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('finance_bank_accounts')
    .select('id, display_name')
    .in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank accounts.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.display_name as string]));
}

function mapBankAccount(row: BankAccountRow, gl: GlAccountInfo | undefined): BankAccount {
  return {
    id: row.id,
    glAccountId: row.gl_account_id,
    glAccountCode: gl?.code ?? null,
    glAccountName: gl?.name ?? null,
    displayName: row.display_name,
    accountKind: row.account_kind,
    bankName: row.bank_name ?? '',
    accountNumberMasked: row.account_number_masked ?? '',
    currencyCode: row.currency_code ?? 'INR',
    isActive: row.is_active,
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(
  row: BankTxnRow,
  bankName: string | null,
  categoryName: string | null,
  matchLabel: string | null,
): BankTransaction {
  return {
    id: row.id,
    documentNumber: row.document_number,
    bankAccountId: row.bank_account_id,
    bankAccountName: bankName,
    transactionDate: row.transaction_date,
    description: row.description ?? '',
    reference: row.reference ?? '',
    transactionType: row.transaction_type,
    amount: num(row.amount),
    source: row.source,
    importBatchId: row.import_batch_id,
    status: row.status,
    matchType: row.match_type,
    matchId: row.match_id,
    matchLabel,
    categoryAccountId: row.category_account_id,
    categoryAccountName: categoryName,
    journalId: row.journal_id,
    transferBankAccountId: row.transfer_bank_account_id,
    notes: row.notes ?? '',
    createdAt: row.created_at,
  };
}

function mapImportBatch(row: ImportBatchRow): BankImportBatch {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    filename: row.filename ?? 'statement.csv',
    importedAt: row.imported_at,
    importedBy: row.imported_by,
    rowCount: row.row_count ?? 0,
    notes: row.notes ?? '',
  };
}

function mapReconciliation(row: ReconciliationRow, bankName: string | null): BankReconciliation {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: bankName,
    statementDate: row.statement_date,
    statementEndingBalance: num(row.statement_ending_balance),
    bookEndingBalance: num(row.book_ending_balance),
    difference: num(row.difference),
    unmatchedCount: row.unmatched_count ?? 0,
    unmatchedAmount: num(row.unmatched_amount),
    matchedCount: row.matched_count ?? 0,
    status: row.status,
    notes: row.notes ?? '',
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

async function resolveMatchLabel(
  supabase: SupabaseClient,
  matchType: BankTransaction['matchType'],
  matchId: string | null,
  transferBankAccountId: string | null,
): Promise<string | null> {
  if (!matchType) return null;
  if (matchType === 'transfer') {
    if (!transferBankAccountId) return 'Transfer';
    const names = await bankAccountNameMap(supabase, [transferBankAccountId]);
    const name = names.get(transferBankAccountId);
    return name ? `Transfer · ${name}` : 'Transfer';
  }
  if (!matchId) return null;

  if (matchType === 'customer_payment') {
    const { data } = await supabase
      .from('finance_customer_payments')
      .select('document_number, customer_id')
      .eq('id', matchId)
      .maybeSingle();
    if (!data) return matchId;
    const { data: customer } = await supabase
      .from('finance_customers')
      .select('display_name')
      .eq('id', data.customer_id as string)
      .maybeSingle();
    const party = (customer?.display_name as string | undefined) ?? null;
    return party
      ? `${data.document_number as string} · ${party}`
      : (data.document_number as string);
  }
  if (matchType === 'vendor_payment') {
    const { data } = await supabase
      .from('finance_vendor_payments')
      .select('document_number, vendor_id')
      .eq('id', matchId)
      .maybeSingle();
    if (!data) return matchId;
    const { data: vendor } = await supabase
      .from('finance_vendors')
      .select('display_name')
      .eq('id', data.vendor_id as string)
      .maybeSingle();
    const party = (vendor?.display_name as string | undefined) ?? null;
    return party
      ? `${data.document_number as string} · ${party}`
      : (data.document_number as string);
  }
  if (matchType === 'expense') {
    const { data } = await supabase
      .from('finance_expenses')
      .select('document_number, description')
      .eq('id', matchId)
      .maybeSingle();
    if (!data) return matchId;
    const desc = ((data.description as string) || '').trim();
    return desc
      ? `${data.document_number as string} · ${desc}`
      : (data.document_number as string);
  }
  if (matchType === 'expense_reimbursement') {
    const { data } = await supabase
      .from('finance_expense_reimbursements')
      .select('document_number, employee_id')
      .eq('id', matchId)
      .maybeSingle();
    if (!data) return matchId;
    const { data: emp } = await supabase
      .from('employees')
      .select('full_name')
      .eq('id', data.employee_id as string)
      .maybeSingle();
    const party = (emp?.full_name as string | undefined) ?? null;
    return party
      ? `${data.document_number as string} · ${party}`
      : (data.document_number as string);
  }
  return matchId;
}

async function loadBankAccountRow(supabase: SupabaseClient, id: string): Promise<BankAccountRow> {
  const { data, error } = await supabase.from('finance_bank_accounts').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank account.', 500);
  }
  if (!data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Bank account not found.', 404);
  }
  return data as BankAccountRow;
}

async function loadBankAccount(supabase: SupabaseClient, id: string): Promise<BankAccount> {
  const row = await loadBankAccountRow(supabase, id);
  const gl = await loadGlAccount(supabase, row.gl_account_id);
  return mapBankAccount(row, gl);
}

async function loadTransaction(supabase: SupabaseClient, id: string): Promise<BankTransaction> {
  const { data, error } = await supabase.from('finance_bank_transactions').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank transaction.', 500);
  }
  if (!data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Bank transaction not found.', 404);
  }
  const row = data as BankTxnRow;
  const [bankNames, categoryMap, matchLabel] = await Promise.all([
    bankAccountNameMap(supabase, [row.bank_account_id]),
    row.category_account_id
      ? glAccountMap(supabase, [row.category_account_id])
      : Promise.resolve(new Map<string, GlAccountInfo>()),
    resolveMatchLabel(supabase, row.match_type, row.match_id, row.transfer_bank_account_id),
  ]);
  return mapTransaction(
    row,
    bankNames.get(row.bank_account_id) ?? null,
    row.category_account_id ? (categoryMap.get(row.category_account_id)?.name ?? null) : null,
    matchLabel,
  );
}

async function alreadyMatchedIds(
  supabase: SupabaseClient,
  matchType: NonNullable<BankTransaction['matchType']>,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('finance_bank_transactions')
    .select('match_id')
    .eq('status', 'matched')
    .eq('match_type', matchType)
    .not('match_id', 'is', null);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load matched documents.', 500);
  }
  return new Set((data ?? []).map((row) => row.match_id as string).filter(Boolean));
}

function parseCsvDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }
  return null;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

type ParsedCsvRow = {
  transactionDate: string;
  description: string;
  reference: string;
  transactionType: 'credit' | 'debit';
  amount: number;
};

function parseStatementCsv(csvText: string): ParsedCsvRow[] {
  const text = csvText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'CSV must include a header and at least one data row.', 400);
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const indexOf = (name: string) => headers.indexOf(name);

  const dateIdx = indexOf('date');
  const descIdx = indexOf('description');
  const refIdx = indexOf('reference');
  const debitIdx = indexOf('debit');
  const creditIdx = indexOf('credit');
  const amountIdx = indexOf('amount');
  const typeIdx = indexOf('type');

  const debitCreditMode = debitIdx >= 0 && creditIdx >= 0;
  const amountTypeMode = amountIdx >= 0 && typeIdx >= 0;

  if (dateIdx < 0 || descIdx < 0 || (!debitCreditMode && !amountTypeMode)) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'CSV headers must be date,description,reference,debit,credit or date,description,reference,amount,type.',
      400,
    );
  }

  const rows: ParsedCsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.every((c) => !c)) continue;

    const dateRaw = cells[dateIdx] ?? '';
    const transactionDate = parseCsvDate(dateRaw);
    if (!transactionDate) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Invalid date on row ${i + 1}: ${dateRaw}`, 400);
    }

    const description = (cells[descIdx] ?? '').trim();
    const reference = refIdx >= 0 ? (cells[refIdx] ?? '').trim() : '';

    let transactionType: 'credit' | 'debit';
    let amount: number;

    if (debitCreditMode) {
      const debit = round2(num(cells[debitIdx] || 0));
      const credit = round2(num(cells[creditIdx] || 0));
      if (debit <= 0 && credit <= 0) continue;
      if (debit > 0 && credit > 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Row ${i + 1} has both debit and credit amounts.`,
          400,
        );
      }
      if (debit > 0) {
        transactionType = 'debit';
        amount = debit;
      } else {
        transactionType = 'credit';
        amount = credit;
      }
    } else {
      amount = round2(num(cells[amountIdx] || 0));
      const typeRaw = (cells[typeIdx] ?? '').trim().toLowerCase();
      if (amount <= 0) continue;
      if (typeRaw !== 'credit' && typeRaw !== 'debit') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Row ${i + 1} type must be credit or debit.`,
          400,
        );
      }
      transactionType = typeRaw;
    }

    if (!(amount > 0)) continue;
    rows.push({ transactionDate, description, reference, transactionType, amount });
  }

  if (!rows.length) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'CSV contained no importable rows.', 400);
  }
  return rows;
}

async function computeBookBalance(supabase: SupabaseClient, bankAccountId: string, asOfDate: string): Promise<number> {
  const bank = await loadBankAccountRow(supabase, bankAccountId);
  const { data: lineData, error: lineErr } = await supabase
    .from('finance_journal_lines')
    .select('id, journal_id, debit, credit')
    .eq('account_id', bank.gl_account_id);
  if (lineErr) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal lines.', 500);
  }
  const lines = (lineData ?? []) as Array<{
    id: string;
    journal_id: string;
    debit: number | string;
    credit: number | string;
  }>;
  if (!lines.length) return 0;

  const journalIds = [...new Set(lines.map((line) => line.journal_id))];
  const { data: journalData, error: journalErr } = await supabase
    .from('finance_journal_entries')
    .select('id, entry_date, status')
    .in('id', journalIds)
    .eq('status', 'posted')
    .lte('entry_date', asOfDate);
  if (journalErr) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal entries.', 500);
  }
  const posted = new Set((journalData ?? []).map((row) => row.id as string));
  let balance = 0;
  for (const line of lines) {
    if (!posted.has(line.journal_id)) continue;
    balance = round2(balance + num(line.debit) - num(line.credit));
  }
  return balance;
}

async function buildReconciliationReport(
  supabase: SupabaseClient,
  input: { bankAccountId: string; asOfDate: string; statementEndingBalance: number },
): Promise<BankReconciliationReport> {
  const bank = await loadBankAccount(supabase, input.bankAccountId);
  if (!input.asOfDate) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'asOfDate is required.', 400);
  }
  const statementEndingBalance = round2(num(input.statementEndingBalance));
  const bookEndingBalance = await computeBookBalance(supabase, input.bankAccountId, input.asOfDate);

  const { data, error } = await supabase
    .from('finance_bank_transactions')
    .select('*')
    .eq('bank_account_id', input.bankAccountId)
    .lte('transaction_date', input.asOfDate)
    .order('transaction_date', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load bank transactions.', 500);
  }
  const rows = (data ?? []) as BankTxnRow[];
  let matchedCount = 0;
  let unmatchedCount = 0;
  let categorizedCount = 0;
  let excludedCount = 0;
  let unmatchedAmount = 0;
  const unmatchedRows: BankTxnRow[] = [];

  for (const row of rows) {
    if (row.status === 'matched') matchedCount += 1;
    else if (row.status === 'categorized') categorizedCount += 1;
    else if (row.status === 'excluded') excludedCount += 1;
    else if (row.status === 'unmatched') {
      unmatchedCount += 1;
      unmatchedRows.push(row);
      const signed = row.transaction_type === 'credit' ? num(row.amount) : -num(row.amount);
      unmatchedAmount = round2(unmatchedAmount + signed);
    }
  }

  const unmatchedTransactions: BankTransaction[] = unmatchedRows.map((row) =>
    mapTransaction(row, bank.displayName, null, null),
  );

  return {
    bankAccountId: bank.id,
    bankAccountName: bank.displayName,
    asOfDate: input.asOfDate,
    statementEndingBalance,
    bookEndingBalance,
    difference: round2(statementEndingBalance - bookEndingBalance),
    matchedCount,
    unmatchedCount,
    unmatchedAmount,
    categorizedCount,
    excludedCount,
    unmatchedTransactions,
  };
}

export function createBankingService(supabase: SupabaseClient) {
  return {
    async listBankAccounts(actor: RequestUser): Promise<BankAccount[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_bank_accounts')
        .select('*')
        .order('display_name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list bank accounts.', 500);
      }
      const rows = (data ?? []) as BankAccountRow[];
      const glMap = await glAccountMap(
        supabase,
        rows.map((row) => row.gl_account_id),
      );
      return rows.map((row) => mapBankAccount(row, glMap.get(row.gl_account_id)));
    },

    async getBankAccount(actor: RequestUser, id: string): Promise<BankAccount> {
      requireView(actor);
      return loadBankAccount(supabase, id);
    },

    async createBankAccount(
      actor: RequestUser,
      input: {
        glAccountId: string;
        displayName: string;
        accountKind: 'bank' | 'cash';
        bankName?: string;
        accountNumberMasked?: string;
        notes?: string;
      },
      meta: RequestMeta = {},
    ): Promise<BankAccount> {
      requireManage(actor);
      const displayName = input.displayName?.trim();
      if (!displayName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Display name is required.', 400);
      }
      if (input.accountKind !== 'bank' && input.accountKind !== 'cash') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'accountKind must be bank or cash.', 400);
      }
      const gl = await loadGlAccount(supabase, input.glAccountId);
      if (gl.accountType !== 'asset') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account GL must be an asset account.', 400);
      }
      // Prefer bank/cash system roles when present; any asset GL is still allowed.

      const { data, error } = await supabase
        .from('finance_bank_accounts')
        .insert({
          gl_account_id: input.glAccountId,
          display_name: displayName,
          account_kind: input.accountKind,
          bank_name: input.bankName?.trim() ?? '',
          account_number_masked: input.accountNumberMasked?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create bank account.', 500);
      }
      const created = mapBankAccount(data as BankAccountRow, gl);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_account.create',
        entityType: 'finance_bank_account',
        entityId: created.id,
        newValues: {
          displayName: created.displayName,
          glAccountId: created.glAccountId,
          accountKind: created.accountKind,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return created;
    },

    async updateBankAccount(
      actor: RequestUser,
      id: string,
      input: {
        displayName?: string;
        accountKind?: 'bank' | 'cash';
        bankName?: string;
        accountNumberMasked?: string;
        notes?: string;
        isActive?: boolean;
      },
      meta: RequestMeta = {},
    ): Promise<BankAccount> {
      requireManage(actor);
      const existing = await loadBankAccount(supabase, id);
      const patch: Record<string, unknown> = {};
      if (input.displayName !== undefined) {
        const displayName = input.displayName.trim();
        if (!displayName) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Display name is required.', 400);
        }
        patch.display_name = displayName;
      }
      if (input.accountKind !== undefined) {
        if (input.accountKind !== 'bank' && input.accountKind !== 'cash') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'accountKind must be bank or cash.', 400);
        }
        patch.account_kind = input.accountKind;
      }
      if (input.bankName !== undefined) patch.bank_name = input.bankName.trim();
      if (input.accountNumberMasked !== undefined) {
        patch.account_number_masked = input.accountNumberMasked.trim();
      }
      if (input.notes !== undefined) patch.notes = input.notes.trim();
      if (input.isActive !== undefined) patch.is_active = input.isActive;

      if (!Object.keys(patch).length) {
        return existing;
      }

      const { data, error } = await supabase
        .from('finance_bank_accounts')
        .update(patch)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update bank account.', 500);
      }
      const updated = await loadBankAccount(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_account.update',
        entityType: 'finance_bank_account',
        entityId: id,
        oldValues: {
          displayName: existing.displayName,
          accountKind: existing.accountKind,
          isActive: existing.isActive,
        },
        newValues: {
          displayName: updated.displayName,
          accountKind: updated.accountKind,
          isActive: updated.isActive,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async listTransactions(
      actor: RequestUser,
      filters: {
        bankAccountId?: string;
        status?: BankTransaction['status'];
        fromDate?: string;
        toDate?: string;
      } = {},
    ): Promise<BankTransaction[]> {
      requireView(actor);
      let query = supabase.from('finance_bank_transactions').select('*').order('transaction_date', {
        ascending: false,
      });
      if (filters.bankAccountId) query = query.eq('bank_account_id', filters.bankAccountId);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.fromDate) query = query.gte('transaction_date', filters.fromDate);
      if (filters.toDate) query = query.lte('transaction_date', filters.toDate);

      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list bank transactions.', 500);
      }
      const rows = (data ?? []) as BankTxnRow[];
      const bankNames = await bankAccountNameMap(
        supabase,
        rows.map((row) => row.bank_account_id),
      );
      const categoryIds = rows.map((row) => row.category_account_id).filter(Boolean) as string[];
      const categoryMap = await glAccountMap(supabase, categoryIds);

      const result: BankTransaction[] = [];
      for (const row of rows) {
        const matchLabel = await resolveMatchLabel(
          supabase,
          row.match_type,
          row.match_id,
          row.transfer_bank_account_id,
        );
        result.push(
          mapTransaction(
            row,
            bankNames.get(row.bank_account_id) ?? null,
            row.category_account_id ? (categoryMap.get(row.category_account_id)?.name ?? null) : null,
            matchLabel,
          ),
        );
      }
      return result;
    },

    async getTransaction(actor: RequestUser, id: string): Promise<BankTransaction> {
      requireView(actor);
      return loadTransaction(supabase, id);
    },

    async createManualTransaction(
      actor: RequestUser,
      input: {
        bankAccountId: string;
        transactionDate: string;
        description?: string;
        reference?: string;
        transactionType: 'credit' | 'debit';
        amount: number;
        notes?: string;
      },
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      await loadBankAccountRow(supabase, input.bankAccountId);
      if (input.transactionType !== 'credit' && input.transactionType !== 'debit') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'transactionType must be credit or debit.', 400);
      }
      const amount = round2(num(input.amount));
      if (!(amount > 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Amount must be greater than zero.', 400);
      }
      if (!input.transactionDate?.trim()) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'transactionDate is required.', 400);
      }

      const documentNumber = await allocateDocumentNumber(supabase, 'bank_transaction');
      const { data, error } = await supabase
        .from('finance_bank_transactions')
        .insert({
          document_number: documentNumber,
          bank_account_id: input.bankAccountId,
          transaction_date: input.transactionDate,
          description: input.description?.trim() ?? '',
          reference: input.reference?.trim() ?? '',
          transaction_type: input.transactionType,
          amount,
          source: 'manual',
          status: 'unmatched',
          notes: input.notes?.trim() ?? '',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          error?.message ?? 'Failed to create bank transaction.',
          500,
        );
      }
      const created = await loadTransaction(supabase, data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.create',
        entityType: 'finance_bank_transaction',
        entityId: created.id,
        newValues: {
          documentNumber: created.documentNumber,
          amount: created.amount,
          transactionType: created.transactionType,
          bankAccountId: created.bankAccountId,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return created;
    },

    async excludeTransaction(
      actor: RequestUser,
      id: string,
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      const txn = await loadTransaction(supabase, id);
      if (txn.status !== 'unmatched' && txn.status !== 'excluded') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only unmatched or excluded transactions can be excluded.',
          400,
        );
      }
      if (txn.status === 'excluded') return txn;

      const { error } = await supabase
        .from('finance_bank_transactions')
        .update({ status: 'excluded' })
        .eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      const updated = await loadTransaction(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.exclude',
        entityType: 'finance_bank_transaction',
        entityId: id,
        oldValues: { status: txn.status },
        newValues: { status: 'excluded' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async unexcludeTransaction(
      actor: RequestUser,
      id: string,
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      const txn = await loadTransaction(supabase, id);
      if (txn.status !== 'excluded' && txn.status !== 'unmatched') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only excluded or unmatched transactions can be unexcluded.',
          400,
        );
      }
      if (txn.status === 'unmatched') return txn;

      const { error } = await supabase
        .from('finance_bank_transactions')
        .update({ status: 'unmatched' })
        .eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      const updated = await loadTransaction(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.unexclude',
        entityType: 'finance_bank_transaction',
        entityId: id,
        oldValues: { status: txn.status },
        newValues: { status: 'unmatched' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    /**
     * Match a statement line to a posted document (or transfer).
     * Transfer V1: set match_type=transfer + transfer_bank_account_id only.
     * Do NOT auto-create the opposite bank txn — import/create both sides separately.
     */
    async matchTransaction(
      actor: RequestUser,
      id: string,
      input: {
        matchType: NonNullable<BankTransaction['matchType']>;
        matchId?: string;
        transferBankAccountId?: string;
      },
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      const txn = await loadTransaction(supabase, id);
      if (txn.status !== 'unmatched') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only unmatched transactions can be matched.', 400);
      }

      const bank = await loadBankAccountRow(supabase, txn.bankAccountId);
      const matchType = input.matchType;
      let matchId: string | null = input.matchId ?? null;
      let transferBankAccountId: string | null = null;
      let matchLabel: string | null = null;

      if (matchType === 'transfer') {
        if (!input.transferBankAccountId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'transferBankAccountId is required for transfer matches.',
            400,
          );
        }
        if (input.transferBankAccountId === txn.bankAccountId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Transfer offset account must be different.',
            400,
          );
        }
        await loadBankAccountRow(supabase, input.transferBankAccountId);
        transferBankAccountId = input.transferBankAccountId;
        matchId = null;
        matchLabel = await resolveMatchLabel(supabase, 'transfer', null, transferBankAccountId);
      } else {
        if (!matchId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'matchId is required.', 400);
        }
        const taken = await alreadyMatchedIds(supabase, matchType);
        if (taken.has(matchId)) {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Document is already matched to a bank transaction.', 409);
        }

        if (matchType === 'customer_payment') {
          if (txn.transactionType !== 'credit') {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Customer payments match credit (deposit) transactions.',
              400,
            );
          }
          const { data, error } = await supabase
            .from('finance_customer_payments')
            .select('id, document_number, amount, status, bank_account_id, customer_id')
            .eq('id', matchId)
            .maybeSingle();
          if (error || !data) {
            throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Customer payment not found.', 404);
          }
          if (data.status !== 'posted') {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Customer payment must be posted.', 400);
          }
          if (!amountsEqual(num(data.amount), txn.amount)) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Payment amount does not match transaction.', 400);
          }
          if (data.bank_account_id && data.bank_account_id !== bank.gl_account_id) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Payment bank GL does not match this bank account.',
              400,
            );
          }
        } else if (matchType === 'vendor_payment') {
          if (txn.transactionType !== 'debit') {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Vendor payments match debit (withdrawal) transactions.',
              400,
            );
          }
          const { data, error } = await supabase
            .from('finance_vendor_payments')
            .select('id, document_number, amount, status, bank_account_id')
            .eq('id', matchId)
            .maybeSingle();
          if (error || !data) {
            throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Vendor payment not found.', 404);
          }
          if (data.status !== 'posted') {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor payment must be posted.', 400);
          }
          if (!amountsEqual(num(data.amount), txn.amount)) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Payment amount does not match transaction.', 400);
          }
          if (data.bank_account_id && data.bank_account_id !== bank.gl_account_id) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Payment bank GL does not match this bank account.',
              400,
            );
          }
        } else if (matchType === 'expense') {
          if (txn.transactionType !== 'debit') {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Expenses match debit (withdrawal) transactions.',
              400,
            );
          }
          const { data, error } = await supabase
            .from('finance_expenses')
            .select('id, document_number, grand_total, status, paid_through, bank_account_id')
            .eq('id', matchId)
            .maybeSingle();
          if (error || !data) {
            throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Expense not found.', 404);
          }
          if (data.status !== 'posted') {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Expense must be posted.', 400);
          }
          if (data.paid_through !== 'bank' && data.paid_through !== 'cash') {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Expense must be paid through bank or cash.',
              400,
            );
          }
          if (!amountsEqual(num(data.grand_total), txn.amount)) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Expense amount does not match transaction.', 400);
          }
          if (data.bank_account_id && data.bank_account_id !== bank.gl_account_id) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Expense bank GL does not match this bank account.',
              400,
            );
          }
        } else if (matchType === 'expense_reimbursement') {
          if (txn.transactionType !== 'debit') {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Reimbursements match debit (withdrawal) transactions.',
              400,
            );
          }
          const { data, error } = await supabase
            .from('finance_expense_reimbursements')
            .select('id, document_number, amount, status, bank_account_id')
            .eq('id', matchId)
            .maybeSingle();
          if (error || !data) {
            throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Expense reimbursement not found.', 404);
          }
          if (data.status !== 'posted') {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Reimbursement must be posted.', 400);
          }
          if (!amountsEqual(num(data.amount), txn.amount)) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Reimbursement amount does not match transaction.',
              400,
            );
          }
          if (data.bank_account_id && data.bank_account_id !== bank.gl_account_id) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Reimbursement bank GL does not match this bank account.',
              400,
            );
          }
        } else {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid matchType.', 400);
        }
        matchLabel = await resolveMatchLabel(supabase, matchType, matchId, null);
      }

      const { error: updErr } = await supabase
        .from('finance_bank_transactions')
        .update({
          status: 'matched',
          match_type: matchType,
          match_id: matchId,
          transfer_bank_account_id: transferBankAccountId,
          category_account_id: null,
          journal_id: null,
        })
        .eq('id', id);
      if (updErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }

      const updated = await loadTransaction(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.match',
        entityType: 'finance_bank_transaction',
        entityId: id,
        newValues: { matchType, matchId, transferBankAccountId, matchLabel },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async unmatchTransaction(
      actor: RequestUser,
      id: string,
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      const txn = await loadTransaction(supabase, id);
      if (txn.status !== 'matched') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only matched transactions can be unmatched.', 400);
      }

      const { error } = await supabase
        .from('finance_bank_transactions')
        .update({
          status: 'unmatched',
          match_type: null,
          match_id: null,
          transfer_bank_account_id: null,
        })
        .eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const updated = await loadTransaction(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.unmatch',
        entityType: 'finance_bank_transaction',
        entityId: id,
        oldValues: {
          matchType: txn.matchType,
          matchId: txn.matchId,
          transferBankAccountId: txn.transferBankAccountId,
        },
        newValues: { status: 'unmatched' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async categorizeTransaction(
      actor: RequestUser,
      id: string,
      input: { categoryAccountId: string },
      meta: RequestMeta = {},
    ): Promise<BankTransaction> {
      requireManage(actor);
      const txn = await loadTransaction(supabase, id);
      if (txn.status !== 'unmatched') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only unmatched transactions can be categorized.',
          400,
        );
      }
      const bank = await loadBankAccountRow(supabase, txn.bankAccountId);
      const category = await loadGlAccount(supabase, input.categoryAccountId);
      if (category.id === bank.gl_account_id) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Category account cannot be the same as the bank GL account.',
          400,
        );
      }

      const amount = round2(txn.amount);
      const memo = `Bank categorize ${txn.documentNumber}: ${txn.description || category.name}`.slice(0, 500);
      const lines =
        txn.transactionType === 'credit'
          ? [
              {
                accountId: bank.gl_account_id,
                description: txn.description || 'Bank deposit',
                debit: amount,
                credit: 0,
              },
              {
                accountId: category.id,
                description: txn.description || category.name,
                debit: 0,
                credit: amount,
              },
            ]
          : [
              {
                accountId: category.id,
                description: txn.description || category.name,
                debit: amount,
                credit: 0,
              },
              {
                accountId: bank.gl_account_id,
                description: txn.description || 'Bank withdrawal',
                debit: 0,
                credit: amount,
              },
            ];

      const journalId = await postBalancedJournal(supabase, {
        entryDate: txn.transactionDate,
        memo,
        sourceType: 'bank_categorization',
        sourceId: id,
        createdBy: actor.employeeId,
        lines,
      });

      const { error } = await supabase
        .from('finance_bank_transactions')
        .update({
          status: 'categorized',
          category_account_id: category.id,
          journal_id: journalId,
          match_type: null,
          match_id: null,
          transfer_bank_account_id: null,
        })
        .eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const updated = await loadTransaction(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_transaction.categorize',
        entityType: 'finance_bank_transaction',
        entityId: id,
        newValues: { categoryAccountId: category.id, journalId, amount },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async listMatchCandidates(
      actor: RequestUser,
      input: { bankAccountId: string; transactionId: string },
    ): Promise<BankMatchCandidate[]> {
      requireView(actor);
      const txn = await loadTransaction(supabase, input.transactionId);
      if (txn.bankAccountId !== input.bankAccountId) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Transaction does not belong to the given bank account.',
          400,
        );
      }
      const bank = await loadBankAccountRow(supabase, input.bankAccountId);
      const glId = bank.gl_account_id;
      const amount = txn.amount;
      const candidates: BankMatchCandidate[] = [];

      const preferGl = <T extends { bank_account_id: string | null }>(rows: T[]): T[] => {
        const exact = rows.filter((row) => row.bank_account_id === glId);
        const unset = rows.filter((row) => !row.bank_account_id);
        return [...exact, ...unset];
      };

      if (txn.transactionType === 'credit') {
        const taken = await alreadyMatchedIds(supabase, 'customer_payment');
        const { data, error } = await supabase
          .from('finance_customer_payments')
          .select('id, document_number, payment_date, amount, bank_account_id, customer_id, status')
          .eq('status', 'posted');
        if (error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load customer payments.', 500);
        }
        const rows = preferGl(
          ((data ?? []) as Array<{
            id: string;
            document_number: string;
            payment_date: string;
            amount: number | string;
            bank_account_id: string | null;
            customer_id: string;
            status: string;
          }>).filter((row) => !taken.has(row.id) && amountsEqual(num(row.amount), amount)),
        );
        const customerIds = [...new Set(rows.map((row) => row.customer_id))];
        const { data: customers } = customerIds.length
          ? await supabase.from('finance_customers').select('id, display_name').in('id', customerIds)
          : { data: [] as Array<{ id: string; display_name: string }> };
        const nameMap = new Map((customers ?? []).map((c) => [c.id as string, c.display_name as string]));
        for (const row of rows) {
          const partyName = nameMap.get(row.customer_id) ?? null;
          candidates.push({
            id: row.id,
            type: 'customer_payment',
            documentNumber: row.document_number,
            date: row.payment_date,
            amount: num(row.amount),
            partyName,
            label: partyName ? `${row.document_number} · ${partyName}` : row.document_number,
          });
        }
      } else {
        const [takenVp, takenEx, takenRb] = await Promise.all([
          alreadyMatchedIds(supabase, 'vendor_payment'),
          alreadyMatchedIds(supabase, 'expense'),
          alreadyMatchedIds(supabase, 'expense_reimbursement'),
        ]);

        const { data: vpData, error: vpErr } = await supabase
          .from('finance_vendor_payments')
          .select('id, document_number, payment_date, amount, bank_account_id, vendor_id, status')
          .eq('status', 'posted');
        if (vpErr) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor payments.', 500);
        }
        const vpRows = preferGl(
          ((vpData ?? []) as Array<{
            id: string;
            document_number: string;
            payment_date: string;
            amount: number | string;
            bank_account_id: string | null;
            vendor_id: string;
          }>).filter((row) => !takenVp.has(row.id) && amountsEqual(num(row.amount), amount)),
        );
        const vendorIds = [...new Set(vpRows.map((row) => row.vendor_id))];
        const { data: vendors } = vendorIds.length
          ? await supabase.from('finance_vendors').select('id, display_name').in('id', vendorIds)
          : { data: [] as Array<{ id: string; display_name: string }> };
        const vendorNames = new Map((vendors ?? []).map((v) => [v.id as string, v.display_name as string]));
        for (const row of vpRows) {
          const partyName = vendorNames.get(row.vendor_id) ?? null;
          candidates.push({
            id: row.id,
            type: 'vendor_payment',
            documentNumber: row.document_number,
            date: row.payment_date,
            amount: num(row.amount),
            partyName,
            label: partyName ? `${row.document_number} · ${partyName}` : row.document_number,
          });
        }

        const { data: exData, error: exErr } = await supabase
          .from('finance_expenses')
          .select('id, document_number, expense_date, grand_total, bank_account_id, description, paid_through, status')
          .eq('status', 'posted')
          .in('paid_through', ['bank', 'cash']);
        if (exErr) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load expenses.', 500);
        }
        const exRows = preferGl(
          ((exData ?? []) as Array<{
            id: string;
            document_number: string;
            expense_date: string;
            grand_total: number | string;
            bank_account_id: string | null;
            description: string;
          }>).filter((row) => !takenEx.has(row.id) && amountsEqual(num(row.grand_total), amount)),
        );
        for (const row of exRows) {
          const desc = (row.description || '').trim();
          candidates.push({
            id: row.id,
            type: 'expense',
            documentNumber: row.document_number,
            date: row.expense_date,
            amount: num(row.grand_total),
            partyName: desc || null,
            label: desc ? `${row.document_number} · ${desc}` : row.document_number,
          });
        }

        const { data: rbData, error: rbErr } = await supabase
          .from('finance_expense_reimbursements')
          .select('id, document_number, payment_date, amount, bank_account_id, employee_id, status')
          .eq('status', 'posted');
        if (rbErr) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load reimbursements.', 500);
        }
        const rbRows = preferGl(
          ((rbData ?? []) as Array<{
            id: string;
            document_number: string;
            payment_date: string;
            amount: number | string;
            bank_account_id: string | null;
            employee_id: string;
          }>).filter((row) => !takenRb.has(row.id) && amountsEqual(num(row.amount), amount)),
        );
        const empIds = [...new Set(rbRows.map((row) => row.employee_id))];
        const { data: emps } = empIds.length
          ? await supabase.from('employees').select('id, full_name').in('id', empIds)
          : { data: [] as Array<{ id: string; full_name: string }> };
        const empNames = new Map((emps ?? []).map((e) => [e.id as string, e.full_name as string]));
        for (const row of rbRows) {
          const partyName = empNames.get(row.employee_id) ?? null;
          candidates.push({
            id: row.id,
            type: 'expense_reimbursement',
            documentNumber: row.document_number,
            date: row.payment_date,
            amount: num(row.amount),
            partyName,
            label: partyName ? `${row.document_number} · ${partyName}` : row.document_number,
          });
        }
      }

      return candidates;
    },

    async importStatementCsv(
      actor: RequestUser,
      input: { bankAccountId: string; filename?: string; csvText: string },
      meta: RequestMeta = {},
    ): Promise<{ batch: BankImportBatch; createdCount: number }> {
      requireManage(actor);
      await loadBankAccountRow(supabase, input.bankAccountId);
      if (!input.csvText?.trim()) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'csvText is required.', 400);
      }
      const parsed = parseStatementCsv(input.csvText);

      const { data: batchRow, error: batchErr } = await supabase
        .from('finance_bank_import_batches')
        .insert({
          bank_account_id: input.bankAccountId,
          filename: input.filename?.trim() || 'statement.csv',
          imported_by: actor.employeeId,
          row_count: 0,
        })
        .select('*')
        .single();
      if (batchErr || !batchRow) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          batchErr?.message ?? 'Failed to create import batch.',
          500,
        );
      }

      let createdCount = 0;
      for (const row of parsed) {
        const documentNumber = await allocateDocumentNumber(supabase, 'bank_transaction');
        const { error } = await supabase.from('finance_bank_transactions').insert({
          document_number: documentNumber,
          bank_account_id: input.bankAccountId,
          transaction_date: row.transactionDate,
          description: row.description,
          reference: row.reference,
          transaction_type: row.transactionType,
          amount: row.amount,
          source: 'import',
          import_batch_id: batchRow.id,
          status: 'unmatched',
          created_by: actor.employeeId,
        });
        if (error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
        }
        createdCount += 1;
      }

      const { data: updatedBatch, error: updBatchErr } = await supabase
        .from('finance_bank_import_batches')
        .update({ row_count: createdCount })
        .eq('id', batchRow.id)
        .select('*')
        .single();
      if (updBatchErr || !updatedBatch) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          updBatchErr?.message ?? 'Failed to update import batch.',
          500,
        );
      }

      const batch = mapImportBatch(updatedBatch as ImportBatchRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.bank_import.create',
        entityType: 'finance_bank_import_batch',
        entityId: batch.id,
        newValues: {
          bankAccountId: input.bankAccountId,
          filename: batch.filename,
          createdCount,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { batch, createdCount };
    },

    async getBookBalance(bankAccountId: string, asOfDate: string): Promise<number> {
      return computeBookBalance(supabase, bankAccountId, asOfDate);
    },

    async getReconciliationReport(
      actor: RequestUser,
      input: { bankAccountId: string; asOfDate: string; statementEndingBalance: number },
    ): Promise<BankReconciliationReport> {
      requireView(actor);
      return buildReconciliationReport(supabase, input);
    },

    async listReconciliations(actor: RequestUser): Promise<BankReconciliation[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_bank_reconciliations')
        .select('*')
        .order('statement_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list reconciliations.', 500);
      }
      const rows = (data ?? []) as ReconciliationRow[];
      const names = await bankAccountNameMap(
        supabase,
        rows.map((row) => row.bank_account_id),
      );
      return rows.map((row) => mapReconciliation(row, names.get(row.bank_account_id) ?? null));
    },

    async saveReconciliation(
      actor: RequestUser,
      input: {
        bankAccountId: string;
        statementDate: string;
        statementEndingBalance: number;
        notes?: string;
        complete?: boolean;
      },
      meta: RequestMeta = {},
    ): Promise<BankReconciliation> {
      requireManage(actor);
      const report = await buildReconciliationReport(supabase, {
        bankAccountId: input.bankAccountId,
        asOfDate: input.statementDate,
        statementEndingBalance: input.statementEndingBalance,
      });
      const complete = Boolean(input.complete);
      const { data, error } = await supabase
        .from('finance_bank_reconciliations')
        .insert({
          bank_account_id: input.bankAccountId,
          statement_date: input.statementDate,
          statement_ending_balance: report.statementEndingBalance,
          book_ending_balance: report.bookEndingBalance,
          difference: report.difference,
          unmatched_count: report.unmatchedCount,
          unmatched_amount: report.unmatchedAmount,
          matched_count: report.matchedCount,
          status: complete ? 'completed' : 'draft',
          notes: input.notes?.trim() ?? '',
          completed_at: complete ? new Date().toISOString() : null,
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          error?.message ?? 'Failed to save reconciliation.',
          500,
        );
      }
      const saved = mapReconciliation(data as ReconciliationRow, report.bankAccountName);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: complete ? 'finance.bank_reconciliation.complete' : 'finance.bank_reconciliation.save',
        entityType: 'finance_bank_reconciliation',
        entityId: saved.id,
        newValues: {
          bankAccountId: saved.bankAccountId,
          statementDate: saved.statementDate,
          difference: saved.difference,
          status: saved.status,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return saved;
    },
  };
}
