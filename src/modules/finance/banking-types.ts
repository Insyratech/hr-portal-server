export type BankAccount = {
  id: string;
  glAccountId: string;
  glAccountCode: string | null;
  glAccountName: string | null;
  displayName: string;
  accountKind: 'bank' | 'cash';
  bankName: string;
  accountNumberMasked: string;
  currencyCode: string;
  isActive: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type BankTransaction = {
  id: string;
  documentNumber: string;
  bankAccountId: string;
  bankAccountName: string | null;
  transactionDate: string;
  description: string;
  reference: string;
  transactionType: 'credit' | 'debit';
  amount: number;
  source: 'manual' | 'import';
  importBatchId: string | null;
  status: 'unmatched' | 'matched' | 'categorized' | 'excluded';
  matchType: 'customer_payment' | 'vendor_payment' | 'expense' | 'expense_reimbursement' | 'transfer' | null;
  matchId: string | null;
  matchLabel: string | null;
  categoryAccountId: string | null;
  categoryAccountName: string | null;
  journalId: string | null;
  transferBankAccountId: string | null;
  notes: string;
  createdAt: string;
};

export type BankImportBatch = {
  id: string;
  bankAccountId: string;
  filename: string;
  importedAt: string;
  importedBy: string | null;
  rowCount: number;
  notes: string;
};

export type BankMatchCandidate = {
  id: string;
  type: 'customer_payment' | 'vendor_payment' | 'expense' | 'expense_reimbursement';
  documentNumber: string;
  date: string;
  amount: number;
  partyName: string | null;
  label: string;
};

export type BankReconciliationReport = {
  bankAccountId: string;
  bankAccountName: string;
  asOfDate: string;
  statementEndingBalance: number;
  bookEndingBalance: number;
  difference: number;
  matchedCount: number;
  unmatchedCount: number;
  unmatchedAmount: number;
  categorizedCount: number;
  excludedCount: number;
  unmatchedTransactions: BankTransaction[];
};

export type BankReconciliation = {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  statementDate: string;
  statementEndingBalance: number;
  bookEndingBalance: number;
  difference: number;
  unmatchedCount: number;
  unmatchedAmount: number;
  matchedCount: number;
  status: 'draft' | 'completed';
  notes: string;
  completedAt: string | null;
  createdAt: string;
};
