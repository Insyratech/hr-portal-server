import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { resolveRequestUser } from '../auth/resolve-request-user';
import { writeAuditLog } from '../audit/write-audit-log';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

const CREDENTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MobileAuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
};

function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function secretsMatch(presented: string, storedHash: string): boolean {
  const presentedHash = hashDeviceSecret(presented);
  if (presentedHash.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presentedHash), Buffer.from(storedHash));
}

function assertCredentialFresh(lastCredentialAuthAt: string | null): void {
  if (!lastCredentialAuthAt) {
    throw new AppError(
      API_ERROR_CODES.CREDENTIAL_EXPIRED,
      'Sign in with password again.',
      401,
    );
  }
  const ageMs = Date.now() - new Date(lastCredentialAuthAt).getTime();
  if (ageMs > CREDENTIAL_MAX_AGE_MS) {
    throw new AppError(
      API_ERROR_CODES.CREDENTIAL_EXPIRED,
      'Sign in with password again.',
      401,
    );
  }
}

async function loadEmployeeEmail(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('employees')
    .select('email, status, deleted_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data?.email) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee account not found.', 404);
  }
  if (data.deleted_at || data.status !== 'active') {
    throw new AppError(API_ERROR_CODES.CREDENTIAL_EXPIRED, 'Sign in with password again.', 401);
  }
  return String(data.email);
}

async function mintSupabaseSession(
  supabase: SupabaseClient,
  email: string,
): Promise<MobileAuthSession> {
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  if (error || !data.properties) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create session.', 500);
  }

  const otp = data.properties.email_otp;
  const tokenHash = data.properties.hashed_token;

  const verified = otp
    ? await supabase.auth.verifyOtp({ email, token: otp, type: 'email' })
    : await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });

  if (verified.error || !verified.data.session) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to verify session.', 500);
  }

  return {
    accessToken: verified.data.session.access_token,
    refreshToken: verified.data.session.refresh_token,
    expiresIn: verified.data.session.expires_in ?? 3600,
    userId: verified.data.session.user.id,
  };
}

type DeviceAuthRow = {
  id: string;
  user_id: string;
  device_id: string;
  credential_hash: string | null;
  last_credential_auth_at: string | null;
  biometric_enabled: boolean;
  revoked_at: string | null;
};

export function createMobileAuthService(supabase: SupabaseClient) {
  return {
    async recordCredentialAuth(userId: string, deviceId: string): Promise<void> {
      const now = new Date().toISOString();
      const { data: existing } = await supabase
        .from('mobile_devices')
        .select('platform, push_token')
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .maybeSingle();

      await supabase.from('mobile_devices').upsert(
        {
          user_id: userId,
          device_id: deviceId,
          platform: existing?.platform ?? 'android',
          push_token: existing?.push_token ?? null,
          last_credential_auth_at: now,
          last_seen_at: now,
          updated_at: now,
          revoked_at: null,
        },
        { onConflict: 'user_id,device_id' },
      );
    },

    async enroll(
      userId: string,
      deviceId: string,
      meta: RequestMeta,
    ): Promise<{ deviceRefreshSecret: string }> {
      const email = await loadEmployeeEmail(supabase, userId);
      await resolveRequestUser(supabase, userId, email);

      const deviceRefreshSecret = randomBytes(32).toString('base64url');
      const credentialHash = hashDeviceSecret(deviceRefreshSecret);
      const now = new Date().toISOString();

      const { data: existing } = await supabase
        .from('mobile_devices')
        .select('id, push_token')
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .maybeSingle();

      const { error } = await supabase.from('mobile_devices').upsert(
        {
          user_id: userId,
          device_id: deviceId,
          platform: 'android',
          push_token: existing?.push_token ?? null,
          credential_hash: credentialHash,
          biometric_enabled: true,
          enrolled_at: now,
          last_credential_auth_at: now,
          last_seen_at: now,
          revoked_at: null,
          updated_at: now,
        },
        { onConflict: 'user_id,device_id' },
      );

      if (error) {
        throw error;
      }

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'mobile.device.enroll',
        entityType: 'mobile_device',
        entityId: deviceId,
        newValues: { userId, deviceId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { deviceRefreshSecret };
    },

    async refresh(deviceId: string, deviceRefreshSecret: string, meta: RequestMeta): Promise<MobileAuthSession> {
      const { data, error } = await supabase
        .from('mobile_devices')
        .select('id, user_id, device_id, credential_hash, last_credential_auth_at, biometric_enabled, revoked_at')
        .eq('device_id', deviceId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      const device = data as DeviceAuthRow | null;
      if (!device || device.revoked_at || !device.biometric_enabled || !device.credential_hash) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Biometric login is not available.', 401);
      }

      if (!secretsMatch(deviceRefreshSecret, device.credential_hash)) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Biometric login is not available.', 401);
      }

      assertCredentialFresh(device.last_credential_auth_at);

      const email = await loadEmployeeEmail(supabase, device.user_id);
      await resolveRequestUser(supabase, device.user_id, email);

      const session = await mintSupabaseSession(supabase, email);
      const now = new Date().toISOString();

      await supabase
        .from('mobile_devices')
        .update({
          last_biometric_refresh_at: now,
          last_seen_at: now,
          updated_at: now,
        })
        .eq('id', device.id);

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'mobile.device.refresh',
        entityType: 'mobile_device',
        entityId: deviceId,
        newValues: { userId: device.user_id },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return {
        ...session,
        userId: device.user_id,
      };
    },

    async revokeEnroll(userId: string, deviceId: string, meta: RequestMeta): Promise<{ revoked: boolean }> {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('mobile_devices')
        .update({
          credential_hash: null,
          biometric_enabled: false,
          enrolled_at: null,
          updated_at: now,
        })
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        await writeAuditLog(supabase, {
          actorId: null,
          action: 'mobile.device.revoke',
          entityType: 'mobile_device',
          entityId: deviceId,
          newValues: { userId },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
      }

      return { revoked: Boolean(data) };
    },

    async revokeAllForUser(userId: string): Promise<void> {
      const now = new Date().toISOString();
      await supabase
        .from('mobile_devices')
        .update({
          revoked_at: now,
          biometric_enabled: false,
          credential_hash: null,
          updated_at: now,
        })
        .eq('user_id', userId)
        .is('revoked_at', null);
    },
  };
}
