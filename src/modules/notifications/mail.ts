import { loadEnv } from '../../config/env';
import { PORTAL_BRAND, renderPortalEmail, type PortalMailContent } from './email-layout';
import { portalPublicUrl } from '../../shared/portal-public-url';

type MailInput = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ name: string; content: string }>;
};

export type PortalMailInput = PortalMailContent & {
  to: string[];
  subject: string;
};

function uniqueEmails(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((item): item is string => Boolean(item && item.includes('@'))))];
}

export function portalUrl(path = '/login'): string {
  return portalPublicUrl(path);
}

export function portalLoginUrl(): string {
  return portalUrl('/login');
}

/**
 * `disabled` / `no_recipient` mean nothing was attempted, so callers must not treat them as
 * delivery failures worth retrying. `failed` means Brevo rejected the message.
 */
export type MailOutcome = 'sent' | 'disabled' | 'no_recipient' | 'failed';

export type MailResult = { sent: boolean; outcome: MailOutcome };

/** False means every send returns `disabled` — the usual reason nothing arrives in production. */
export function isMailConfigured(env = loadEnv()): boolean {
  return Boolean(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL);
}

export async function sendMail(input: MailInput): Promise<MailResult> {
  const env = loadEnv();
  const recipients = uniqueEmails(input.to);
  if (recipients.length === 0) {
    return { sent: false, outcome: 'no_recipient' };
  }
  if (env.NODE_ENV === 'test' || !isMailConfigured(env)) {
    return { sent: false, outcome: 'disabled' };
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || PORTAL_BRAND },
      // When per-contact pixel consent is enabled on the Brevo account, false keeps
      // open/click events anonymous. It does not remove href rewriting by itself —
      // portal emails therefore avoid <a href> (see email-layout.ts).
      to: recipients.map((email) => ({ email, contactPixelTrackingConsent: false })),
      subject: input.subject,
      textContent: input.text,
      htmlContent: input.html,
      ...(input.attachments && input.attachments.length > 0
        ? {
            attachment: input.attachments.map((file) => ({
              name: file.name,
              content: file.content,
            })),
          }
        : {}),
    }),
  });

  if (!response.ok) {
    console.error('Brevo mail failed', response.status, await response.text());
    if (input.attachments && input.attachments.length > 0) {
      throw new Error('Failed to send email with attachment.');
    }
    return { sent: false, outcome: 'failed' };
  }
  return { sent: true, outcome: 'sent' };
}

export async function sendPortalMail(input: PortalMailInput): Promise<MailResult> {
  const { html, text } = renderPortalEmail(input);
  return sendMail({
    to: input.to,
    subject: input.subject,
    text,
    html,
  });
}
