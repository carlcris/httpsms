export type SIM = "SIM1" | "SIM2";
export type MessageStatus = "pending" | "sending" | "sent" | "delivered" | "failed" | "expired";
export type MessageEventName = "SENT" | "DELIVERED" | "FAILED";

export interface Principal {
  kind: "application" | "device";
  id: string;
  active: boolean;
}

export interface Application {
  id: string;
  device_id: string;
  active: boolean;
  messages_per_minute: number;
}

export interface Device {
  id: string;
  user_id: string;
  phone_number: string;
  sim: SIM;
  active: boolean;
  messages_per_minute: number;
  fcm_token: string | null;
  last_seen_at: string | null;
  charging: boolean | null;
  updated_at: string;
}

// Public fields mirror android/.../Models.kt; internal fields are never serialized.
export interface Message {
  id: string;
  application_id: string;
  device_id: string;
  user_id: string;
  owner: string;
  contact: string;
  content: string;
  sim: SIM;
  encrypted: false;
  attachments: null;
  type: "mobile-terminated";
  status: MessageStatus;
  request_id: string;
  created_at: string;
  updated_at: string;
  request_received_at: string;
  order_timestamp: string;
  last_attempted_at: string | null;
  received_at: null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  expired_at: string | null;
  failure_reason: string | null;
  send_time: number | null;
  expires_at_ms: number;
  next_dispatch_at_ms: number;
  dispatch_lease_id: string | null;
  notification_attempt_count: number;
  last_notification_error: string | null;
}

export type PublicMessage = Omit<Message,
  "application_id" | "device_id" | "expires_at_ms" | "next_dispatch_at_ms" |
  "dispatch_lease_id" | "notification_attempt_count" | "last_notification_error"
>;

export interface IdempotencyRecord {
  message_id: string;
  fingerprint: string;
}

export interface RateWindow {
  started_at_ms: number;
  count: number;
}

export interface GatewayConfig {
  collectionPrefix: string;
  messageTTLSeconds: number;
  dispatchIntervalSeconds: number;
  sweepBatchSize: number;
}

export interface PushSender {
  send(token: string, messageId: string, ttlMs: number): Promise<void>;
}

export interface SendInput {
  to: string;
  content: string;
  from?: string | undefined;
  request_id?: string | undefined;
}

export interface EventInput {
  event_name: MessageEventName;
  timestamp: string;
  reason?: string | null | undefined;
}
