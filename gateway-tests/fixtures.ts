import { digest } from "../src/gateway/auth.js";
import { Gateway } from "../src/gateway/gateway.js";
import { createHandler } from "../src/gateway/http.js";
import type { Store } from "../src/gateway/store.js";
import type { Application, Device, GatewayConfig, Principal, PushSender } from "../src/gateway/types.js";
import { MemoryStore } from "./memory-store.js";

export const appKey = "a".repeat(64);
export const otherAppKey = "b".repeat(64);
export const deviceKey = "c".repeat(64);
export const otherDeviceKey = "d".repeat(64);

export function request(path: string, key = appKey, method = "GET", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://gateway.example${path}`, {
    method,
    headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function fixture(store: Store = new MemoryStore(), prefix = "sms_gateway") {
  const clock = { now: Date.parse("2026-10-12T09:00:00Z") };
  const calls: { token: string; id: string; ttl: number }[] = [];
  const transport: { error?: Error; onSend?: () => Promise<void> } = {};
  const push: PushSender = {
    send: async (token, id, ttl) => {
      calls.push({ token, id, ttl });
      await transport.onSend?.();
      if (transport.error) throw transport.error;
    },
  };
  const config: GatewayConfig = { collectionPrefix: prefix, messageTTLSeconds: 300, dispatchIntervalSeconds: 60, sweepBatchSize: 5 };
  const gateway = new Gateway(store, config, push, () => clock.now);
  const app: Application = { id: "notifications", device_id: "primary-phone", active: true, messages_per_minute: 20 };
  const device: Device = {
    id: "primary-phone", user_id: "primary-phone", phone_number: "+639171234567", sim: "SIM1",
    active: true, messages_per_minute: 3, fcm_token: "test-fcm-token", last_seen_at: null,
    charging: null, updated_at: new Date(clock.now).toISOString(),
  };
  const appPrincipal: Principal = { id: app.id, kind: "application", active: true };
  const devicePrincipal: Principal = { id: device.id, kind: "device", active: true };
  await store.transaction(async (tx) => {
    tx.set(gateway.path("applications", app.id), app);
    tx.set(gateway.path("applications", "other-app"), { ...app, id: "other-app" });
    tx.set(gateway.path("devices", device.id), device);
    tx.set(gateway.path("devices", "other-phone"), { ...device, id: "other-phone" });
    tx.set(gateway.path("keys", digest(appKey)), appPrincipal);
    tx.set(gateway.path("keys", digest(otherAppKey)), { ...appPrincipal, id: "other-app" });
    tx.set(gateway.path("keys", digest(deviceKey)), devicePrincipal);
    tx.set(gateway.path("keys", digest(otherDeviceKey)), { ...devicePrincipal, id: "other-phone" });
  });
  const handler = createHandler(gateway);
  const send = (key = "notification-1", content = "Your order is ready.", apiKey = appKey) => handler(request(
    "/v1/messages/send", apiKey, "POST", { to: "+639189876543", content }, { "idempotency-key": key },
  ));
  return { store, gateway, handler, clock, calls, transport, app, device, appPrincipal, devicePrincipal, send };
}
