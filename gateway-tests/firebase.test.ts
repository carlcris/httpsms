import assert from "node:assert/strict";
import { test } from "node:test";
import { FirebasePushSender } from "../src/gateway/firebase.js";
import { PushError } from "../src/gateway/gateway.js";
import { readConfig } from "../src/gateway/config.js";

test("Firebase sends the upstream data-only payload with the expected key and remaining TTL", async () => {
  let payload: unknown;
  const push = new FirebasePushSender({ send: async (message) => { payload = message; return "test-notification-id"; } });
  await push.send("device-token", "message-id", 123_000);
  assert.deepEqual(payload, { token: "device-token", data: { KEY_MESSAGE_ID: "message-id" }, android: { priority: "normal", ttl: 123_000 } });
});

test("Firebase errors are categorized without retaining their sensitive messages", async () => {
  for (const [code, permanent] of [["messaging/mismatched-credential", true], ["messaging/server-unavailable", false]] as const) {
    const push = new FirebasePushSender({ send: async () => { throw { code, message: "private credential and token details" }; } });
    await assert.rejects(push.send("device-token", "message-id", 123_000), (error: unknown) => {
      assert.ok(error instanceof PushError);
      assert.equal(error.permanent, permanent);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  }
});

test("configuration bounds recovery work and rejects invalid collection identifiers", () => {
  assert.deepEqual(readConfig({}), { collectionPrefix: "sms_gateway", messageTTLSeconds: 300, dispatchIntervalSeconds: 60, sweepBatchSize: 5 });
  assert.throws(() => readConfig({ GATEWAY_COLLECTION_PREFIX: "messages/secret" }));
  assert.throws(() => readConfig({ GATEWAY_SWEEP_BATCH_SIZE: "1000" }));
  assert.throws(() => readConfig({ GATEWAY_MESSAGE_TTL_SECONDS: "NaN" }));
});
