import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageAccountant, canViewAccountant, type RequestMeta } from './access';
import type {
  GeneralLedger,
  JournalEntry,
  JournalLine,
  OpeningBalanceLine,
  OpeningBalanceSet,
  PeriodLock,
  TrialBalance,
} from './accountant-types';
import { assertPeriodUnlocked } from './period-lock';
import { postBalancedJournal } from './posting';
import { allocateDocumentNumber } from './series-allocate';

type JournalRow = {
  id: string;
  entry_number: string;
  entry_date: string;
  memo: string;
  source_type: string;
  source_id: string | null;
  status: JournalEntry['status'];
  reverses_journal_id: string | null;
  reversed_by_journal_id: string | null;
  created_at: string;
  updated_at: string;
};

type JournalLineRow = {
  id: string;
  journal_id: string;
  account_id: string;
  description: string;
  debit: number | string;
  credit: number | string;
  line_order: number;
};

type AccountInfo = { code: string; name: string; accountType: string };

type PeriodLockRow = {
  id: string;
  period_year: number;
  period_month: number;
  locked_at: string;
  locked_by: string | null;
  notes: string;
};

type OpeningSetRow = {
  id: string;
  as_of_date: string;
  memo: string;
  status: OpeningBalanceSet['status'];
  journal_id: string | null;
  created_at: string;
};

type OpeningLineRow = {
  id: string;
  set_id: string;
  account_id: string;
  debit: number | string;
  credit: number | string;
};

type ManualLineInput = {
  accountId: string;
  description?: string;
  debit: number;
  credit: number;
};

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireView(actor: RequestUser): void {
  if (!canViewAccountant(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view accountant data.', 403);
  }
}

function requireManage(actor: RequestUser): void {
  if (!canManageAccountant(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage accountant data.', 403);
  }
}

function validateBalancedLines(lines: ManualLineInput[]): void {
  if (lines.length < 2) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Journal needs at least two lines.', 400);
  }
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = round2(num(line.debit));
    const c = round2(num(line.credit));
    if (d > 0 && c > 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'A journal line cannot have both debit and credit.', 400);
    }
    if (d <= 0 && c <= 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each journal line needs a debit or credit.', 400);
    }
    if (!line.accountId) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each journal line needs an account.', 400);
    }
    debit += d;
    credit += c;
  }
  if (round2(debit) !== round2(credit)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Journal is out of balance.', 400);
  }
}

async function accountMap(supabase: SupabaseClient, ids: string[]): Promise<Map<string, AccountInfo>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id, code, name, account_type')
    .in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load accounts.', 500);
  }
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        code: row.code as string,
        name: row.name as string,
        accountType: row.account_type as string,
      },
    ]),
  );
}

async function employeeNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('employees').select('id, full_name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee names.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
}

function mapLines(rows: JournalLineRow[], accounts: Map<string, AccountInfo>): JournalLine[] {
  return [...rows]
    .sort((a, b) => a.line_order - b.line_order)
    .map((row) => {
      const account = accounts.get(row.account_id);
      return {
        id: row.id,
        accountId: row.account_id,
        accountCode: account?.code ?? null,
        accountName: account?.name ?? null,
        description: row.description ?? '',
        debit: num(row.debit),
        credit: num(row.credit),
        lineOrder: row.line_order,
      };
    });
}

function mapJournal(row: JournalRow, lines: JournalLine[]): JournalEntry {
  return {
    id: row.id,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    memo: row.memo ?? '',
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    reversesJournalId: row.reverses_journal_id,
    reversedByJournalId: row.reversed_by_journal_id,
    lines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadJournalLines(
  supabase: SupabaseClient,
  journalIds: string[],
): Promise<Map<string, JournalLineRow[]>> {
  const unique = [...new Set(journalIds.filter(Boolean))];
  const byJournal = new Map<string, JournalLineRow[]>();
  if (!unique.length) return byJournal;
  const { data, error } = await supabase
    .from('finance_journal_lines')
    .select('id, journal_id, account_id, description, debit, credit, line_order')
    .in('journal_id', unique)
    .order('line_order', { ascending: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal lines.', 500);
  }
  for (const row of (data ?? []) as JournalLineRow[]) {
    const list = byJournal.get(row.journal_id) ?? [];
    list.push(row);
    byJournal.set(row.journal_id, list);
  }
  return byJournal;
}

async function loadJournal(supabase: SupabaseClient, id: string): Promise<JournalEntry> {
  const { data, error } = await supabase.from('finance_journal_entries').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal.', 500);
  }
  if (!data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Journal not found.', 404);
  }
  const row = data as JournalRow;
  const linesByJournal = await loadJournalLines(supabase, [row.id]);
  const lineRows = linesByJournal.get(row.id) ?? [];
  const accounts = await accountMap(
    supabase,
    lineRows.map((line) => line.account_id),
  );
  return mapJournal(row, mapLines(lineRows, accounts));
}

function mapOpeningLines(rows: OpeningLineRow[], accounts: Map<string, AccountInfo>): OpeningBalanceLine[] {
  return rows.map((row) => {
    const account = accounts.get(row.account_id);
    return {
      id: row.id,
      accountId: row.account_id,
      accountCode: account?.code ?? null,
      accountName: account?.name ?? null,
      debit: num(row.debit),
      credit: num(row.credit),
    };
  });
}

function mapOpeningSet(row: OpeningSetRow, lines: OpeningBalanceLine[]): OpeningBalanceSet {
  const totalDebit = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = round2(lines.reduce((sum, line) => sum + line.credit, 0));
  return {
    id: row.id,
    asOfDate: row.as_of_date,
    memo: row.memo ?? '',
    status: row.status,
    journalId: row.journal_id,
    lines,
    totalDebit,
    totalCredit,
    createdAt: row.created_at,
  };
}

async function loadOpeningBalanceSet(supabase: SupabaseClient, id: string): Promise<OpeningBalanceSet> {
  const { data, error } = await supabase.from('finance_opening_balance_sets').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load opening balance set.', 500);
  }
  if (!data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Opening balance set not found.', 404);
  }
  const row = data as OpeningSetRow;
  const { data: lineData, error: lineErr } = await supabase
    .from('finance_opening_balance_lines')
    .select('id, set_id, account_id, debit, credit')
    .eq('set_id', row.id);
  if (lineErr) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load opening balance lines.', 500);
  }
  const lineRows = (lineData ?? []) as OpeningLineRow[];
  const accounts = await accountMap(
    supabase,
    lineRows.map((line) => line.account_id),
  );
  return mapOpeningSet(row, mapOpeningLines(lineRows, accounts));
}

export function createAccountantService(supabase: SupabaseClient) {
  return {
    async listJournals(
      actor: RequestUser,
      filters?: { fromDate?: string; toDate?: string; status?: JournalEntry['status'] },
    ): Promise<JournalEntry[]> {
      requireView(actor);
      let query = supabase
        .from('finance_journal_entries')
        .select('*')
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (filters?.fromDate) query = query.gte('entry_date', filters.fromDate);
      if (filters?.toDate) query = query.lte('entry_date', filters.toDate);
      if (filters?.status) query = query.eq('status', filters.status);
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list journals.', 500);
      }
      const rows = (data ?? []) as JournalRow[];
      const linesByJournal = await loadJournalLines(
        supabase,
        rows.map((row) => row.id),
      );
      const allAccountIds = [...linesByJournal.values()].flat().map((line) => line.account_id);
      const accounts = await accountMap(supabase, allAccountIds);
      return rows.map((row) => mapJournal(row, mapLines(linesByJournal.get(row.id) ?? [], accounts)));
    },

    async getJournal(actor: RequestUser, id: string): Promise<JournalEntry> {
      requireView(actor);
      return loadJournal(supabase, id);
    },

    async createManualJournal(
      actor: RequestUser,
      input: {
        entryDate: string;
        memo?: string;
        lines: ManualLineInput[];
        post?: boolean;
      },
      meta: RequestMeta,
    ): Promise<JournalEntry> {
      requireManage(actor);
      validateBalancedLines(input.lines);
      const memo = input.memo?.trim() ?? '';
      const normalized = input.lines.map((line) => ({
        accountId: line.accountId,
        description: line.description?.trim() ?? '',
        debit: round2(num(line.debit)),
        credit: round2(num(line.credit)),
      }));

      if (input.post) {
        const journalId = await postBalancedJournal(supabase, {
          entryDate: input.entryDate,
          memo,
          sourceType: 'manual',
          sourceId: null,
          createdBy: actor.employeeId,
          lines: normalized,
        });
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance.journal.create_posted',
          entityType: 'finance_journal_entry',
          entityId: journalId,
          newValues: { entryDate: input.entryDate, memo, lineCount: normalized.length },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        return loadJournal(supabase, journalId);
      }

      const entryNumber = await allocateDocumentNumber(supabase, 'journal');
      const { data: entry, error } = await supabase
        .from('finance_journal_entries')
        .insert({
          entry_number: entryNumber,
          entry_date: input.entryDate,
          memo,
          source_type: 'manual',
          source_id: null,
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !entry) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create journal.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_journal_lines').insert(
        normalized.map((line, index) => ({
          journal_id: entry.id,
          account_id: line.accountId,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          line_order: index,
        })),
      );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.journal.create',
        entityType: 'finance_journal_entry',
        entityId: entry.id as string,
        newValues: { entryNumber, entryDate: input.entryDate, memo, status: 'draft' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadJournal(supabase, entry.id as string);
    },

    async updateManualJournal(
      actor: RequestUser,
      id: string,
      input: {
        entryDate?: string;
        memo?: string;
        lines?: ManualLineInput[];
      },
      meta: RequestMeta,
    ): Promise<JournalEntry> {
      requireManage(actor);
      const existing = await loadJournal(supabase, id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft journals can be updated.', 400);
      }
      if (existing.sourceType !== 'manual') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only manual journals can be updated.', 400);
      }
      const entryDate = input.entryDate ?? existing.entryDate;
      const memo = input.memo !== undefined ? input.memo.trim() : existing.memo;
      const lines =
        input.lines ??
        existing.lines.map((line) => ({
          accountId: line.accountId,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
        }));
      validateBalancedLines(lines);
      const normalized = lines.map((line) => ({
        accountId: line.accountId,
        description: line.description?.trim() ?? '',
        debit: round2(num(line.debit)),
        credit: round2(num(line.credit)),
      }));

      const { error: updErr } = await supabase
        .from('finance_journal_entries')
        .update({ entry_date: entryDate, memo })
        .eq('id', id)
        .eq('status', 'draft');
      if (updErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }

      const { error: delErr } = await supabase.from('finance_journal_lines').delete().eq('journal_id', id);
      if (delErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, delErr.message, 500);
      }
      const { error: lineErr } = await supabase.from('finance_journal_lines').insert(
        normalized.map((line, index) => ({
          journal_id: id,
          account_id: line.accountId,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          line_order: index,
        })),
      );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.journal.update',
        entityType: 'finance_journal_entry',
        entityId: id,
        oldValues: { entryDate: existing.entryDate, memo: existing.memo },
        newValues: { entryDate, memo, lineCount: normalized.length },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadJournal(supabase, id);
    },

    async postManualJournal(actor: RequestUser, id: string, meta: RequestMeta): Promise<JournalEntry> {
      requireManage(actor);
      const existing = await loadJournal(supabase, id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft journals can be posted.', 400);
      }
      if (existing.sourceType !== 'manual') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only manual journals can be posted this way.', 400);
      }
      validateBalancedLines(
        existing.lines.map((line) => ({
          accountId: line.accountId,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
        })),
      );
      await assertPeriodUnlocked(supabase, existing.entryDate);
      const { error } = await supabase
        .from('finance_journal_entries')
        .update({ status: 'posted' })
        .eq('id', id)
        .eq('status', 'draft');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.journal.post',
        entityType: 'finance_journal_entry',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', entryNumber: existing.entryNumber },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadJournal(supabase, id);
    },

    async reverseJournal(actor: RequestUser, id: string, meta: RequestMeta): Promise<JournalEntry> {
      requireManage(actor);
      const original = await loadJournal(supabase, id);
      if (original.status !== 'posted') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only posted journals can be reversed.', 400);
      }
      if (original.reversedByJournalId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Journal has already been reversed.', 400);
      }
      const reversingLines = original.lines.map((line) => ({
        accountId: line.accountId,
        description: line.description ? `Reverse: ${line.description}` : `Reverse ${original.entryNumber}`,
        debit: line.credit,
        credit: line.debit,
      }));
      const reverseId = await postBalancedJournal(supabase, {
        entryDate: original.entryDate,
        memo: `Reversal of ${original.entryNumber}${original.memo ? `: ${original.memo}` : ''}`,
        sourceType: 'journal_reverse',
        sourceId: original.id,
        createdBy: actor.employeeId,
        lines: reversingLines,
        reversesJournalId: original.id,
      });
      const { error } = await supabase
        .from('finance_journal_entries')
        .update({ status: 'reversed', reversed_by_journal_id: reverseId })
        .eq('id', original.id)
        .eq('status', 'posted');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.journal.reverse',
        entityType: 'finance_journal_entry',
        entityId: original.id,
        oldValues: { status: 'posted' },
        newValues: { status: 'reversed', reversedByJournalId: reverseId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadJournal(supabase, reverseId);
    },

    async getGeneralLedger(
      actor: RequestUser,
      input: { accountId: string; fromDate?: string; toDate?: string },
    ): Promise<GeneralLedger> {
      requireView(actor);
      if (!input.accountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'accountId is required.', 400);
      }
      const accounts = await accountMap(supabase, [input.accountId]);
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Account not found.', 404);
      }

      const { data: lineData, error: lineErr } = await supabase
        .from('finance_journal_lines')
        .select('id, journal_id, account_id, description, debit, credit, line_order')
        .eq('account_id', input.accountId);
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load ledger lines.', 500);
      }
      const lineRows = (lineData ?? []) as JournalLineRow[];
      const journalIds = [...new Set(lineRows.map((line) => line.journal_id))];
      if (!journalIds.length) {
        return {
          accountId: input.accountId,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.accountType,
          fromDate: input.fromDate ?? null,
          toDate: input.toDate ?? null,
          openingBalance: 0,
          lines: [],
          closingBalance: 0,
        };
      }

      const { data: journalData, error: journalErr } = await supabase
        .from('finance_journal_entries')
        .select('id, entry_number, entry_date, memo, source_type, status')
        .in('id', journalIds)
        .eq('status', 'posted');
      if (journalErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journal entries.', 500);
      }
      const journals = new Map(
        ((journalData ?? []) as Array<{
          id: string;
          entry_number: string;
          entry_date: string;
          memo: string;
          source_type: string;
          status: string;
        }>).map((row) => [row.id, row]),
      );

      type Mov = {
        journalId: string;
        entryNumber: string;
        entryDate: string;
        memo: string;
        sourceType: string;
        description: string;
        debit: number;
        credit: number;
        lineOrder: number;
      };
      const movements: Mov[] = [];
      for (const line of lineRows) {
        const journal = journals.get(line.journal_id);
        if (!journal) continue;
        movements.push({
          journalId: journal.id,
          entryNumber: journal.entry_number,
          entryDate: journal.entry_date,
          memo: journal.memo ?? '',
          sourceType: journal.source_type,
          description: line.description ?? '',
          debit: num(line.debit),
          credit: num(line.credit),
          lineOrder: line.line_order,
        });
      }
      movements.sort((a, b) => {
        if (a.entryDate !== b.entryDate) return a.entryDate.localeCompare(b.entryDate);
        if (a.entryNumber !== b.entryNumber) return a.entryNumber.localeCompare(b.entryNumber);
        return a.lineOrder - b.lineOrder;
      });

      // runningBalance += debit - credit (positive = debit balance; credit-nature accounts interpret sign)
      let openingBalance = 0;
      const periodLines: Mov[] = [];
      for (const mov of movements) {
        if (input.fromDate && mov.entryDate < input.fromDate) {
          openingBalance = round2(openingBalance + mov.debit - mov.credit);
          continue;
        }
        if (input.toDate && mov.entryDate > input.toDate) continue;
        periodLines.push(mov);
      }

      let running = openingBalance;
      const lines = periodLines.map((mov) => {
        running = round2(running + mov.debit - mov.credit);
        return {
          journalId: mov.journalId,
          entryNumber: mov.entryNumber,
          entryDate: mov.entryDate,
          memo: mov.memo,
          sourceType: mov.sourceType,
          description: mov.description,
          debit: mov.debit,
          credit: mov.credit,
          runningBalance: running,
        };
      });

      return {
        accountId: input.accountId,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        fromDate: input.fromDate ?? null,
        toDate: input.toDate ?? null,
        openingBalance,
        lines,
        closingBalance: running,
      };
    },

    async getTrialBalance(actor: RequestUser, input: { asOfDate: string }): Promise<TrialBalance> {
      requireView(actor);
      if (!input.asOfDate) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'asOfDate is required.', 400);
      }

      const { data: journalData, error: journalErr } = await supabase
        .from('finance_journal_entries')
        .select('id')
        .eq('status', 'posted')
        .lte('entry_date', input.asOfDate);
      if (journalErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load journals for trial balance.', 500);
      }
      const journalIds = ((journalData ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (!journalIds.length) {
        return {
          asOfDate: input.asOfDate,
          rows: [],
          totalDebit: 0,
          totalCredit: 0,
          isBalanced: true,
        };
      }

      const { data: lineData, error: lineErr } = await supabase
        .from('finance_journal_lines')
        .select('account_id, debit, credit')
        .in('journal_id', journalIds);
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load trial balance lines.', 500);
      }

      const totals = new Map<string, { debit: number; credit: number }>();
      for (const row of (lineData ?? []) as Array<{ account_id: string; debit: number | string; credit: number | string }>) {
        const current = totals.get(row.account_id) ?? { debit: 0, credit: 0 };
        current.debit = round2(current.debit + num(row.debit));
        current.credit = round2(current.credit + num(row.credit));
        totals.set(row.account_id, current);
      }

      const accounts = await accountMap(supabase, [...totals.keys()]);
      const rows = [...totals.entries()]
        .map(([accountId, sums]) => {
          const account = accounts.get(accountId);
          const net = round2(sums.debit - sums.credit);
          return {
            accountId,
            accountCode: account?.code ?? '',
            accountName: account?.name ?? '',
            accountType: account?.accountType ?? '',
            debit: net > 0 ? net : 0,
            credit: net < 0 ? round2(-net) : 0,
          };
        })
        .filter((row) => row.debit !== 0 || row.credit !== 0)
        .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

      const totalDebit = round2(rows.reduce((sum, row) => sum + row.debit, 0));
      const totalCredit = round2(rows.reduce((sum, row) => sum + row.credit, 0));
      return {
        asOfDate: input.asOfDate,
        rows,
        totalDebit,
        totalCredit,
        isBalanced: totalDebit === totalCredit,
      };
    },

    async listPeriodLocks(actor: RequestUser): Promise<PeriodLock[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_period_locks')
        .select('*')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list period locks.', 500);
      }
      const rows = (data ?? []) as PeriodLockRow[];
      const names = await employeeNames(
        supabase,
        rows.map((row) => row.locked_by).filter((id): id is string => Boolean(id)),
      );
      return rows.map((row) => ({
        id: row.id,
        periodYear: row.period_year,
        periodMonth: row.period_month,
        lockedAt: row.locked_at,
        lockedBy: row.locked_by,
        lockedByName: row.locked_by ? (names.get(row.locked_by) ?? null) : null,
        notes: row.notes ?? '',
      }));
    },

    async lockPeriod(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number; notes?: string },
      meta: RequestMeta,
    ): Promise<PeriodLock> {
      requireManage(actor);
      if (input.periodYear < 2000 || input.periodYear > 2100) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid period year.', 400);
      }
      if (input.periodMonth < 1 || input.periodMonth > 12) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid period month.', 400);
      }
      const { data, error } = await supabase
        .from('finance_period_locks')
        .insert({
          period_year: input.periodYear,
          period_month: input.periodMonth,
          locked_by: actor.employeeId,
          notes: input.notes?.trim() ?? '',
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Period is already locked.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to lock period.', 500);
      }
      const row = data as PeriodLockRow;
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.period.lock',
        entityType: 'finance_period_lock',
        entityId: row.id,
        newValues: { periodYear: row.period_year, periodMonth: row.period_month, notes: row.notes },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      const names = await employeeNames(supabase, row.locked_by ? [row.locked_by] : []);
      return {
        id: row.id,
        periodYear: row.period_year,
        periodMonth: row.period_month,
        lockedAt: row.locked_at,
        lockedBy: row.locked_by,
        lockedByName: row.locked_by ? (names.get(row.locked_by) ?? null) : null,
        notes: row.notes ?? '',
      };
    },

    async unlockPeriod(
      actor: RequestUser,
      input: { periodYear: number; periodMonth: number },
      meta: RequestMeta,
    ): Promise<{ unlocked: true }> {
      requireManage(actor);
      const { data: existing, error: findErr } = await supabase
        .from('finance_period_locks')
        .select('*')
        .eq('period_year', input.periodYear)
        .eq('period_month', input.periodMonth)
        .maybeSingle();
      if (findErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to find period lock.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Period lock not found.', 404);
      }
      const { error } = await supabase
        .from('finance_period_locks')
        .delete()
        .eq('period_year', input.periodYear)
        .eq('period_month', input.periodMonth);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.period.unlock',
        entityType: 'finance_period_lock',
        entityId: (existing as PeriodLockRow).id,
        oldValues: {
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
        },
        newValues: { unlocked: true },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return { unlocked: true };
    },

    async listOpeningBalanceSets(actor: RequestUser): Promise<OpeningBalanceSet[]> {
      requireView(actor);
      const { data, error } = await supabase
        .from('finance_opening_balance_sets')
        .select('*')
        .order('as_of_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list opening balance sets.', 500);
      }
      const rows = (data ?? []) as OpeningSetRow[];
      if (!rows.length) return [];
      const { data: lineData, error: lineErr } = await supabase
        .from('finance_opening_balance_lines')
        .select('id, set_id, account_id, debit, credit')
        .in(
          'set_id',
          rows.map((row) => row.id),
        );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load opening balance lines.', 500);
      }
      const lineRows = (lineData ?? []) as OpeningLineRow[];
      const accounts = await accountMap(
        supabase,
        lineRows.map((line) => line.account_id),
      );
      const bySet = new Map<string, OpeningLineRow[]>();
      for (const line of lineRows) {
        const list = bySet.get(line.set_id) ?? [];
        list.push(line);
        bySet.set(line.set_id, list);
      }
      return rows.map((row) => mapOpeningSet(row, mapOpeningLines(bySet.get(row.id) ?? [], accounts)));
    },

    async getOpeningBalanceSet(actor: RequestUser, id: string): Promise<OpeningBalanceSet> {
      requireView(actor);
      return loadOpeningBalanceSet(supabase, id);
    },

    async createOpeningBalanceSet(
      actor: RequestUser,
      input: {
        asOfDate: string;
        memo?: string;
        lines: Array<{ accountId: string; debit: number; credit: number }>;
      },
      meta: RequestMeta,
    ): Promise<OpeningBalanceSet> {
      requireManage(actor);
      validateBalancedLines(
        input.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
        })),
      );
      const memo = input.memo?.trim() || 'Opening balances';
      const normalized = input.lines.map((line) => ({
        accountId: line.accountId,
        debit: round2(num(line.debit)),
        credit: round2(num(line.credit)),
      }));

      const { data: set, error } = await supabase
        .from('finance_opening_balance_sets')
        .insert({
          as_of_date: input.asOfDate,
          memo,
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !set) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An opening balance set already exists for this date.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create opening balances.', 500);
      }
      const { error: lineErr } = await supabase.from('finance_opening_balance_lines').insert(
        normalized.map((line) => ({
          set_id: set.id,
          account_id: line.accountId,
          debit: line.debit,
          credit: line.credit,
        })),
      );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.opening_balance.create',
        entityType: 'finance_opening_balance_set',
        entityId: set.id as string,
        newValues: { asOfDate: input.asOfDate, memo, lineCount: normalized.length },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadOpeningBalanceSet(supabase, set.id as string);
    },

    async updateOpeningBalanceSet(
      actor: RequestUser,
      id: string,
      input: {
        asOfDate?: string;
        memo?: string;
        lines?: Array<{ accountId: string; debit: number; credit: number }>;
      },
      meta: RequestMeta,
    ): Promise<OpeningBalanceSet> {
      requireManage(actor);
      const existing = await loadOpeningBalanceSet(supabase, id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft opening balances can be updated.', 400);
      }
      const asOfDate = input.asOfDate ?? existing.asOfDate;
      const memo = input.memo !== undefined ? input.memo.trim() || 'Opening balances' : existing.memo;
      const lines =
        input.lines ??
        existing.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
        }));
      validateBalancedLines(lines);
      const normalized = lines.map((line) => ({
        accountId: line.accountId,
        debit: round2(num(line.debit)),
        credit: round2(num(line.credit)),
      }));

      const { error: updErr } = await supabase
        .from('finance_opening_balance_sets')
        .update({ as_of_date: asOfDate, memo })
        .eq('id', id)
        .eq('status', 'draft');
      if (updErr) {
        if (updErr.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An opening balance set already exists for this date.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updErr.message, 500);
      }
      const { error: delErr } = await supabase.from('finance_opening_balance_lines').delete().eq('set_id', id);
      if (delErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, delErr.message, 500);
      }
      const { error: lineErr } = await supabase.from('finance_opening_balance_lines').insert(
        normalized.map((line) => ({
          set_id: id,
          account_id: line.accountId,
          debit: line.debit,
          credit: line.credit,
        })),
      );
      if (lineErr) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, lineErr.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.opening_balance.update',
        entityType: 'finance_opening_balance_set',
        entityId: id,
        oldValues: { asOfDate: existing.asOfDate, memo: existing.memo },
        newValues: { asOfDate, memo, lineCount: normalized.length },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadOpeningBalanceSet(supabase, id);
    },

    async postOpeningBalanceSet(actor: RequestUser, id: string, meta: RequestMeta): Promise<OpeningBalanceSet> {
      requireManage(actor);
      const existing = await loadOpeningBalanceSet(supabase, id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft opening balances can be posted.', 400);
      }
      validateBalancedLines(
        existing.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
        })),
      );
      const journalId = await postBalancedJournal(supabase, {
        entryDate: existing.asOfDate,
        memo: existing.memo || 'Opening balances',
        sourceType: 'opening_balance',
        sourceId: existing.id,
        createdBy: actor.employeeId,
        lines: existing.lines.map((line) => ({
          accountId: line.accountId,
          description: 'Opening balance',
          debit: line.debit,
          credit: line.credit,
        })),
      });
      const { error } = await supabase
        .from('finance_opening_balance_sets')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id)
        .eq('status', 'draft');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.opening_balance.post',
        entityType: 'finance_opening_balance_set',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return loadOpeningBalanceSet(supabase, id);
    },
  };
}
