const BG = '#fafafa';
const WHITE = '#ffffff';
const INK = '#111111';
const MUTED = '#737373';
const BORDER = '#d4d4d4';

export type PortalMailContent = {
  eyebrow?: string;
  title: string;
  greeting?: string;
  paragraphs: string[];
  details?: { label: string; value: string }[];
  cta?: { label: string; href: string };
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphsToText(content: PortalMailContent): string {
  const lines: string[] = [];
  if (content.greeting) lines.push(content.greeting, '');
  for (const paragraph of content.paragraphs) {
    lines.push(paragraph, '');
  }
  if (content.details?.length) {
    for (const row of content.details) {
      lines.push(`${row.label}: ${row.value}`);
    }
    lines.push('');
  }
  if (content.cta) {
    lines.push(content.cta.label, content.cta.href);
  }
  return lines.join('\n').trim();
}

function detailRows(details: { label: string; value: string }[]): string {
  return details
    .map(
      (row) => `
        <tr>
          <td style="padding:8px 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};width:140px;vertical-align:top;">${escapeHtml(row.label)}</td>
          <td style="padding:8px 0;font-size:15px;color:${INK};font-weight:600;">${escapeHtml(row.value)}</td>
        </tr>`,
    )
    .join('');
}

export function renderPortalEmail(content: PortalMailContent): { html: string; text: string } {
  const eyebrow = escapeHtml((content.eyebrow ?? 'HR PORTAL').toUpperCase());
  const title = escapeHtml(content.title);
  const greeting = content.greeting ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK};">${escapeHtml(content.greeting)}</p>` : '';
  const body = content.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(paragraph)}</p>`,
    )
    .join('');
  const details = content.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;background:${BG};border:1px solid ${BORDER};">
        <tr><td style="padding:16px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows(content.details)}</table>
        </td></tr>
      </table>`
    : '';
  const cta = content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
        <tr>
          <td style="background:${INK};">
            <a href="${escapeHtml(content.cta.href)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;letter-spacing:0.04em;color:${WHITE};text-decoration:none;">${escapeHtml(content.cta.label)}</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${MUTED};">Or paste this link into your browser:<br />
        <a href="${escapeHtml(content.cta.href)}" style="color:${INK};word-break:break-all;">${escapeHtml(content.cta.href)}</a>
      </p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BG};color:${INK};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.paragraphs[0] ?? content.title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:${WHITE};border:1px solid ${BORDER};box-shadow:0 1px 2px rgba(0,0,0,0.04);">
          <tr>
            <td style="background:${INK};padding:20px 32px;">
              <p style="margin:0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${WHITE};">HR PORTAL</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};">${eyebrow}</p>
              <h1 style="margin:0 0 24px;font-size:24px;line-height:1.2;font-weight:700;color:${INK};">${title}</h1>
              ${greeting}
              ${body}
              ${details}
              ${cta}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid ${BORDER};">
              <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">This message was sent by HR Portal. Do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text: paragraphsToText(content) };
}
