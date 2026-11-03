import type { HrInvoiceDetail } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

function formatQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(currency: string, value: number): string {
  const amount = value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${amount}`;
}

export type HrInvoiceMail = {
  subject: string;
  text: string;
  html: string;
};

/** Email body is the invoice. No links, so Brevo cannot rewrite them. */
export function buildHrInvoiceMail(invoice: HrInvoiceDetail): HrInvoiceMail {
  const money = (value: number) => formatMoney(invoice.currency, value);
  const subject = `Invoice ${invoice.invoiceNumber} from ${invoice.companyName}`;
  const address = invoice.issuerAddress.replace(/\s*\n\s*/g, ', ');
  const linesText = invoice.lines
    .map((line) => {
      const detail = line.detail ? ` (${line.detail})` : '';
      return `${line.description}${detail} — ${formatQty(line.quantity)} × ${money(line.unitPrice)} = ${money(line.amount)}`;
    })
    .join('\n');

  const text = [
    `INVOICE ${invoice.invoiceNumber}`,
    invoice.companyName,
    address,
    '',
    `Bill to: ${invoice.clientName}`,
    invoice.clientAddress,
    '',
    `Issue date: ${formatDate(invoice.issueDate)}`,
    `Due date: ${formatDate(invoice.dueDate)}`,
    `Reference: ${invoice.reference || '—'}`,
    '',
    linesText,
    '',
    `Total due: ${money(invoice.total)}`,
    '',
    `Issued by: ${invoice.signatureName}`,
    invoice.issuerEmail ? `Email: ${invoice.issuerEmail}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const lineRows = invoice.lines
    .map(
      (line) => `<tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111;">
          <div style="font-weight:600;">${escapeHtml(line.description)}</div>
          ${line.detail ? `<div style="color:#6b7280;margin-top:2px;">${escapeHtml(line.detail)}</div>` : ''}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:14px;">${escapeHtml(formatQty(line.quantity))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:14px;">${escapeHtml(money(line.unitPrice))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:14px;">${escapeHtml(money(line.amount))}</td>
      </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;padding:28px 24px;">
          <tr>
            <td>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;letter-spacing:0.04em;color:#111;">INVOICE</p>
              <p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#111;">${escapeHtml(invoice.companyName)}</p>
              ${address ? `<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#4b5563;">${escapeHtml(address)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;">
              <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.04em;color:#111;">BILL TO</p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#111;">${escapeHtml(invoice.clientName)}</p>
              ${invoice.clientAddress ? `<p style="margin:4px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;white-space:pre-line;">${escapeHtml(invoice.clientAddress)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;">
              <p style="margin:0 0 4px;">Invoice No.: <strong>${escapeHtml(invoice.invoiceNumber)}</strong></p>
              <p style="margin:0 0 4px;">Issue date: <strong>${escapeHtml(formatDate(invoice.issueDate))}</strong></p>
              <p style="margin:0 0 4px;">Due date: <strong>${escapeHtml(formatDate(invoice.dueDate))}</strong></p>
              <p style="margin:0;">Reference: <strong>${escapeHtml(invoice.reference || '—')}</strong></p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <th align="left" style="padding:8px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:11px;">DESCRIPTION</th>
                  <th align="center" style="padding:8px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:11px;">QTY</th>
                  <th align="right" style="padding:8px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:11px;">UNIT PRICE</th>
                  <th align="right" style="padding:8px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:11px;">AMOUNT</th>
                </tr>
                ${lineRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:12px;">
              <table role="presentation" align="right" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;">TOTAL (${escapeHtml(invoice.currency)})</td>
                  <td style="padding:8px 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;text-align:right;">${escapeHtml(money(invoice.total))}</td>
                </tr>
                <tr>
                  <td style="padding:10px 12px;background:#111;color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">TOTAL DUE (${escapeHtml(invoice.currency)})</td>
                  <td style="padding:10px 12px;background:#111;color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(money(invoice.total))}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;">
              Issued by: ${escapeHtml(invoice.signatureName)}
              ${invoice.issuerEmail ? `<br/>Email: ${escapeHtml(invoice.issuerEmail)}` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
