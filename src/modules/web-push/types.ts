export type WebPushSubscribeInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type WebPushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  revoked_at: string | null;
};

export type WebPushPayload = {
  title: string;
  body: string;
  deepLink: string;
  referenceType: string;
  referenceId: string;
};
