import { randomUUID } from "node:crypto";
import { digest } from "./auth.js";
import { GatewayError } from "./errors.js";
import type { Store, Transaction } from "./store.js";
import type {
  Application, Device, EventInput, GatewayConfig, IdempotencyRecord, Message,
  Principal, PublicMessage, PushSender, RateWindow, SendInput, SIM,
} from "./types.js";

const MAX_NOTIFICATION_ATTEMPTS = 5;
// DeliveredReceiver.kt reports this when an already-sent SMS cannot be delivered.
const DELIVERY_FAILURE_REASON = "CANNOT BE DELIVERED";

export class PushError extends Error {
  constructor(public readonly permanent: boolean, public readonly code: string) {
    super("Unable to notify the sending device.");
  }
}

export function publicMessage(message: Message): PublicMessage {
  const {
    application_id: _app, device_id: _device, expires_at_ms: _expiry,
    next_dispatch_at_ms: _next, dispatch_lease_id: _lease,
    notification_attempt_count: _attempts, last_notification_error: _error,
    ...result
  } = message;
  return result;
}

function requireKind(principal: Principal, kind: Principal["kind"]): void {
  if (principal.kind !== kind) throw new GatewayError(403, "This API key cannot perform this operation.");
}

function rateWindow(current: RateWindow | undefined, nowMs: number, limit: number): RateWindow {
  const window = !current || nowMs - current.started_at_ms >= 60_000
    ? { started_at_ms: nowMs, count: 0 }
    : current;
  if (window.count >= limit) {
    throw new GatewayError(429, "Message rate limit exceeded.", Math.max(1, Math.ceil((window.started_at_ms + 60_000 - nowMs) / 1000)));
  }
  return { ...window, count: window.count + 1 };
}

function expire(message: Message, nowMs: number): Message {
  const timestamp = new Date(nowMs).toISOString();
  return { ...message, status: "expired", expired_at: timestamp, updated_at: timestamp, dispatch_lease_id: null };
}

export class Gateway {
  constructor(
    public readonly store: Store,
    public readonly config: GatewayConfig,
    private readonly push: PushSender,
    private readonly now: () => number = Date.now,
  ) {}

  path(collection: string, id: string): string {
    return `${this.config.collectionPrefix}_${collection}/${id}`;
  }

  private async application(tx: Transaction, principal: Principal): Promise<Application> {
    requireKind(principal, "application");
    const application = await tx.get<Application>(this.path("applications", principal.id));
    if (!application?.active) throw new GatewayError(403, "Application access is disabled.");
    return application;
  }

  private async device(tx: Transaction, principal: Principal): Promise<Device> {
    requireKind(principal, "device");
    const device = await tx.get<Device>(this.path("devices", principal.id));
    if (!device?.active) throw new GatewayError(403, "Device access is disabled.");
    return device;
  }

  async send(principal: Principal, input: SendInput, idempotencyKey: string): Promise<{ message: Message; replayed: boolean }> {
    const id = randomUUID();
    const nowMs = this.now();
    const timestamp = new Date(nowMs).toISOString();
    const idempotencyPath = this.path("idempotency", digest(`${principal.id}\0${idempotencyKey}`));
    return this.store.transaction(async (tx) => {
      const application = await this.application(tx, principal);
      const existing = await tx.get<IdempotencyRecord>(idempotencyPath);
      if (existing) {
        const message = await tx.get<Message>(this.path("messages", existing.message_id));
        if (!message) throw new GatewayError(409, "This idempotency key belongs to a message that is no longer available.");
        const fingerprint = digest(JSON.stringify({ to: input.to, content: input.content, from: message.owner }));
        if (existing.fingerprint !== fingerprint) {
          throw new GatewayError(409, "This idempotency key was already used for a different message.");
        }
        if (input.from !== undefined && input.from !== message.owner) {
          throw new GatewayError(409, "This idempotency key was already used for a different sender.");
        }
        return { message, replayed: true };
      }
      const device = await tx.get<Device>(this.path("devices", application.device_id));
      if (!device?.active || !device.fcm_token) {
        throw new GatewayError(503, "The sending device is not registered or is disabled.");
      }
      if (input.from !== undefined && input.from !== device.phone_number) {
        throw new GatewayError(403, "The sender is not assigned to this application.");
      }
      const fingerprint = digest(JSON.stringify({ to: input.to, content: input.content, from: device.phone_number }));
      const ratePath = this.path("rates", `application_${application.id}`);
      const currentRate = await tx.get<RateWindow>(ratePath);
      const nextRate = rateWindow(currentRate, nowMs, application.messages_per_minute);
      const message: Message = {
        id, application_id: application.id, device_id: device.id, user_id: device.user_id,
        owner: device.phone_number, contact: input.to, content: input.content, sim: device.sim,
        encrypted: false, attachments: null, type: "mobile-terminated", status: "pending",
        request_id: idempotencyKey, created_at: timestamp, updated_at: timestamp,
        request_received_at: timestamp, order_timestamp: timestamp, last_attempted_at: null,
        received_at: null, sent_at: null, delivered_at: null, failed_at: null, expired_at: null,
        failure_reason: null, send_time: null,
        expires_at_ms: nowMs + this.config.messageTTLSeconds * 1000,
        next_dispatch_at_ms: nowMs, dispatch_lease_id: null,
        notification_attempt_count: 0, last_notification_error: null,
      };
      tx.set(this.path("messages", id), message);
      tx.set(idempotencyPath, { message_id: id, fingerprint });
      tx.set(ratePath, nextRate);
      return { message, replayed: false };
    });
  }

  async getMessage(principal: Principal, id: string): Promise<Message> {
    return this.store.transaction(async (tx) => {
      await this.application(tx, principal);
      let message = await tx.get<Message>(this.path("messages", id));
      if (!message || message.application_id !== principal.id) throw new GatewayError(404, "Message not found.");
      const nowMs = this.now();
      if (message.status === "pending" && message.expires_at_ms <= nowMs) {
        message = expire(message, nowMs);
        tx.set(this.path("messages", id), message);
      }
      return message;
    });
  }

  async register(principal: Principal, input: { phone_number: string; sim: SIM; fcm_token: string }): Promise<Device> {
    return this.store.transaction(async (tx) => {
      const device = await this.device(tx, principal);
      if (device.phone_number !== input.phone_number || device.sim !== input.sim) {
        throw new GatewayError(403, "This device key is not assigned to this phone number and SIM.");
      }
      const result: Device = { ...device, fcm_token: input.fcm_token, updated_at: new Date(this.now()).toISOString() };
      tx.set(this.path("devices", device.id), result);
      return result;
    });
  }

  async heartbeat(principal: Principal, input: { phone_numbers: string[]; charging: boolean }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const device = await this.device(tx, principal);
      if (input.phone_numbers.some((number) => number !== device.phone_number)) {
        throw new GatewayError(403, "This device key is not assigned to these phone numbers.");
      }
      const timestamp = new Date(this.now()).toISOString();
      tx.set(this.path("devices", device.id), { ...device, last_seen_at: timestamp, charging: input.charging, updated_at: timestamp });
    });
  }

  async claim(principal: Principal, id: string): Promise<Message> {
    const result = await this.store.transaction(async (tx) => {
      const device = await this.device(tx, principal);
      const message = await tx.get<Message>(this.path("messages", id));
      if (!message || message.device_id !== device.id || message.status !== "pending") {
        throw new GatewayError(404, "Outstanding message not found.");
      }
      const nowMs = this.now();
      if (message.expires_at_ms <= nowMs) {
        tx.set(this.path("messages", id), expire(message, nowMs));
        return null;
      }
      const ratePath = this.path("rates", `device_${device.id}`);
      const currentRate = await tx.get<RateWindow>(ratePath);
      const nextRate = rateWindow(currentRate, nowMs, device.messages_per_minute);
      const timestamp = new Date(nowMs).toISOString();
      const claimed: Message = { ...message, status: "sending", last_attempted_at: timestamp, updated_at: timestamp, dispatch_lease_id: null };
      tx.set(this.path("messages", id), claimed);
      tx.set(ratePath, nextRate);
      return claimed;
    });
    if (!result) throw new GatewayError(404, "Outstanding message not found.");
    return result;
  }

  async report(principal: Principal, id: string, event: EventInput, multipart = false): Promise<Message> {
    return this.store.transaction(async (tx) => {
      const device = await this.device(tx, principal);
      const message = await tx.get<Message>(this.path("messages", id));
      if (!message || message.device_id !== device.id) throw new GatewayError(404, "Message not found.");
      // The unchanged Android app uses <messageId>.<part> for intermediate SMS parts.
      // Match upstream behavior: only the final, unsuffixed callback determines status.
      if (multipart) return message;
      if (!message.last_attempted_at) throw new GatewayError(409, "The phone has not claimed this message.");
      const updated = { ...message };
      const timestamp = new Date(Date.parse(event.timestamp)).toISOString();
      updated.updated_at = new Date(this.now()).toISOString();
      if (event.event_name === "DELIVERED") {
        updated.status = "delivered";
        updated.delivered_at ??= timestamp;
        updated.failure_reason = null;
      } else if (event.event_name === "SENT") {
        updated.sent_at ??= timestamp;
        updated.send_time ??= Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Date.parse(timestamp) - Date.parse(message.request_received_at)) * 1_000_000);
        if (updated.status !== "delivered" && updated.failure_reason !== DELIVERY_FAILURE_REASON) {
          updated.status = "sent";
          updated.failure_reason = null;
        }
      } else if (updated.status !== "delivered" && (updated.status !== "sent" || event.reason === DELIVERY_FAILURE_REASON)) {
        updated.status = "failed";
        updated.failed_at ??= timestamp;
        updated.failure_reason = event.reason === DELIVERY_FAILURE_REASON
          ? DELIVERY_FAILURE_REASON
          : updated.failure_reason || event.reason || "The phone could not send the SMS.";
      }
      tx.set(this.path("messages", id), updated);
      return updated;
    });
  }

  async dispatch(id: string): Promise<void> {
    const leaseId = randomUUID();
    const work = await this.store.transaction(async (tx) => {
      const message = await tx.get<Message>(this.path("messages", id));
      const nowMs = this.now();
      if (!message || message.status !== "pending" || message.next_dispatch_at_ms > nowMs) return null;
      if (message.expires_at_ms <= nowMs) {
        tx.set(this.path("messages", id), expire(message, nowMs));
        return null;
      }
      const device = await tx.get<Device>(this.path("devices", message.device_id));
      if (message.notification_attempt_count >= MAX_NOTIFICATION_ATTEMPTS || !device?.active || !device.fcm_token) {
        tx.set(this.path("messages", id), { ...message, next_dispatch_at_ms: message.expires_at_ms });
        return null;
      }
      tx.set(this.path("messages", id), {
        ...message, dispatch_lease_id: leaseId,
        notification_attempt_count: message.notification_attempt_count + 1,
        next_dispatch_at_ms: Math.min(message.expires_at_ms, nowMs + Math.max(30_000, this.config.dispatchIntervalSeconds * 1000)),
      });
      return { message, token: device.fcm_token, ttlMs: message.expires_at_ms - nowMs };
    });
    if (!work) return;
    let error: PushError | undefined;
    try {
      await this.push.send(work.token, id, work.ttlMs);
    } catch (cause) {
      error = cause instanceof PushError ? cause : new PushError(false, "push_unavailable");
    }
    await this.store.transaction(async (tx) => {
      const message = await tx.get<Message>(this.path("messages", id));
      // A callback, claim, or newer dispatch must never be overwritten by this attempt.
      if (!message || message.status !== "pending" || message.dispatch_lease_id !== leaseId) return;
      const updated: Message = { ...message, dispatch_lease_id: null, last_notification_error: error?.code ?? null };
      if (error?.permanent) {
        updated.status = "failed";
        updated.failed_at = new Date(this.now()).toISOString();
        updated.updated_at = updated.failed_at;
        updated.failure_reason = "The sending device could not be notified. Check its Firebase configuration and registration.";
      }
      tx.set(this.path("messages", id), updated);
    });
  }

  async sweep(): Promise<{ processed: number; errors: number }> {
    const ids = await this.store.dueMessageIds(`${this.config.collectionPrefix}_messages`, this.now(), this.config.sweepBatchSize);
    const results = await Promise.allSettled(ids.map((id) => this.dispatch(id)));
    return { processed: ids.length, errors: results.filter((result) => result.status === "rejected").length };
  }
}
