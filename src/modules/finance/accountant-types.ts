export type JournalLine = {
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  description: string;
  debit: number;
  credit: number;
  lineOrder: number;
};

export type JournalEntry = {
  id: string;
  entryNumber: string;
  entryDate: string;
  memo: string;
  sourceType: string;
  sourceId: string | null;
  status: 'draft' | 'posted' | 'reversed';
  reversesJournalId: string | null;
  reversedByJournalId: string | null;
  lines: JournalLine[];
  createdAt: string;
  updatedAt: string;
};

export type LedgerLine = {
  journalId: string;
  entryNumber: string;
  entryDate: string;
  memo: string;
  sourceType: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
};

export type GeneralLedger = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: number;
  lines: LedgerLine[];
  closingBalance: number;
};

export type TrialBalanceRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
};

export type TrialBalance = {
  asOfDate: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
};

export type PeriodLock = {
  id: string;
  periodYear: number;
  periodMonth: number;
  lockedAt: string;
  lockedBy: string | null;
  lockedByName: string | null;
  notes: string;
};

export type OpeningBalanceLine = {
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  debit: number;
  credit: number;
};

export type OpeningBalanceSet = {
  id: string;
  asOfDate: string;
  memo: string;
  status: 'draft' | 'posted' | 'void';
  journalId: string | null;
  lines: OpeningBalanceLine[];
  totalDebit: number;
  totalCredit: number;
  createdAt: string;
};
