export type ExpenseCategory = {
  id: string;
  name: string;
  expenseAccountId: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
};

export type DirectExpense = {
  id: string;
  documentNumber: string;
  expenseDate: string;
  categoryId: string | null;
  categoryName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  expenseAccountId: string;
  description: string;
  amount: number;
  taxPercent: number;
  taxAmount: number;
  grandTotal: number;
  paidThrough: 'cash' | 'bank' | 'accounts_payable';
  bankAccountId: string | null;
  vendorInvoiceNumber: string;
  receiptUrl: string;
  notes: string;
  status: 'draft' | 'posted' | 'void';
  journalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseClaim = {
  id: string;
  documentNumber: string;
  employeeId: string;
  employeeName: string | null;
  departmentId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  expenseAccountId: string | null;
  claimDate: string;
  description: string;
  amount: number;
  taxPercent: number;
  taxAmount: number;
  grandTotal: number;
  vendorName: string;
  billNumber: string;
  receiptUrl: string;
  notes: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'reimbursed' | 'cancelled';
  reviewerId: string | null;
  reviewerComment: string | null;
  decidedAt: string | null;
  amountReimbursed: number;
  amountDue: number;
  journalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReimbursementAllocation = {
  id: string;
  claimId: string;
  claimNumber: string | null;
  amount: number;
};

export type ExpenseReimbursement = {
  id: string;
  documentNumber: string;
  employeeId: string;
  employeeName: string | null;
  paymentDate: string;
  amount: number;
  bankAccountId: string | null;
  method: string;
  reference: string;
  notes: string;
  status: 'draft' | 'posted' | 'void';
  journalId: string | null;
  allocations: ReimbursementAllocation[];
  createdAt: string;
};
