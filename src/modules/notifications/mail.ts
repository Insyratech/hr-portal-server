import { loadEnv } from '../../config/env';
import { renderPortalEmail, type PortalMailContent } from './email-layout';

type MailInput = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
};

export type PortalMailInput = PortalMailContent & {
  to: string[];
  subject: string;
};

function uniqueEmails(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((item): item is string => Boolean(item && item.includes('@'))))];
}

export function portalUrl(path = '/login'): string {
  const origin = loadEnv().CORS_ORIGIN.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`;
}

export function portalLoginUrl(): string {
  return portalUrl('/login');
}

export async function sendMail(input: MailInput): Promise<void> {
  const env = loadEnv();
  const recipients = uniqueEmails(input.to);
  if (env.NODE_ENV === 'test' || !env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL || recipients.length === 0) {
    return;
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'HR Portal' },
      to: recipients.map((email) => ({ email })),
      subject: input.subject,
      textContent: input.text,
      htmlContent: input.html,
    }),
  });

  if (!response.ok) {
    console.error('Brevo mail failed', response.status, await response.text());
  }
}

export async function sendPortalMail(input: PortalMailInput): Promise<void> {
  const { html, text } = renderPortalEmail(input);
  await sendMail({
    to: input.to,
    subject: input.subject,
    text,
    html,
  });
}
