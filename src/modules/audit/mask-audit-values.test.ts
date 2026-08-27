import { describe, expect, it } from 'vitest';
import { maskAuditValues } from './mask-audit-values';

describe('maskAuditValues', () => {
  it('masks PAN and bank fields in nested audit payloads', () => {
    expect(
      maskAuditValues({
        pan: 'ABCDE1234F',
        bank_account_number: '123456789012',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC',
        companyId: 'co-1',
      }),
    ).toEqual({
      pan: '••••234F',
      bank_account_number: '••••9012',
      ifsc: '••••1234',
      bankName: '••••',
      companyId: 'co-1',
    });
  });
});
