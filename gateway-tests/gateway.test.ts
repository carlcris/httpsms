import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../src/gateway/auth.js";
import { PushError } from "../src/gateway/gateway.js";
import type { Message } from "../src/gateway/types.js";
import { appKey, deviceKey, fixture, otherAppKey, otherDeviceKey, request } from "./fixtures.js";

test("application -> existing Android contracts -> SMS status completes the first milestone", async () => {
  const f = await fixture();
  const registration = await f.handler(request("/v1/phones/fcm-token", deviceKey, "PUT", {
    phone_number: f.device.phone_number, sim: "SIM1", fcm_token: "refreshed-fcm-token",
  }));
  assert.equal(registration.status, 200);
  assert.deepEqual((await registration.json()).data, { id: "primary-phone", user_id: "primary-phone" });

  const accepted = await f.send();
  assert.equal(accepted.status, 202);
  const message = (await accepted.json()).data;
  assert.equal(message.status, "pending");
  assert.equal(accepted.headers.get("location"), `/v1/messages/${message.id}`);
  assert.deepEqual(f.calls, [{ token: "refreshed-fcm-token", id: message.id, ttl: 300_000 }]);

  const claimed = await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey));
  assert.equal(claimed.status, 200);
  const envelope = await claimed.json();
  assert.equal(envelope.status, "success");
  // Required Kotlin constructor fields, recorded independently from Models.kt.
  const required = ["contact", "content", "sim", "created_at", "failure_reason", "id", "last_attempted_at", "order_timestamp", "owner", "received_at", "encrypted", "request_received_at", "send_time", "sent_at", "status", "type", "updated_at"];
  for (const field of required) assert.ok(field in envelope.data, `Missing Android field: ${field}`);
  assert.equal(envelope.data.status, "sending");
  assert.equal(envelope.data.owner, f.device.phone_number);
  assert.equal(envelope.data.contact, "+639189876543");
  assert.equal(envelope.data.type, "mobile-terminated");
  assert.equal(envelope.data.encrypted, false);
  assert.equal(envelope.data.attachments, null);
  assert.ok(!("dispatch_lease_id" in envelope.data));

  for (const event_name of ["SENT", "DELIVERED"]) {
    const reported = await f.handler(request(`/v1/messages/${message.id}/events`, deviceKey, "POST", {
      event_name, timestamp: "2026-10-12T17:00:01.123000000+08:00", reason: null,
    }));
    assert.equal(reported.status, 200);
  }
  const result = await f.handler(request(`/v1/messages/${message.id}`));
  const delivered = (await result.json()).data;
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.sent_at, "2026-10-12T09:00:01.123Z");
  assert.equal(delivered.delivered_at, "2026-10-12T09:00:01.123Z");
  assert.equal(delivered.send_time, 1_123_000_000);
  for (const secret of ["fcm_token", "application_id", "device_id", "expires_at_ms", "last_notification_error"]) assert.ok(!(secret in delivered));
});

test("concurrent idempotent sends create one message and one wake-up; changed content conflicts", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.send()));
  assert.ok(results.every((result) => result.status === 202));
  const messages = await Promise.all(results.map(async (result) => (await result.json()).data));
  assert.equal(new Set(messages.map((message) => message.id)).size, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(results.filter((result) => result.headers.get("idempotency-replayed") === "false").length, 1);
  assert.equal((await f.send("notification-1", "Different content")).status, 409);
  const otherApp = await f.send("notification-1", "Different content", otherAppKey);
  assert.equal(otherApp.status, 202);
  assert.notEqual((await otherApp.json()).data.id, messages[0]!.id);
});

test("an accepted request remains replayable when its sending device is subsequently disabled", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  await f.store.transaction(async (tx) => {
    tx.set(f.gateway.path("devices", f.device.id), { ...f.device, active: false, fcm_token: null });
  });
  const replay = await f.send();
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).data.id, message.id);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await f.send("new-request")).status, 503);
});

test("application and device credentials enforce ownership and operation boundaries", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  assert.equal((await f.handler(request(`/v1/messages/${message.id}`, otherAppKey))).status, 404);
  assert.equal((await f.handler(request(`/v1/messages/${message.id}`, deviceKey))).status, 403);
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, appKey))).status, 403);
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, otherDeviceKey))).status, 404);
  assert.equal((await f.send("device-attempt", "test", deviceKey)).status, 403);
  assert.equal((await f.handler(request("/v1/phones/fcm-token", appKey, "PUT", {
    phone_number: f.device.phone_number, sim: "SIM1", fcm_token: "replacement-token",
  }))).status, 403);
  assert.equal((await f.handler(request("/v1/phones/fcm-token", deviceKey, "PUT", {
    phone_number: "+639199999999", sim: "SIM1", fcm_token: "replacement-token",
  }))).status, 403);
  assert.equal((await f.handler(request(`/v1/messages/${message.id}/events`, otherDeviceKey, "POST", {
    event_name: "SENT", timestamp: new Date(f.clock.now).toISOString(),
  }))).status, 404);
  assert.equal((await f.handler(request(`/v1/messages/${message.id}/events`, deviceKey, "POST", {
    event_name: "SENT", timestamp: new Date(f.clock.now).toISOString(),
  }))).status, 409);
  await f.store.transaction(async (tx) => {
    tx.set(f.gateway.path("keys", digest(appKey)), { ...f.appPrincipal, active: false });
  });
  assert.equal((await f.send("revoked")).status, 401);
});

test("simultaneous phone fetches hand a message out only once; claimed messages are never resent", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey))));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 404).length, 7);
  f.clock.now += 600_000;
  assert.deepEqual(await f.gateway.sweep(), { processed: 0, errors: 0 });
  assert.equal(f.calls.length, 1);
  assert.equal((await (await f.handler(request(`/v1/messages/${message.id}`))).json()).data.status, "sending");
});

test("wake-up failures remain durable and the bounded recovery sweep retries them", async () => {
  const f = await fixture();
  f.transport.error = new Error("secret device token must never be exposed");
  const result = await f.send();
  assert.equal(result.status, 202);
  const { data: message } = await result.json();
  assert.equal(message.status, "pending");
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", message.id)))?.last_notification_error, "push_unavailable");
  delete f.transport.error;
  f.clock.now += 60_000;
  assert.deepEqual(await f.gateway.sweep(), { processed: 1, errors: 0 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.ttl, 240_000);
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey))).status, 200);
});

test("permanent Firebase registration errors are visible as failed SMS requests without raw errors", async () => {
  const f = await fixture();
  f.transport.error = new PushError(true, "device_registration_invalid");
  const { data: message } = await (await f.send()).json();
  const result = await f.handler(request(`/v1/messages/${message.id}`));
  const body = await result.json();
  assert.equal(body.data.status, "failed");
  assert.match(body.data.failure_reason, /Firebase configuration/);
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey))).status, 404);
});

test("expired messages are persisted as expired and cannot be fetched or awakened", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  f.clock.now += 300_000;
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey))).status, 404);
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", message.id)))?.status, "expired");
  await f.gateway.sweep();
  assert.equal(f.calls.length, 1);
});

test("application quotas ignore replays and the device quota is shared between applications", async () => {
  const f = await fixture();
  await f.store.transaction(async (tx) => {
    tx.set(f.gateway.path("applications", f.app.id), { ...f.app, messages_per_minute: 1 });
    tx.set(f.gateway.path("devices", f.device.id), { ...f.device, messages_per_minute: 1 });
  });
  const first = (await (await f.send()).json()).data;
  assert.equal((await f.send()).status, 202);
  const denied = await f.send("notification-2");
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  const second = (await (await f.send("other-app-message", "Hello", otherAppKey)).json()).data;
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${first.id}`, deviceKey))).status, 200);
  const throttled = await f.handler(request(`/v1/messages/outstanding?message_id=${second.id}`, deviceKey));
  assert.equal(throttled.status, 429);
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", second.id)))?.status, "pending");
  f.clock.now += 60_000;
  assert.equal((await f.handler(request(`/v1/messages/outstanding?message_id=${second.id}`, deviceKey))).status, 200);
  assert.equal((await f.send("notification-3")).status, 202);
});

test("late and duplicate status reports cannot regress a delivery result", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey));
  for (const event_name of ["DELIVERED", "SENT", "FAILED", "DELIVERED"]) {
    const result = await f.handler(request(`/v1/messages/${message.id}/events`, deviceKey, "POST", {
      event_name, timestamp: new Date(f.clock.now).toISOString(), reason: "Late failure",
    }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.status, "delivered");
    f.clock.now += 1000;
  }
  const stored = await f.store.get<Message>(f.gateway.path("messages", message.id));
  assert.equal(stored?.delivered_at, "2026-10-12T09:00:00.000Z");
  assert.equal(stored?.sent_at, "2026-10-12T09:00:01.000Z");
  assert.equal(stored?.failure_reason, null);
});

test("Android's explicit cannot-be-delivered report remains failed after a late SENT callback", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  await f.gateway.claim(f.devicePrincipal, message.id);
  const timestamp = new Date(f.clock.now).toISOString();
  await f.gateway.report(f.devicePrincipal, message.id, { event_name: "SENT", timestamp });
  await f.gateway.report(f.devicePrincipal, message.id, { event_name: "FAILED", timestamp, reason: "CANNOT BE DELIVERED" });
  const failed = await f.gateway.report(f.devicePrincipal, message.id, { event_name: "SENT", timestamp });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "CANNOT BE DELIVERED");
  assert.ok(failed.sent_at);
  const delivered = await f.gateway.report(f.devicePrincipal, message.id, { event_name: "DELIVERED", timestamp });
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.failure_reason, null);
});

test("multipart callbacks match upstream's intermediate-part behavior and check device ownership", async () => {
  const f = await fixture();
  const { data: message } = await (await f.send()).json();
  await f.handler(request(`/v1/messages/outstanding?message_id=${message.id}`, deviceKey));
  const body = { event_name: "SENT", timestamp: new Date(f.clock.now).toISOString(), reason: null };
  assert.equal((await f.handler(request(`/v1/messages/${message.id}.0/events`, deviceKey, "POST", body))).status, 204);
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", message.id)))?.status, "sending");
  assert.equal((await f.handler(request(`/v1/messages/${message.id}.0/events`, otherDeviceKey, "POST", body))).status, 404);
  assert.equal((await f.handler(request(`/v1/messages/${message.id}/events`, deviceKey, "POST", body))).status, 200);
});

test("dispatch completion cannot overwrite a phone claim or callback racing the push response", async () => {
  const f = await fixture();
  f.transport.onSend = async () => {
    const id = f.calls[0]!.id;
    await f.gateway.claim(f.devicePrincipal, id);
    await f.gateway.report(f.devicePrincipal, id, { event_name: "SENT", timestamp: new Date(f.clock.now).toISOString() });
  };
  f.transport.error = new PushError(true, "device_registration_invalid");
  const { data: message } = await (await f.send()).json();
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", message.id)))?.status, "sent");
});

test("malformed input, unexpected fields, oversized bodies, and sender spoofing are rejected", async () => {
  const f = await fixture();
  const invalid = [
    { to: "09171234567", content: "Test" },
    { to: "+639171234567", content: " " },
    { to: "+639171234567", content: "x".repeat(1601) },
    { to: "+639171234567", content: "Test", application_id: "other-app" },
    { to: "+639171234567", content: "Test", attachments: ["https://example.com/file"] },
  ];
  for (const body of invalid) {
    assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", body, { "idempotency-key": "test" }))).status, 422);
  }
  assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", {
    to: "+639171234567", content: "Test", from: "+639199999999",
  }, { "idempotency-key": "test" }))).status, 403);
  assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", {
    to: "+639171234567", content: "Test",
  }))).status, 422);
  assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", {
    to: "+639171234567", content: "Test", request_id: "different-key",
  }, { "idempotency-key": "test" }))).status, 422);
  assert.equal((await f.handler(new Request("https://gateway.example/v1/messages/send", {
    method: "POST", headers: { "x-api-key": appKey, "content-type": "application/json" }, body: "{",
  }))).status, 400);
  assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", { content: "x".repeat(17000) }))).status, 413);
  assert.equal((await f.handler(request("/v1/messages/send", appKey, "POST", {}, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await f.handler(request("/v1/messages/send", "invalid", "POST", {}))).status, 401);
});

test("phone heartbeats are scoped; inbound forwarding is declined without storing contents", async () => {
  const f = await fixture();
  assert.equal((await f.handler(request("/v1/heartbeats", deviceKey, "POST", {
    phone_numbers: [f.device.phone_number], charging: true,
  }))).status, 200);
  assert.equal((await f.handler(request("/v1/heartbeats", deviceKey, "POST", {
    phone_numbers: ["+639199999999"], charging: true,
  }))).status, 403);
  const device = await f.store.get<typeof f.device>(f.gateway.path("devices", f.device.id));
  assert.equal(device?.charging, true);
  const storeSize = (f.store as import("./memory-store.js").MemoryStore).documents.size;
  assert.equal((await f.handler(request("/v1/messages/receive", deviceKey, "POST", { content: "private incoming SMS" }))).status, 410);
  assert.equal((f.store as import("./memory-store.js").MemoryStore).documents.size, storeSize);
});

test("notification attempts are bounded and pending messages expire after their deadline", async () => {
  const f = await fixture();
  f.gateway.config.messageTTLSeconds = 1000;
  const { data: message } = await (await f.send()).json();
  for (let i = 0; i < 8; i++) {
    f.clock.now += 60_000;
    await f.gateway.sweep();
  }
  assert.equal(f.calls.length, 5);
  f.clock.now += 1_000_000;
  await f.gateway.sweep();
  assert.equal((await f.store.get<Message>(f.gateway.path("messages", message.id)))?.status, "expired");
});
