import type { SupabaseClient } from '@supabase/supabase-js';
import type { MobileDeviceDto, MobileDeviceRow, RegisterMobileDeviceInput } from './types';

function mapDevice(row: MobileDeviceRow): MobileDeviceDto {
  return {
    id: row.id,
    deviceId: row.device_id,
    platform: row.platform,
    pushToken: row.push_token,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function createMobileDeviceService(supabase: SupabaseClient) {
  return {
    async register(userId: string, input: RegisterMobileDeviceInput): Promise<MobileDeviceDto> {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('mobile_devices')
        .upsert(
          {
            user_id: userId,
            device_id: input.deviceId,
            platform: input.platform,
            push_token: input.pushToken,
            app_version: input.appVersion ?? null,
            last_seen_at: now,
            revoked_at: null,
            updated_at: now,
          },
          { onConflict: 'user_id,device_id' },
        )
        .select('*')
        .single();

      if (error || !data) {
        throw error ?? new Error('Failed to register mobile device.');
      }

      return mapDevice(data as MobileDeviceRow);
    },

    async revoke(userId: string, deviceId: string): Promise<{ revoked: boolean }> {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('mobile_devices')
        .update({ revoked_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();

      if (error) {
        throw error;
      }

      return { revoked: Boolean(data) };
    },

    async listMine(userId: string): Promise<MobileDeviceDto[]> {
      const { data, error } = await supabase
        .from('mobile_devices')
        .select('*')
        .eq('user_id', userId)
        .is('revoked_at', null)
        .order('last_seen_at', { ascending: false });

      if (error) {
        throw error;
      }

      return (data ?? []).map((row) => mapDevice(row as MobileDeviceRow));
    },

    async listActiveTokensForUser(userId: string): Promise<{ platform: 'android' | 'ios'; pushToken: string }[]> {
      const { data, error } = await supabase
        .from('mobile_devices')
        .select('platform, push_token')
        .eq('user_id', userId)
        .is('revoked_at', null);

      if (error) {
        throw error;
      }

      return (data ?? []).map((row) => ({
        platform: row.platform as 'android' | 'ios',
        pushToken: String(row.push_token),
      }));
    },
  };
}
