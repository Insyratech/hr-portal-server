import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../../config/env';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { isValidEmail, normalizeEmail } from '../../shared/email';
import { AppError } from '../../shared/errors/app-error';
import { hitRateLimit, type RateWindow } from '../../shared/rate-limit';
import { portalUrl, sendPortalMail } from '../notifications/mail';

/** Up to 5 reset emails per address every 3 hours. */
export const PASSWORD_RESET_EMAIL_WINDOW_MS = 3 * 60 * 60 * 1000;
export const PASSWORD_RESET_EMAIL_MAX = 5;

/** Broader guard per client IP every hour. */
export const PASSWORD_RESET_IP_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_IP_MAX = 15;

const PASSWORD_RESET_LIMIT_MESSAGE =
  'You can request up to 5 password reset emails every 3 hours. Please wait before trying again.';

const emailHits = new Map<string, RateWindow>();
const ipHits = new Map<string, RateWindow>();

export function resolvePasswordResetRedirect(input?: string): string {
  const env = loadEnv();
  const fallback = portalUrl('/reset-password');
  const candidate = input?.trim();
  if (!candidate) return fallback;

  const allowedOrigins = new Set(
    [env.CORS_ORIGIN, 'http://localhost:3000', 'https://hr-portal-client-nine.vercel.app']
      .filter(Boolean)
      .map((origin) => origin.replace(/\/$/, '')),
  );

  try {
    const url = new URL(candidate);
    const origin = url.origin.replace(/\/$/, '');
    if (!allowedOrigins.has(origin)) return fallback;
    if (!url.pathname.startsWith('/reset-password')) return `${origin}/reset-password`;
    return url.toString();
  } catch {
    return fallback;
  }
}

export function createPasswordResetService(supabase: SupabaseClient) {
  return {
    async requestReset(input: { email: string; redirectTo?: string; ipAddress?: string | null }) {
      const email = normalizeEmail(input.email);
      if (!isValidEmail(email)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Enter a valid email address.', 400);
      }

      const ipKey = input.ipAddress?.trim() || 'unknown';
      hitRateLimit(
        ipHits,
        ipKey,
        Date.now(),
        PASSWORD_RESET_IP_WINDOW_MS,
        PASSWORD_RESET_IP_MAX,
        PASSWORD_RESET_LIMIT_MESSAGE,
      );
      hitRateLimit(
        emailHits,
        email,
        Date.now(),
        PASSWORD_RESET_EMAIL_WINDOW_MS,
        PASSWORD_RESET_EMAIL_MAX,
        PASSWORD_RESET_LIMIT_MESSAGE,
      );

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, email, user_id, deleted_at')
        .eq('email', email)
        .maybeSingle();
      if (employeeError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Could not process this reset request.', 500);
      }

      if (!employee?.user_id || employee.deleted_at) {
        return { sent: true as const };
      }

      const redirectTo = resolvePasswordResetRedirect(input.redirectTo);
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo },
      });
      if (linkError || !linkData?.properties?.action_link) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Could not create a reset link.', 500);
      }

      const fullName = (employee.full_name as string) || 'there';
      await sendPortalMail({
        to: [email],
        subject: 'Reset your HR Portal password',
        eyebrow: 'Account',
        title: 'Reset your password',
        greeting: `Hi ${fullName},`,
        paragraphs: [
          'We received a request to reset your HR Portal password. Use the button below to choose a new one.',
          'If you did not ask for this, you can ignore this email. Your password will stay the same.',
        ],
        cta: { label: 'Reset password', href: linkData.properties.action_link },
      });

      return { sent: true as const };
    },
  };
}

/** @internal test helper */
export function resetPasswordResetRateLimits(): void {
  emailHits.clear();
  ipHits.clear();
}
