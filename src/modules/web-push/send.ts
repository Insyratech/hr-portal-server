import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { isWebPushConfigured, loadEnv } from '../../config/env';
import { pathForNotificationPush } from '../notifications/notification-path';
import { loadUserRoles } from './load-user-roles';
import { createWebPushService } from './service';
import type { WebPushPayload } from './types';

function configureWebPush(): boolean {
  const env = loadEnv();
  if (!isWebPushConfigured(env)) {
    return false;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return true;
}

function isExpiredSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === 404 || statusCode === 410;
}

export async function sendWebPushToUser(
  supabase: SupabaseClient,
  userId: string,
  input: {
    title: string;
    body: string;
    referenceType: string;
    referenceId: string;
  },
): Promise<void> {
  if (!configureWebPush()) {
    return;
  }

  const roles = await loadUserRoles(supabase, userId);
  const deepLink = pathForNotificationPush({
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    title: input.title,
    message: input.body,
    roles,
  });

  const payload: WebPushPayload = {
    title: input.title,
    body: input.body,
    deepLink,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
  };

  const subscriptions = await createWebPushService(supabase).listActiveForUser(userId);
  if (subscriptions.length === 0) {
    return;
  }

  const service = createWebPushService(supabase);

  await Promise.allSettled(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: {
              p256dh: row.p256dh,
              auth: row.auth,
            },
          },
          JSON.stringify(payload),
        );
      } catch (error) {
        if (isExpiredSubscriptionError(error)) {
          await service.revokeByEndpoint(row.endpoint);
        }
      }
    }),
  );
}
