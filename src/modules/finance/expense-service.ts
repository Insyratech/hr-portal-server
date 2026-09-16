import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  canApplyExpenseClaim,
  canApproveExpenseClaim,
  canManageExpense,
  canViewExpense,
  type RequestMeta,
} from './access';
import {
  postDirectExpenseJournal,
  postExpenseClaimJournal,
  postExpenseReimbursementJournal,
} from './posting';
import type {
  DirectExpense,
  ExpenseCategory,
  ExpenseClaim,
  ExpenseReimbursement,
  ReimbursementAllocation,
} from './expense-types';
import { allocateDocumentNumber, lineAmount } from './series-allocate';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type CategoryRow = {
  id: string;
  name: string;
  expense_account_id: string;
  description: string;
  is_active: boolean;
  sort_order: number;
};

type ExpenseRow = {
  id: string;
  document_number: string;
  expense_date: string;
  category_id: string | null;
  vendor_id: string | null;
  expense_account_id: string;
  description: string;
  amount: number | string;
  tax_percent: number | string;
  tax_amount: number | string;
  grand_total: number | string;
  paid_through: DirectExpense['paidThrough'];
  bank_account_id: string | null;
  vendor_invoice_number: string;
  receipt_url: string;
  notes: string;
  status: DirectExpense['status'];
  journal_id: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  id: string;
  document_number: string;
  employee_id: string;
  department_id: string | null;
  category_id: string | null;
  expense_account_id: string | null;
  claim_date: string;
  description: string;
  amount: number | string;
  tax_percent: number | string;
  tax_amount: number | string;
  grand_total: number | string;
  vendor_name: string;
  bill_number: string;
  receipt_url: string;
  notes: string;
  status: ExpenseClaim['status'];
  reviewer_id: string | null;
  reviewer_comment: string | null;
  decided_at: string | null;
  amount_reimbursed: number | string;
  journal_id: string | null;
  created_at: string;
  updated_at: string;
};

type ReimbursementRow = {
  id: string;
  document_number: string;
  employee_id: string;
  payment_date: string;
  amount: number | string;
  bank_account_id: string | null;
  method: string;
  reference: string;
  notes: string;
  status: ExpenseReimbursement['status'];
  journal_id: string | null;
  created_at: string;
};

type AllocationRow = {
  id: string;
  reimbursement_id: string;
  claim_id: string;
  amount: number | string;
};

function num(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function canSeeAllClaims(actor: RequestUser): boolean {
  return canViewExpense(actor) || canApproveExpenseClaim(actor) || canManageExpense(actor);
}

function requireCategoryAccess(actor: RequestUser): void {
  if (!canApplyExpenseClaim(actor) && !canViewExpense(actor) && !canManageExpense(actor) && !canApproveExpenseClaim(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view expense categories.', 403);
  }
}

function requireExpenseView(actor: RequestUser): void {
  if (!canViewExpense(actor) && !canManageExpense(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view expenses.', 403);
  }
}

function requireExpenseManage(actor: RequestUser): void {
  if (!canManageExpense(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage expenses.', 403);
  }
}

function requireClaimAccess(actor: RequestUser): void {
  if (!canApplyExpenseClaim(actor) && !canSeeAllClaims(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot access expense claims.', 403);
  }
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

async function vendorNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('finance_vendors').select('id, display_name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load vendor names.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.display_name as string]));
}

async function categoryNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('finance_expense_categories').select('id, name').in('id', unique);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load expense categories.', 500);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}

async function accountIdByRole(supabase: SupabaseClient, systemRole: string): Promise<string> {
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id')
    .eq('system_role', systemRole)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Account with role ${systemRole} is missing.`, 500);
  }
  return data.id as string;
}

async function resolveExpenseAccountId(
  supabase: SupabaseClient,
  categoryId: string | null | undefined,
  explicit?: string | null,
): Promise<string> {
  if (explicit) return explicit;
  if (categoryId) {
    const { data, error } = await supabase
      .from('finance_expense_categories')
      .select('expense_account_id')
      .eq('id', categoryId)
      .maybeSingle();
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load expense category.', 500);
    }
    if (data?.expense_account_id) return data.expense_account_id as string;
  }
  return accountIdByRole(supabase, 'office_expense');
}

async function resolvePaidThroughAccountId(
  supabase: SupabaseClient,
  paidThrough: DirectExpense['paidThrough'],
  bankAccountId?: string | null,
): Promise<string | null> {
  if (paidThrough === 'accounts_payable') return null;
  if (bankAccountId) return bankAccountId;
  if (paidThrough === 'cash') return accountIdByRole(supabase, 'cash');
  if (paidThrough === 'bank') return accountIdByRole(supabase, 'bank');
  return null;
}

async function isVendorIntraState(supabase: SupabaseClient, vendorId: string | null): Promise<boolean> {
  if (!vendorId) {
    const { data: org } = await supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle();
    return Boolean(org?.state_code);
  }
  const [{ data: org }, { data: vendor }] = await Promise.all([
    supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle(),
    supabase.from('finance_vendors').select('state_code').eq('id', vendorId).maybeSingle(),
  ]);
  const orgState = (org?.state_code as string | null) ?? null;
  const vendorState = (vendor?.state_code as string | null) ?? null;
  return Boolean(orgState && vendorState && orgState === vendorState);
}

async function isClaimIntraState(supabase: SupabaseClient): Promise<boolean> {
  const { data: org } = await supabase.from('finance_organizations').select('state_code').eq('id', ORG_ID).maybeSingle();
  return Boolean(org?.state_code);
}

function mapCategory(row: CategoryRow): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    expenseAccountId: row.expense_account_id,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function mapExpense(
  row: ExpenseRow,
  categoryName: string | null,
  vendorName: string | null,
): DirectExpense {
  return {
    id: row.id,
    documentNumber: row.document_number,
    expenseDate: row.expense_date,
    categoryId: row.category_id,
    categoryName,
    vendorId: row.vendor_id,
    vendorName,
    expenseAccountId: row.expense_account_id,
    description: row.description,
    amount: num(row.amount),
    taxPercent: num(row.tax_percent),
    taxAmount: num(row.tax_amount),
    grandTotal: num(row.grand_total),
    paidThrough: row.paid_through,
    bankAccountId: row.bank_account_id,
    vendorInvoiceNumber: row.vendor_invoice_number,
    receiptUrl: row.receipt_url,
    notes: row.notes,
    status: row.status,
    journalId: row.journal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaim(row: ClaimRow, employeeName: string | null, categoryName: string | null): ExpenseClaim {
  const grandTotal = num(row.grand_total);
  const amountReimbursed = num(row.amount_reimbursed);
  return {
    id: row.id,
    documentNumber: row.document_number,
    employeeId: row.employee_id,
    employeeName,
    departmentId: row.department_id,
    categoryId: row.category_id,
    categoryName,
    expenseAccountId: row.expense_account_id,
    claimDate: row.claim_date,
    description: row.description,
    amount: num(row.amount),
    taxPercent: num(row.tax_percent),
    taxAmount: num(row.tax_amount),
    grandTotal,
    vendorName: row.vendor_name,
    billNumber: row.bill_number,
    receiptUrl: row.receipt_url,
    notes: row.notes,
    status: row.status,
    reviewerId: row.reviewer_id,
    reviewerComment: row.reviewer_comment,
    decidedAt: row.decided_at,
    amountReimbursed,
    amountDue: round2(Math.max(0, grandTotal - amountReimbursed)),
    journalId: row.journal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReimbursement(
  row: ReimbursementRow,
  employeeName: string | null,
  allocations: ReimbursementAllocation[],
): ExpenseReimbursement {
  return {
    id: row.id,
    documentNumber: row.document_number,
    employeeId: row.employee_id,
    employeeName,
    paymentDate: row.payment_date,
    amount: num(row.amount),
    bankAccountId: row.bank_account_id,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    status: row.status,
    journalId: row.journal_id,
    allocations,
    createdAt: row.created_at,
  };
}

export function createExpenseService(supabase: SupabaseClient) {
  async function loadExpense(id: string): Promise<DirectExpense> {
    const { data, error } = await supabase.from('finance_expenses').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load expense.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Expense not found.', 404);
    const row = data as ExpenseRow;
    const [cats, vendors] = await Promise.all([
      categoryNames(supabase, row.category_id ? [row.category_id] : []),
      vendorNames(supabase, row.vendor_id ? [row.vendor_id] : []),
    ]);
    return mapExpense(
      row,
      row.category_id ? cats.get(row.category_id) ?? null : null,
      row.vendor_id ? vendors.get(row.vendor_id) ?? null : null,
    );
  }

  async function loadClaim(id: string): Promise<ExpenseClaim> {
    const { data, error } = await supabase.from('finance_expense_claims').select('*').eq('id', id).maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load expense claim.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Expense claim not found.', 404);
    const row = data as ClaimRow;
    const [names, cats] = await Promise.all([
      employeeNames(supabase, [row.employee_id]),
      categoryNames(supabase, row.category_id ? [row.category_id] : []),
    ]);
    return mapClaim(
      row,
      names.get(row.employee_id) ?? null,
      row.category_id ? cats.get(row.category_id) ?? null : null,
    );
  }

  async function loadReimbursement(id: string): Promise<ExpenseReimbursement> {
    const { data, error } = await supabase
      .from('finance_expense_reimbursements')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load reimbursement.', 500);
    if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Reimbursement not found.', 404);
    const row = data as ReimbursementRow;
    const { data: allocData, error: allocErr } = await supabase
      .from('finance_expense_reimbursement_allocations')
      .select('*')
      .eq('reimbursement_id', id);
    if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load reimbursement allocations.', 500);
    const allocRows = (allocData ?? []) as AllocationRow[];
    const claimIds = allocRows.map((a) => a.claim_id);
    const claimNumberMap = new Map<string, string>();
    if (claimIds.length) {
      const { data: claims, error: claimErr } = await supabase
        .from('finance_expense_claims')
        .select('id, document_number')
        .in('id', claimIds);
      if (claimErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load claim numbers.', 500);
      for (const claim of claims ?? []) {
        claimNumberMap.set(claim.id as string, claim.document_number as string);
      }
    }
    const names = await employeeNames(supabase, [row.employee_id]);
    return mapReimbursement(
      row,
      names.get(row.employee_id) ?? null,
      allocRows.map((a) => ({
        id: a.id,
        claimId: a.claim_id,
        claimNumber: claimNumberMap.get(a.claim_id) ?? null,
        amount: num(a.amount),
      })),
    );
  }

  return {
    async listCategories(actor: RequestUser): Promise<ExpenseCategory[]> {
      requireCategoryAccess(actor);
      const { data, error } = await supabase
        .from('finance_expense_categories')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list expense categories.', 500);
      return ((data ?? []) as CategoryRow[]).map(mapCategory);
    },

    async listExpenses(actor: RequestUser): Promise<DirectExpense[]> {
      requireExpenseView(actor);
      const { data, error } = await supabase
        .from('finance_expenses')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list expenses.', 500);
      const rows = (data ?? []) as ExpenseRow[];
      const [cats, vendors] = await Promise.all([
        categoryNames(
          supabase,
          rows.map((r) => r.category_id).filter(Boolean) as string[],
        ),
        vendorNames(
          supabase,
          rows.map((r) => r.vendor_id).filter(Boolean) as string[],
        ),
      ]);
      return rows.map((row) =>
        mapExpense(
          row,
          row.category_id ? cats.get(row.category_id) ?? null : null,
          row.vendor_id ? vendors.get(row.vendor_id) ?? null : null,
        ),
      );
    },

    async getExpense(actor: RequestUser, id: string): Promise<DirectExpense> {
      requireExpenseView(actor);
      return loadExpense(id);
    },

    async createExpense(
      actor: RequestUser,
      input: {
        expenseDate?: string;
        categoryId?: string | null;
        vendorId?: string | null;
        expenseAccountId?: string | null;
        description: string;
        amount: number;
        taxPercent?: number;
        paidThrough: DirectExpense['paidThrough'];
        bankAccountId?: string | null;
        vendorInvoiceNumber?: string;
        receiptUrl?: string;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<DirectExpense> {
      requireExpenseManage(actor);
      const description = input.description?.trim() ?? '';
      if (!description) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Description is required.', 400);
      }
      if (!(input.amount >= 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Amount cannot be negative.', 400);
      }
      const taxPercent = input.taxPercent ?? 0;
      if (taxPercent < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Tax percent cannot be negative.', 400);
      }
      const paidThrough = input.paidThrough;
      if (!['cash', 'bank', 'accounts_payable'].includes(paidThrough)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid paidThrough value.', 400);
      }
      if (paidThrough === 'accounts_payable' && !input.vendorId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor is required when paying through accounts payable.', 400);
      }

      const expenseAccountId = await resolveExpenseAccountId(supabase, input.categoryId, input.expenseAccountId);
      const bankAccountId = await resolvePaidThroughAccountId(supabase, paidThrough, input.bankAccountId);
      if ((paidThrough === 'cash' || paidThrough === 'bank') && !bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank/cash account is required for paid expenses.', 400);
      }

      const { amount, taxAmount } = lineAmount(1, input.amount, taxPercent);
      const grandTotal = round2(amount + taxAmount);
      const documentNumber = await allocateDocumentNumber(supabase, 'expense');

      const { data, error } = await supabase
        .from('finance_expenses')
        .insert({
          document_number: documentNumber,
          expense_date: input.expenseDate ?? todayIsoDate(),
          category_id: input.categoryId ?? null,
          vendor_id: input.vendorId ?? null,
          expense_account_id: expenseAccountId,
          description,
          amount,
          tax_percent: taxPercent,
          tax_amount: taxAmount,
          grand_total: grandTotal,
          paid_through: paidThrough,
          bank_account_id: bankAccountId,
          vendor_invoice_number: input.vendorInvoiceNumber?.trim() ?? '',
          receipt_url: input.receiptUrl?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create expense.', 500);
      }

      const created = await loadExpense(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense.create',
        entityType: 'finance_expense',
        entityId: created.id,
        newValues: {
          documentNumber: created.documentNumber,
          amount: created.amount,
          grandTotal: created.grandTotal,
          paidThrough: created.paidThrough,
          status: created.status,
        },
        ...meta,
      });
      return created;
    },

    async updateExpense(
      actor: RequestUser,
      id: string,
      input: {
        expenseDate?: string;
        categoryId?: string | null;
        vendorId?: string | null;
        expenseAccountId?: string | null;
        description?: string;
        amount?: number;
        taxPercent?: number;
        paidThrough?: DirectExpense['paidThrough'];
        bankAccountId?: string | null;
        vendorInvoiceNumber?: string;
        receiptUrl?: string;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<DirectExpense> {
      requireExpenseManage(actor);
      const existing = await loadExpense(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft expenses can be edited.', 400);
      }

      const paidThrough = input.paidThrough ?? existing.paidThrough;
      const categoryId = input.categoryId !== undefined ? input.categoryId : existing.categoryId;
      const vendorId = input.vendorId !== undefined ? input.vendorId : existing.vendorId;
      const amount = input.amount ?? existing.amount;
      const taxPercent = input.taxPercent ?? existing.taxPercent;
      const description =
        input.description !== undefined ? input.description.trim() : existing.description;

      if (!description) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Description is required.', 400);
      }
      if (!(amount >= 0) || taxPercent < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Amount and tax percent cannot be negative.', 400);
      }
      if (paidThrough === 'accounts_payable' && !vendorId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor is required when paying through accounts payable.', 400);
      }

      const expenseAccountId = await resolveExpenseAccountId(
        supabase,
        categoryId,
        input.expenseAccountId !== undefined ? input.expenseAccountId : existing.expenseAccountId,
      );
      const bankAccountId = await resolvePaidThroughAccountId(
        supabase,
        paidThrough,
        input.bankAccountId !== undefined ? input.bankAccountId : existing.bankAccountId,
      );
      if ((paidThrough === 'cash' || paidThrough === 'bank') && !bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank/cash account is required for paid expenses.', 400);
      }

      const totals = lineAmount(1, amount, taxPercent);
      const grandTotal = round2(totals.amount + totals.taxAmount);

      const { error } = await supabase
        .from('finance_expenses')
        .update({
          expense_date: input.expenseDate ?? existing.expenseDate,
          category_id: categoryId,
          vendor_id: vendorId,
          expense_account_id: expenseAccountId,
          description,
          amount: totals.amount,
          tax_percent: taxPercent,
          tax_amount: totals.taxAmount,
          grand_total: grandTotal,
          paid_through: paidThrough,
          bank_account_id: paidThrough === 'accounts_payable' ? null : bankAccountId,
          vendor_invoice_number:
            input.vendorInvoiceNumber !== undefined
              ? input.vendorInvoiceNumber.trim()
              : existing.vendorInvoiceNumber,
          receipt_url: input.receiptUrl !== undefined ? input.receiptUrl.trim() : existing.receiptUrl,
          notes: input.notes !== undefined ? input.notes.trim() : existing.notes,
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const updated = await loadExpense(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense.update',
        entityType: 'finance_expense',
        entityId: id,
        oldValues: { amount: existing.amount, grandTotal: existing.grandTotal, paidThrough: existing.paidThrough },
        newValues: { amount: updated.amount, grandTotal: updated.grandTotal, paidThrough: updated.paidThrough },
        ...meta,
      });
      return updated;
    },

    async postExpense(actor: RequestUser, id: string, meta: RequestMeta): Promise<DirectExpense> {
      requireExpenseManage(actor);
      const expense = await loadExpense(id);
      if (expense.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft expenses can be posted.', 400);
      }

      let creditAccountId: string;
      if (expense.paidThrough === 'accounts_payable') {
        if (!expense.vendorId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Vendor is required to post AP expenses.', 400);
        }
        creditAccountId = await accountIdByRole(supabase, 'accounts_payable');
      } else {
        if (!expense.bankAccountId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank/cash account is required to post this expense.', 400);
        }
        creditAccountId = expense.bankAccountId;
      }

      const placeOfSupplyIntraState =
        expense.taxAmount > 0 ? await isVendorIntraState(supabase, expense.vendorId) : true;

      const journalId = await postDirectExpenseJournal(supabase, {
        expenseId: expense.id,
        expenseNumber: expense.documentNumber,
        expenseDate: expense.expenseDate,
        createdBy: actor.employeeId,
        expenseAccountId: expense.expenseAccountId,
        amount: expense.amount,
        taxTotal: expense.taxAmount,
        grandTotal: expense.grandTotal,
        paidThrough: expense.paidThrough,
        creditAccountId,
        placeOfSupplyIntraState,
      });

      const { error } = await supabase
        .from('finance_expenses')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const posted = await loadExpense(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense.post',
        entityType: 'finance_expense',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },

    async listClaims(actor: RequestUser): Promise<ExpenseClaim[]> {
      requireClaimAccess(actor);
      let query = supabase.from('finance_expense_claims').select('*').order('created_at', { ascending: false });
      if (!canSeeAllClaims(actor)) {
        query = query.eq('employee_id', actor.employeeId);
      }
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list expense claims.', 500);
      const rows = (data ?? []) as ClaimRow[];
      const [names, cats] = await Promise.all([
        employeeNames(
          supabase,
          rows.map((r) => r.employee_id),
        ),
        categoryNames(
          supabase,
          rows.map((r) => r.category_id).filter(Boolean) as string[],
        ),
      ]);
      return rows.map((row) =>
        mapClaim(
          row,
          names.get(row.employee_id) ?? null,
          row.category_id ? cats.get(row.category_id) ?? null : null,
        ),
      );
    },

    async getClaim(actor: RequestUser, id: string): Promise<ExpenseClaim> {
      requireClaimAccess(actor);
      const claim = await loadClaim(id);
      if (!canSeeAllClaims(actor) && claim.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this expense claim.', 403);
      }
      return claim;
    },

    async createClaim(
      actor: RequestUser,
      input: {
        categoryId?: string | null;
        claimDate?: string;
        description: string;
        amount: number;
        taxPercent?: number;
        vendorName?: string;
        billNumber?: string;
        receiptUrl?: string;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<ExpenseClaim> {
      if (!canApplyExpenseClaim(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create expense claims.', 403);
      }
      const description = input.description?.trim() ?? '';
      if (!description) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Description is required.', 400);
      }
      if (!(input.amount >= 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Amount cannot be negative.', 400);
      }
      const taxPercent = input.taxPercent ?? 0;
      if (taxPercent < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Tax percent cannot be negative.', 400);
      }

      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('department_id')
        .eq('id', actor.employeeId)
        .maybeSingle();
      if (empErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);

      const { amount, taxAmount } = lineAmount(1, input.amount, taxPercent);
      const grandTotal = round2(amount + taxAmount);
      const documentNumber = await allocateDocumentNumber(supabase, 'expense_claim');

      const { data, error } = await supabase
        .from('finance_expense_claims')
        .insert({
          document_number: documentNumber,
          employee_id: actor.employeeId,
          department_id: (emp?.department_id as string | null) ?? null,
          category_id: input.categoryId ?? null,
          claim_date: input.claimDate ?? todayIsoDate(),
          description,
          amount,
          tax_percent: taxPercent,
          tax_amount: taxAmount,
          grand_total: grandTotal,
          vendor_name: input.vendorName?.trim() ?? '',
          bill_number: input.billNumber?.trim() ?? '',
          receipt_url: input.receiptUrl?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
          status: 'draft',
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create expense claim.', 500);
      }

      const created = await loadClaim(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense_claim.create',
        entityType: 'finance_expense_claim',
        entityId: created.id,
        newValues: {
          documentNumber: created.documentNumber,
          amount: created.amount,
          grandTotal: created.grandTotal,
          status: created.status,
        },
        ...meta,
      });
      return created;
    },

    async updateClaim(
      actor: RequestUser,
      id: string,
      input: {
        categoryId?: string | null;
        claimDate?: string;
        description?: string;
        amount?: number;
        taxPercent?: number;
        vendorName?: string;
        billNumber?: string;
        receiptUrl?: string;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<ExpenseClaim> {
      requireClaimAccess(actor);
      const existing = await loadClaim(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft claims can be edited.', 400);
      }
      if (!canManageExpense(actor) && existing.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot edit this expense claim.', 403);
      }
      if (!canApplyExpenseClaim(actor) && !canManageExpense(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot edit expense claims.', 403);
      }

      const description =
        input.description !== undefined ? input.description.trim() : existing.description;
      const amount = input.amount ?? existing.amount;
      const taxPercent = input.taxPercent ?? existing.taxPercent;
      if (!description) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Description is required.', 400);
      }
      if (!(amount >= 0) || taxPercent < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Amount and tax percent cannot be negative.', 400);
      }

      const totals = lineAmount(1, amount, taxPercent);
      const grandTotal = round2(totals.amount + totals.taxAmount);

      const { error } = await supabase
        .from('finance_expense_claims')
        .update({
          category_id: input.categoryId !== undefined ? input.categoryId : existing.categoryId,
          claim_date: input.claimDate ?? existing.claimDate,
          description,
          amount: totals.amount,
          tax_percent: taxPercent,
          tax_amount: totals.taxAmount,
          grand_total: grandTotal,
          vendor_name: input.vendorName !== undefined ? input.vendorName.trim() : existing.vendorName,
          bill_number: input.billNumber !== undefined ? input.billNumber.trim() : existing.billNumber,
          receipt_url: input.receiptUrl !== undefined ? input.receiptUrl.trim() : existing.receiptUrl,
          notes: input.notes !== undefined ? input.notes.trim() : existing.notes,
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const updated = await loadClaim(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense_claim.update',
        entityType: 'finance_expense_claim',
        entityId: id,
        oldValues: { amount: existing.amount, grandTotal: existing.grandTotal },
        newValues: { amount: updated.amount, grandTotal: updated.grandTotal },
        ...meta,
      });
      return updated;
    },

    async submitClaim(actor: RequestUser, id: string, meta: RequestMeta): Promise<ExpenseClaim> {
      requireClaimAccess(actor);
      const existing = await loadClaim(id);
      if (existing.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft claims can be submitted.', 400);
      }
      if (!canManageExpense(actor) && existing.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit this expense claim.', 403);
      }
      if (!canApplyExpenseClaim(actor) && !canManageExpense(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit expense claims.', 403);
      }

      const { error } = await supabase
        .from('finance_expense_claims')
        .update({ status: 'submitted' })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const updated = await loadClaim(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense_claim.submit',
        entityType: 'finance_expense_claim',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'submitted' },
        ...meta,
      });
      return updated;
    },

    async decideClaim(
      actor: RequestUser,
      id: string,
      input: { decision: 'approve' | 'reject'; comment?: string },
      meta: RequestMeta,
    ): Promise<ExpenseClaim> {
      if (!canApproveExpenseClaim(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot approve expense claims.', 403);
      }
      const existing = await loadClaim(id);
      if (existing.status !== 'submitted') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only submitted claims can be decided.', 400);
      }

      if (input.decision === 'reject') {
        const { error } = await supabase
          .from('finance_expense_claims')
          .update({
            status: 'rejected',
            reviewer_id: actor.employeeId,
            reviewer_comment: input.comment?.trim() ?? null,
            decided_at: new Date().toISOString(),
          })
          .eq('id', id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

        const updated = await loadClaim(id);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'finance.expense_claim.reject',
          entityType: 'finance_expense_claim',
          entityId: id,
          oldValues: { status: 'submitted' },
          newValues: { status: 'rejected', comment: input.comment?.trim() ?? null },
          ...meta,
        });
        return updated;
      }

      const expenseAccountId = await resolveExpenseAccountId(supabase, existing.categoryId, existing.expenseAccountId);
      const placeOfSupplyIntraState =
        existing.taxAmount > 0 ? await isClaimIntraState(supabase) : true;

      const journalId = await postExpenseClaimJournal(supabase, {
        claimId: existing.id,
        claimNumber: existing.documentNumber,
        claimDate: existing.claimDate,
        createdBy: actor.employeeId,
        expenseAccountId,
        amount: existing.amount,
        taxTotal: existing.taxAmount,
        grandTotal: existing.grandTotal,
        placeOfSupplyIntraState,
      });

      const { error } = await supabase
        .from('finance_expense_claims')
        .update({
          status: 'approved',
          expense_account_id: expenseAccountId,
          journal_id: journalId,
          reviewer_id: actor.employeeId,
          reviewer_comment: input.comment?.trim() ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const updated = await loadClaim(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense_claim.approve',
        entityType: 'finance_expense_claim',
        entityId: id,
        oldValues: { status: 'submitted' },
        newValues: { status: 'approved', journalId, expenseAccountId, comment: input.comment?.trim() ?? null },
        ...meta,
      });
      return updated;
    },

    async cancelClaim(actor: RequestUser, id: string, meta: RequestMeta): Promise<ExpenseClaim> {
      requireClaimAccess(actor);
      const existing = await loadClaim(id);
      if (!['draft', 'submitted'].includes(existing.status)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft or submitted claims can be cancelled.', 400);
      }
      if (!canManageExpense(actor) && existing.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot cancel this expense claim.', 403);
      }
      if (!canApplyExpenseClaim(actor) && !canManageExpense(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot cancel expense claims.', 403);
      }

      const { error } = await supabase
        .from('finance_expense_claims')
        .update({ status: 'cancelled' })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const updated = await loadClaim(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.expense_claim.cancel',
        entityType: 'finance_expense_claim',
        entityId: id,
        oldValues: { status: existing.status },
        newValues: { status: 'cancelled' },
        ...meta,
      });
      return updated;
    },

    async listReimbursements(actor: RequestUser): Promise<ExpenseReimbursement[]> {
      requireExpenseView(actor);
      const { data, error } = await supabase
        .from('finance_expense_reimbursements')
        .select('id')
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list reimbursements.', 500);
      return Promise.all((data ?? []).map((row) => loadReimbursement(row.id as string)));
    },

    async getReimbursement(actor: RequestUser, id: string): Promise<ExpenseReimbursement> {
      requireExpenseView(actor);
      return loadReimbursement(id);
    },

    async createReimbursement(
      actor: RequestUser,
      input: {
        employeeId: string;
        paymentDate?: string;
        amount: number;
        bankAccountId: string;
        method?: string;
        reference?: string;
        notes?: string;
        allocations: { claimId: string; amount: number }[];
      },
      meta: RequestMeta,
    ): Promise<ExpenseReimbursement> {
      requireExpenseManage(actor);
      if (!(input.amount > 0)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Reimbursement amount must be greater than zero.', 400);
      }
      if (!input.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account is required.', 400);
      }
      if (!input.allocations?.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At least one allocation is required.', 400);
      }
      const allocSum = round2(input.allocations.reduce((sum, a) => sum + a.amount, 0));
      if (Math.round(allocSum * 100) !== Math.round(input.amount * 100)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocations must sum to the reimbursement amount.', 400);
      }

      for (const alloc of input.allocations) {
        if (!(alloc.amount > 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation amount must be greater than zero.', 400);
        }
        const claim = await loadClaim(alloc.claimId);
        if (claim.employeeId !== input.employeeId) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation claim belongs to another employee.', 400);
        }
        if (claim.status !== 'approved') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only approved claims can be reimbursed.', 400);
        }
        if (alloc.amount > claim.amountDue + 0.0001) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Allocation exceeds claim amount due.', 400);
        }
      }

      const documentNumber = await allocateDocumentNumber(supabase, 'reimbursement');
      const { data, error } = await supabase
        .from('finance_expense_reimbursements')
        .insert({
          document_number: documentNumber,
          employee_id: input.employeeId,
          payment_date: input.paymentDate ?? todayIsoDate(),
          amount: input.amount,
          bank_account_id: input.bankAccountId,
          method: input.method?.trim() || 'bank_transfer',
          reference: input.reference?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
          status: 'draft',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create reimbursement.', 500);
      }

      const { error: allocErr } = await supabase.from('finance_expense_reimbursement_allocations').insert(
        input.allocations.map((a) => ({
          reimbursement_id: data.id,
          claim_id: a.claimId,
          amount: a.amount,
        })),
      );
      if (allocErr) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, allocErr.message, 500);

      const created = await loadReimbursement(data.id as string);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.reimbursement.create',
        entityType: 'finance_expense_reimbursement',
        entityId: created.id,
        newValues: { documentNumber: created.documentNumber, amount: created.amount, employeeId: created.employeeId },
        ...meta,
      });
      return created;
    },

    async postReimbursement(actor: RequestUser, id: string, meta: RequestMeta): Promise<ExpenseReimbursement> {
      requireExpenseManage(actor);
      const reimbursement = await loadReimbursement(id);
      if (reimbursement.status !== 'draft') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only draft reimbursements can be posted.', 400);
      }
      if (!reimbursement.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Bank account is required to post a reimbursement.', 400);
      }

      const journalId = await postExpenseReimbursementJournal(supabase, {
        reimbursementId: reimbursement.id,
        reimbursementNumber: reimbursement.documentNumber,
        paymentDate: reimbursement.paymentDate,
        createdBy: actor.employeeId,
        amount: reimbursement.amount,
        bankAccountId: reimbursement.bankAccountId,
      });

      for (const alloc of reimbursement.allocations) {
        const claim = await loadClaim(alloc.claimId);
        const amountReimbursed = round2(claim.amountReimbursed + alloc.amount);
        const status =
          amountReimbursed + 0.0001 >= claim.grandTotal ? 'reimbursed' : claim.status;
        const { error } = await supabase
          .from('finance_expense_claims')
          .update({ amount_reimbursed: amountReimbursed, status })
          .eq('id', claim.id);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);
      }

      const { error } = await supabase
        .from('finance_expense_reimbursements')
        .update({ status: 'posted', journal_id: journalId })
        .eq('id', id);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message, 500);

      const posted = await loadReimbursement(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'finance.reimbursement.post',
        entityType: 'finance_expense_reimbursement',
        entityId: id,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', journalId },
        ...meta,
      });
      return posted;
    },
  };
}
