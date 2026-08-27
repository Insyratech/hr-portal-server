import { describe, expect, it } from 'vitest';
import { maskPayment, maskSecret } from './payment-mask';

describe('payment mask', () => {
  it('hides all but the last four characters', () => {
    expect(maskSecret('ABCDE1234F')).toBe('••••234F');
    expect(maskSecret('1234')).toBe('••••');
    expect(maskSecret('')).toBe(null);
  });

  it('masks PAN, account, bank name, and IFSC for audit', () => {
    expect(
      maskPayment({
        pan: 'ABCDE1234F',
        bankAccountNumber: '123456789012',
        bankName: 'HDFC Bank',
        ifsc: 'HDFC0001234',
      }),
    ).toEqual({
      pan: '••••234F',
      bankAccountNumber: '••••9012',
      bankName: '••••',
      ifsc: '••••1234',
    });
  });
});
