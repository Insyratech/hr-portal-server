export const HR_INVOICE_CURRENCIES = ['INR', 'GBP', 'USD', 'EUR'] as const;

export type HrInvoiceCurrency = (typeof HR_INVOICE_CURRENCIES)[number];

export function isHrInvoiceCurrency(value: string): value is HrInvoiceCurrency {
  return (HR_INVOICE_CURRENCIES as readonly string[]).includes(value);
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function lineAmount(quantity: number, unitPrice: number): number {
  return roundMoney(quantity * unitPrice);
}

export function invoiceTotal(lines: { quantity: number; unitPrice: number }[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + lineAmount(line.quantity, line.unitPrice), 0));
}
