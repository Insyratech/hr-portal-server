import { describe, expect, it } from 'vitest';
import { invoiceTotal, isHrInvoiceCurrency, lineAmount } from './money';

describe('hr invoice money', () => {
  it('rounds a line to paise', () => {
    expect(lineAmount(1, 400)).toBe(400);
    expect(lineAmount(1.5, 10.1)).toBe(15.15);
  });

  it('sums lines once', () => {
    expect(
      invoiceTotal([
        { quantity: 1, unitPrice: 400 },
        { quantity: 1, unitPrice: 200 },
      ]),
    ).toBe(600);
  });

  it('accepts only the four currencies', () => {
    expect(isHrInvoiceCurrency('INR')).toBe(true);
    expect(isHrInvoiceCurrency('GBP')).toBe(true);
    expect(isHrInvoiceCurrency('JPY')).toBe(false);
  });
});
