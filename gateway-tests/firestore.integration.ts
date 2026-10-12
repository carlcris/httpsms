import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { initializeFirestore } from "firebase-admin/firestore";
import { FirestoreStore } from "../src/gateway/firestore-store.js";
import { deviceKey, fixture, request } from "./fixtures.js";

test("real Firestore transactions deduplicate concurrent sends, claims, and status callbacks", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const app = initializeApp({ projectId: "demo-sms-gateway" }, `integration-${randomUUID()}`);
  const database = initializeFirestore(app, { preferRest: false });
  const prefix = `test_${randomUUID().replaceAll("-", "")}`;
  try {
    const f = await fixture(new FirestoreStore(database), prefix);
    const accepted = await Promise.all(Array.from({ length: 6 }, () => f.send()));
    const bodies = await Promise.all(accepted.map(async (response) => {
      assert.equal(response.status, 202);
      return response.json();
    }));
    const id: string = bodies[0]!.data.id;
    assert.equal(new Set(bodies.map((body) => body.data.id)).size, 1);
    assert.equal(f.calls.length, 1);
    const anonymousRead = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-sms-gateway/databases/(default)/documents/${prefix}_messages/${id}`);
    assert.equal(anonymousRead.status, 403, "Direct client access must be denied by firestore.rules");
    f.clock.now += 60_000;
    assert.deepEqual(await f.gateway.sweep(), { processed: 1, errors: 0 });
    const fetched = await Promise.all(Array.from({ length: 6 }, () => f.handler(request(`/v1/messages/outstanding?message_id=${id}`, deviceKey))));
    assert.equal(fetched.filter((response) => response.status === 200).length, 1);
    assert.equal(fetched.filter((response) => response.status === 404).length, 5);
    const reports = await Promise.all(["SENT", "DELIVERED", "FAILED"].map((event_name) => f.handler(request(`/v1/messages/${id}/events`, deviceKey, "POST", {
      event_name, timestamp: new Date(f.clock.now).toISOString(), reason: null,
    }))));
    assert.ok(reports.every((response) => response.status === 200));
    const delivered = await (await f.handler(request(`/v1/messages/${id}`))).json();
    assert.equal(delivered.data.status, "delivered");
    assert.deepEqual(await f.gateway.sweep(), { processed: 0, errors: 0 });
  } finally {
    for (const suffix of ["applications", "devices", "keys", "messages", "idempotency", "rates"]) {
      await database.recursiveDelete(database.collection(`${prefix}_${suffix}`));
    }
    await database.terminate();
    await deleteApp(app);
  }
});
