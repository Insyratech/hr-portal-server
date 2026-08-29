import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditLog } from '../audit/write-audit-log';
import type { WebPushSubscribeInput, WebPushSubscriptionRow } from './types';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export function createWebPushService(supabase: SupabaseClient) {
  return {
    async subscribe(
      userId: string,
      input: WebPushSubscribeInput,
      meta: RequestMeta,
    ): Promise<{ subscribed: true }> {
      const now = new Date().toISOString();
      const { error } = await supabase.from('web_push_subscriptions').upsert(
        {
          user_id: userId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          user_agent: meta.userAgent ?? null,
          revoked_at: null,
          updated_at: now,
        },
        { onConflict: 'endpoint' },
      );

      if (error) {
        throw error;
      }

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'web.push.subscribe',
        entityType: 'web_push_subscription',
        entityId: input.endpoint,
        newValues: { userId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { subscribed: true };
    },

    async revoke(userId: string, endpoint: string, meta: RequestMeta): Promise<{ revoked: boolean }> {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('web_push_subscriptions')
        .update({ revoked_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('endpoint', endpoint)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        await writeAuditLog(supabase, {
          actorId: null,
          action: 'web.push.revoke',
          entityType: 'web_push_subscription',
          entityId: endpoint,
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
        .from('web_push_subscriptions')
        .update({ revoked_at: now, updated_at: now })
        .eq('user_id', userId)
        .is('revoked_at', null);
    },

    async listActiveForUser(userId: string): Promise<WebPushSubscriptionRow[]> {
      const { data, error } = await supabase
        .from('web_push_subscriptions')
        .select('id, user_id, endpoint, p256dh, auth, user_agent, revoked_at')
        .eq('user_id', userId)
        .is('revoked_at', null);

      if (error) {
        throw error;
      }

      return (data ?? []) as WebPushSubscriptionRow[];
    },

    async revokeByEndpoint(endpoint: string): Promise<void> {
      const now = new Date().toISOString();
      await supabase
        .from('web_push_subscriptions')
        .update({ revoked_at: now, updated_at: now })
        .eq('endpoint', endpoint)
        .is('revoked_at', null);
    },
  };
}
