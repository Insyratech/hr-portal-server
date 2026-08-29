export type MobilePlatform = 'android' | 'ios';

export type RegisterMobileDeviceInput = {
  deviceId: string;
  platform: MobilePlatform;
  pushToken: string;
  appVersion?: string;
};

export type MobileDeviceRow = {
  id: string;
  user_id: string;
  device_id: string;
  platform: MobilePlatform;
  push_token: string;
  app_version: string | null;
  last_seen_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MobileDeviceDto = {
  id: string;
  deviceId: string;
  platform: MobilePlatform;
  pushToken: string;
  appVersion: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type PushPayload = {
  title: string;
  body: string;
  deepLink: string;
  referenceType: string;
  referenceId: string;
};
