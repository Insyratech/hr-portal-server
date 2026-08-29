import http2 from 'node:http2';
import type { SupabaseClient } from '@supabase/supabase-js';
import { importPKCS8, SignJWT } from 'jose';
import { loadEnv } from '../../config/env';
import { pathForNotificationPush } from './notification-path';
import { createMobileDeviceService } from './service';
import type { PushPayload } from './types';

type PushEnv = ReturnType<typeof loadEnv>;

function isPushConfigured(env: PushEnv): boolean {
  const hasFirebase =
    env.FIREBASE_PROJECT_ID.length > 0 &&
    env.FIREBASE_CLIENT_EMAIL.length > 0 &&
    env.FIREBASE_PRIVATE_KEY.length > 0;
  const hasApns =
    env.APNS_KEY_ID.length > 0 &&
    env.APNS_TEAM_ID.length > 0 &&
    env.APNS_BUNDLE_ID.length > 0 &&
    env.APNS_PRIVATE_KEY.length > 0;
  return hasFirebase || hasApns;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n');
}

async function getFirebaseAccessToken(env: PushEnv): Promise<string> {
  const privateKey = await importPKCS8(normalizePrivateKey(env.FIREBASE_PRIVATE_KEY), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.FIREBASE_CLIENT_EMAIL)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Firebase token exchange failed (${response.status}).`);
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Firebase token exchange returned no access token.');
  }
  return json.access_token;
}

async function sendFcm(env: PushEnv, token: string, payload: PushPayload): Promise<void> {
  const accessToken = await getFirebaseAccessToken(env);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: {
            deepLink: payload.deepLink,
            referenceType: payload.referenceType,
            referenceId: payload.referenceId,
          },
          android: {
            priority: 'HIGH',
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                sound: 'default',
              },
            },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FCM send failed (${response.status}): ${body}`);
  }
}

let cachedApnsJwt: { token: string; expiresAt: number } | null = null;

async function getApnsJwt(env: PushEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedApnsJwt && cachedApnsJwt.expiresAt > now + 60) {
    return cachedApnsJwt.token;
  }

  const privateKey = await importPKCS8(normalizePrivateKey(env.APNS_PRIVATE_KEY), 'ES256');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APNS_KEY_ID })
    .setIssuer(env.APNS_TEAM_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  cachedApnsJwt = { token, expiresAt: now + 3600 };
  return token;
}

async function sendApns(env: PushEnv, deviceToken: string, payload: PushPayload): Promise<void> {
  const jwt = await getApnsJwt(env);
  const host = env.APNS_USE_SANDBOX ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const path = `/3/device/${deviceToken}`;

  await new Promise<void>((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);

    const request = client.request({
      ':method': 'POST',
      ':path': path,
      authorization: `bearer ${jwt}`,
      'apns-topic': env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });

    let responseStatus = 0;
    request.on('response', (headers) => {
      responseStatus = Number(headers[':status'] ?? 0);
    });

    request.setEncoding('utf8');
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });

    request.on('end', () => {
      client.close();
      if (responseStatus >= 200 && responseStatus < 300) {
        resolve();
        return;
      }
      reject(new Error(`APNs send failed (${responseStatus}): ${body}`));
    });

    request.on('error', (error) => {
      client.close();
      reject(error);
    });

    request.write(
      JSON.stringify({
        aps: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: 'default',
        },
        deepLink: payload.deepLink,
        referenceType: payload.referenceType,
        referenceId: payload.referenceId,
      }),
    );
    request.end();
  });
}

async function loadUserRoles(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('employee_roles ( roles ( code ) )')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    return ['EMPLOYEE'];
  }

  const roleRows = (data.employee_roles ?? []) as { roles?: { code?: string } | { code?: string }[] | null }[];
  const roles: string[] = [];
  for (const row of roleRows) {
    const role = row.roles;
    if (!role) continue;
    if (Array.isArray(role)) {
      for (const item of role) {
        if (item.code) roles.push(item.code);
      }
      continue;
    }
    if (role.code) roles.push(role.code);
  }

  return roles.length > 0 ? roles : ['EMPLOYEE'];
}

async function sendToDevice(
  env: PushEnv,
  platform: 'android' | 'ios',
  token: string,
  payload: PushPayload,
): Promise<void> {
  const hasFirebase =
    env.FIREBASE_PROJECT_ID.length > 0 &&
    env.FIREBASE_CLIENT_EMAIL.length > 0 &&
    env.FIREBASE_PRIVATE_KEY.length > 0;
  const hasApns =
    env.APNS_KEY_ID.length > 0 &&
    env.APNS_TEAM_ID.length > 0 &&
    env.APNS_BUNDLE_ID.length > 0 &&
    env.APNS_PRIVATE_KEY.length > 0;

  if (platform === 'android' && hasFirebase) {
    await sendFcm(env, token, payload);
    return;
  }

  if (platform === 'ios' && hasApns) {
    await sendApns(env, token, payload);
    return;
  }

  if (hasFirebase) {
    await sendFcm(env, token, payload);
  }
}

export async function sendPushToUser(
  supabase: SupabaseClient,
  userId: string,
  input: {
    title: string;
    body: string;
    referenceType: string;
    referenceId: string;
  },
): Promise<void> {
  const env = loadEnv();
  if (!isPushConfigured(env)) {
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

  const payload: PushPayload = {
    title: input.title,
    body: input.body,
    deepLink,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
  };

  const devices = await createMobileDeviceService(supabase).listActiveTokensForUser(userId);
  if (devices.length === 0) {
    return;
  }

  await Promise.allSettled(
    devices.map((device) => sendToDevice(env, device.platform, device.pushToken, payload)),
  );
}
