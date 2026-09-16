import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { assertPeriodUnlocked } from './period-lock';
import { allocateDocumentNumber } from './series-allocate';

export type JournalLineInput = {
  accountId: string;
  description: string;
  debit: number;
  credit: number;
};

async function accountIdByRole(supabase: SupabaseClient, systemRole: string): Promise<string> {
  const { data, error } = await supabase
    .from('finance_accounts')
    .select('id')
    .eq('system_role', systemRole)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `System account missing: ${systemRole}.`, 500);
  }
  return data.id as string;
}

/**
 * Single accounting posting engine for Phases 1–4.
 * Every Bill / Invoice / Payment / Expense / Manual journal posts through here.
 */
export async function postBalancedJournal(
  supabase: SupabaseClient,
  input: {
    entryDate: string;
    memo: string;
    sourceType: string;
    sourceId: string | null;
    createdBy: string | null;
    lines: JournalLineInput[];
    reversesJournalId?: string | null;
    entryNumber?: string;
  },
): Promise<string> {
  await assertPeriodUnlocked(supabase, input.entryDate);
  const debit = input.lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = input.lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Journal is out of balance.', 400);
  }
  if (input.lines.length < 2) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Journal needs at least two lines.', 400);
  }
  for (const line of input.lines) {
    if (line.debit > 0 && line.credit > 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'A journal line cannot have both debit and credit.', 400);
    }
    if (line.debit <= 0 && line.credit <= 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each journal line needs a debit or credit.', 400);
    }
  }
  const entryNumber = input.entryNumber ?? (await allocateDocumentNumber(supabase, 'journal'));
  const { data: entry, error } = await supabase
    .from('finance_journal_entries')
    .insert({
      entry_number: entryNumber,
      entry_date: input.entryDate,
      memo: input.memo,
      source_type: input.sourceType,
      source_id: input.sourceId,
      status: 'posted',
      created_by: input.createdBy,
      reverses_journal_id: input.reversesJournalId ?? null,
    })
    .select('id')
    .single();
  if (error || !entry) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create journal.', 500);
  }
  const { error: lineErr } = await supabase.from('finance_journal_lines').insert(
    input.lines.map((line, index) => ({
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
  return entry.id as string;
}

export async function postVendorBillJournal(
  supabase: SupabaseClient,
  input: {
    billId: string;
    billNumber: string;
    billDate: string;
    createdBy: string | null;
    expenseAccountId: string;
    subtotal: number;
    taxTotal: number;
    grandTotal: number;
    placeOfSupplyIntraState: boolean;
    /** TDS withheld on taxable value; reduces AP credit. */
    tdsAmount?: number;
  },
): Promise<string> {
  const ap = await accountIdByRole(supabase, 'accounts_payable');
  const tdsAmount = Math.round((input.tdsAmount ?? 0) * 100) / 100;
  if (tdsAmount < 0 || tdsAmount > input.grandTotal) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid TDS amount on bill.', 400);
  }
  const apCredit = Math.round((input.grandTotal - tdsAmount) * 100) / 100;
  const lines: JournalLineInput[] = [
    {
      accountId: input.expenseAccountId,
      description: `Bill ${input.billNumber}`,
      debit: input.subtotal,
      credit: 0,
    },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'input_cgst');
      const sgst = await accountIdByRole(supabase, 'input_sgst');
      lines.push({ accountId: cgst, description: 'Input CGST', debit: half, credit: 0 });
      lines.push({ accountId: sgst, description: 'Input SGST', debit: input.taxTotal - half, credit: 0 });
    } else {
      const igst = await accountIdByRole(supabase, 'input_igst');
      lines.push({ accountId: igst, description: 'Input IGST', debit: input.taxTotal, credit: 0 });
    }
  }
  if (tdsAmount > 0) {
    const tdsPayable = await accountIdByRole(supabase, 'tds_payable');
    lines.push({
      accountId: tdsPayable,
      description: `TDS ${input.billNumber}`,
      debit: 0,
      credit: tdsAmount,
    });
  }
  lines.push({
    accountId: ap,
    description: `AP ${input.billNumber}`,
    debit: 0,
    credit: apCredit,
  });
  return postBalancedJournal(supabase, {
    entryDate: input.billDate,
    memo: `Vendor bill ${input.billNumber}`,
    sourceType: 'vendor_bill',
    sourceId: input.billId,
    createdBy: input.createdBy,
    lines,
  });
}

export async function postVendorPaymentJournal(
  supabase: SupabaseClient,
  input: {
    paymentId: string;
    paymentNumber: string;
    paymentDate: string;
    createdBy: string | null;
    amount: number;
    bankAccountId: string;
  },
): Promise<string> {
  const ap = await accountIdByRole(supabase, 'accounts_payable');
  return postBalancedJournal(supabase, {
    entryDate: input.paymentDate,
    memo: `Vendor payment ${input.paymentNumber}`,
    sourceType: 'vendor_payment',
    sourceId: input.paymentId,
    createdBy: input.createdBy,
    lines: [
      { accountId: ap, description: 'Clear AP', debit: input.amount, credit: 0 },
      { accountId: input.bankAccountId, description: 'Bank payment', debit: 0, credit: input.amount },
    ],
  });
}

export async function postVendorCreditJournal(
  supabase: SupabaseClient,
  input: {
    creditId: string;
    creditNumber: string;
    creditDate: string;
    createdBy: string | null;
    expenseAccountId: string;
    subtotal: number;
    taxTotal: number;
    grandTotal: number;
    placeOfSupplyIntraState: boolean;
  },
): Promise<string> {
  const ap = await accountIdByRole(supabase, 'accounts_payable');
  const lines: JournalLineInput[] = [
    { accountId: ap, description: `Vendor credit ${input.creditNumber}`, debit: input.grandTotal, credit: 0 },
    { accountId: input.expenseAccountId, description: 'Credit expense', debit: 0, credit: input.subtotal },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'input_cgst');
      const sgst = await accountIdByRole(supabase, 'input_sgst');
      lines.push({ accountId: cgst, description: 'Reverse Input CGST', debit: 0, credit: half });
      lines.push({ accountId: sgst, description: 'Reverse Input SGST', debit: 0, credit: input.taxTotal - half });
    } else {
      const igst = await accountIdByRole(supabase, 'input_igst');
      lines.push({ accountId: igst, description: 'Reverse Input IGST', debit: 0, credit: input.taxTotal });
    }
  }
  return postBalancedJournal(supabase, {
    entryDate: input.creditDate,
    memo: `Vendor credit ${input.creditNumber}`,
    sourceType: 'vendor_credit',
    sourceId: input.creditId,
    createdBy: input.createdBy,
    lines,
  });
}

export async function postCustomerInvoiceJournal(
  supabase: SupabaseClient,
  input: {
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    createdBy: string | null;
    incomeAccountId: string;
    subtotal: number;
    taxTotal: number;
    grandTotal: number;
    placeOfSupplyIntraState: boolean;
  },
): Promise<string> {
  const ar = await accountIdByRole(supabase, 'accounts_receivable');
  const lines: JournalLineInput[] = [
    {
      accountId: ar,
      description: `AR ${input.invoiceNumber}`,
      debit: input.grandTotal,
      credit: 0,
    },
    {
      accountId: input.incomeAccountId,
      description: `Sales ${input.invoiceNumber}`,
      debit: 0,
      credit: input.subtotal,
    },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'output_cgst');
      const sgst = await accountIdByRole(supabase, 'output_sgst');
      lines.push({ accountId: cgst, description: 'Output CGST', debit: 0, credit: half });
      lines.push({ accountId: sgst, description: 'Output SGST', debit: 0, credit: input.taxTotal - half });
    } else {
      const igst = await accountIdByRole(supabase, 'output_igst');
      lines.push({ accountId: igst, description: 'Output IGST', debit: 0, credit: input.taxTotal });
    }
  }
  return postBalancedJournal(supabase, {
    entryDate: input.invoiceDate,
    memo: `Customer invoice ${input.invoiceNumber}`,
    sourceType: 'customer_invoice',
    sourceId: input.invoiceId,
    createdBy: input.createdBy,
    lines,
  });
}

export async function postCustomerPaymentJournal(
  supabase: SupabaseClient,
  input: {
    paymentId: string;
    paymentNumber: string;
    paymentDate: string;
    createdBy: string | null;
    amount: number;
    bankAccountId: string;
  },
): Promise<string> {
  const ar = await accountIdByRole(supabase, 'accounts_receivable');
  return postBalancedJournal(supabase, {
    entryDate: input.paymentDate,
    memo: `Customer payment ${input.paymentNumber}`,
    sourceType: 'customer_payment',
    sourceId: input.paymentId,
    createdBy: input.createdBy,
    lines: [
      { accountId: input.bankAccountId, description: 'Bank receipt', debit: input.amount, credit: 0 },
      { accountId: ar, description: 'Clear AR', debit: 0, credit: input.amount },
    ],
  });
}

export async function postCustomerCreditNoteJournal(
  supabase: SupabaseClient,
  input: {
    creditId: string;
    creditNumber: string;
    creditDate: string;
    createdBy: string | null;
    incomeAccountId: string;
    subtotal: number;
    taxTotal: number;
    grandTotal: number;
    placeOfSupplyIntraState: boolean;
  },
): Promise<string> {
  const ar = await accountIdByRole(supabase, 'accounts_receivable');
  const lines: JournalLineInput[] = [
    { accountId: input.incomeAccountId, description: 'Reverse sales', debit: input.subtotal, credit: 0 },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'output_cgst');
      const sgst = await accountIdByRole(supabase, 'output_sgst');
      lines.push({ accountId: cgst, description: 'Reverse Output CGST', debit: half, credit: 0 });
      lines.push({ accountId: sgst, description: 'Reverse Output SGST', debit: input.taxTotal - half, credit: 0 });
    } else {
      const igst = await accountIdByRole(supabase, 'output_igst');
      lines.push({ accountId: igst, description: 'Reverse Output IGST', debit: input.taxTotal, credit: 0 });
    }
  }
  lines.push({
    accountId: ar,
    description: `Credit note ${input.creditNumber}`,
    debit: 0,
    credit: input.grandTotal,
  });
  return postBalancedJournal(supabase, {
    entryDate: input.creditDate,
    memo: `Customer credit note ${input.creditNumber}`,
    sourceType: 'customer_credit_note',
    sourceId: input.creditId,
    createdBy: input.createdBy,
    lines,
  });
}

/** Direct expense: Dr Expense (+ Input GST) · Cr Bank/Cash or AP. */
export async function postDirectExpenseJournal(
  supabase: SupabaseClient,
  input: {
    expenseId: string;
    expenseNumber: string;
    expenseDate: string;
    createdBy: string | null;
    expenseAccountId: string;
    amount: number;
    taxTotal: number;
    grandTotal: number;
    paidThrough: 'cash' | 'bank' | 'accounts_payable';
    creditAccountId: string;
    placeOfSupplyIntraState: boolean;
  },
): Promise<string> {
  const lines: JournalLineInput[] = [
    {
      accountId: input.expenseAccountId,
      description: `Expense ${input.expenseNumber}`,
      debit: input.amount,
      credit: 0,
    },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'input_cgst');
      const sgst = await accountIdByRole(supabase, 'input_sgst');
      lines.push({ accountId: cgst, description: 'Input CGST', debit: half, credit: 0 });
      lines.push({ accountId: sgst, description: 'Input SGST', debit: input.taxTotal - half, credit: 0 });
    } else {
      const igst = await accountIdByRole(supabase, 'input_igst');
      lines.push({ accountId: igst, description: 'Input IGST', debit: input.taxTotal, credit: 0 });
    }
  }
  lines.push({
    accountId: input.creditAccountId,
    description:
      input.paidThrough === 'accounts_payable'
        ? `AP ${input.expenseNumber}`
        : `Paid ${input.paidThrough} ${input.expenseNumber}`,
    debit: 0,
    credit: input.grandTotal,
  });
  return postBalancedJournal(supabase, {
    entryDate: input.expenseDate,
    memo: `Expense ${input.expenseNumber}`,
    sourceType: 'direct_expense',
    sourceId: input.expenseId,
    createdBy: input.createdBy,
    lines,
  });
}

/** Approved claim: Dr Expense (+ Input GST optional) · Cr Employee Payable. */
export async function postExpenseClaimJournal(
  supabase: SupabaseClient,
  input: {
    claimId: string;
    claimNumber: string;
    claimDate: string;
    createdBy: string | null;
    expenseAccountId: string;
    amount: number;
    taxTotal: number;
    grandTotal: number;
    placeOfSupplyIntraState: boolean;
  },
): Promise<string> {
  const payable = await accountIdByRole(supabase, 'employee_payable');
  const lines: JournalLineInput[] = [
    {
      accountId: input.expenseAccountId,
      description: `Claim ${input.claimNumber}`,
      debit: input.amount,
      credit: 0,
    },
  ];
  if (input.taxTotal > 0) {
    if (input.placeOfSupplyIntraState) {
      const half = Math.round((input.taxTotal / 2) * 100) / 100;
      const cgst = await accountIdByRole(supabase, 'input_cgst');
      const sgst = await accountIdByRole(supabase, 'input_sgst');
      lines.push({ accountId: cgst, description: 'Input CGST', debit: half, credit: 0 });
      lines.push({ accountId: sgst, description: 'Input SGST', debit: input.taxTotal - half, credit: 0 });
    } else {
      const igst = await accountIdByRole(supabase, 'input_igst');
      lines.push({ accountId: igst, description: 'Input IGST', debit: input.taxTotal, credit: 0 });
    }
  }
  lines.push({
    accountId: payable,
    description: `Employee payable ${input.claimNumber}`,
    debit: 0,
    credit: input.grandTotal,
  });
  return postBalancedJournal(supabase, {
    entryDate: input.claimDate,
    memo: `Expense claim ${input.claimNumber}`,
    sourceType: 'expense_claim',
    sourceId: input.claimId,
    createdBy: input.createdBy,
    lines,
  });
}

/** Reimbursement: Dr Employee Payable · Cr Bank. */
export async function postExpenseReimbursementJournal(
  supabase: SupabaseClient,
  input: {
    reimbursementId: string;
    reimbursementNumber: string;
    paymentDate: string;
    createdBy: string | null;
    amount: number;
    bankAccountId: string;
  },
): Promise<string> {
  const payable = await accountIdByRole(supabase, 'employee_payable');
  return postBalancedJournal(supabase, {
    entryDate: input.paymentDate,
    memo: `Reimbursement ${input.reimbursementNumber}`,
    sourceType: 'expense_reimbursement',
    sourceId: input.reimbursementId,
    createdBy: input.createdBy,
    lines: [
      { accountId: payable, description: 'Clear employee payable', debit: input.amount, credit: 0 },
      { accountId: input.bankAccountId, description: 'Bank payment', debit: 0, credit: input.amount },
    ],
  });
}
