import { describe, expect, it } from 'vitest';
import { buildHrInvoiceMail } from './email';
import type { HrInvoiceDetail } from './types';

const invoice: HrInvoiceDetail = {
  id: '1',
  invoiceNumber: '000001',
  issueDate: '2026-04-30',
  dueDate: '2026-05-14',
  reference: '042022',
  currency: 'GBP',
  companyName: 'Ellington <Wood>',
  clientName: 'Your client',
  total: 600,
  createdAt: '2026-04-30T00:00:00Z',
  companyId: 'c',
  clientId: 'k',
  issuerAddress: '36 Terrick Rd',
  issuerEmail: 'info@example.com',
  logoUrl: null,
  clientAddress: '11 Beech Dr',
  signatureName: 'Ellington Wood Decor',
  lines: [
    {
      id: 'l1',
      description: 'Sample service',
      detail: 'Sample wood decoration service',
      quantity: 1,
      unitPrice: 400,
      amount: 400,
    },
    {
      id: 'l2',
      description: 'Sample service 1',
      detail: '',
      quantity: 1,
      unitPrice: 200,
      amount: 200,
    },
  ],
};

describe('buildHrInvoiceMail', () => {
  it('puts the invoice number, client, and total in the message', () => {
    const mail = buildHrInvoiceMail(invoice);
    expect(mail.subject).toBe('Invoice 000001 from Ellington <Wood>');
    expect(mail.text).toContain('Bill to: Your client');
    expect(mail.text).toContain('Total due: GBP 600.00');
    expect(mail.text).toContain('30/04/2026');
    expect(mail.html).toContain('TOTAL DUE (GBP)');
    expect(mail.html).toContain('Sample wood decoration service');
  });

  it('escapes company names so the email stays text', () => {
    const mail = buildHrInvoiceMail(invoice);
    expect(mail.html).toContain('Ellington &lt;Wood&gt;');
    expect(mail.html).not.toContain('<Wood>');
    expect(mail.html).not.toContain('<a ');
  });
});
