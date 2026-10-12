import { applicationDefault, cert, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { initializeFirestore } from "firebase-admin/firestore";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { readConfig } from "./config.js";
import { FirestoreStore } from "./firestore-store.js";
import { Gateway, PushError } from "./gateway.js";
import type { PushSender } from "./types.js";

const APP_NAME = "netlify-sms-gateway";

export function firebaseApp(env: NodeJS.ProcessEnv = process.env): App {
  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing) return existing;
  const emulator = env.FIRESTORE_EMULATOR_HOST;
  if (emulator) {
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(emulator) || env.NETLIFY === "true") {
      throw new Error("Firestore emulation is limited to local development.");
    }
    const projectId = env.FIREBASE_PROJECT_ID || "demo-sms-gateway";
    if (!projectId.startsWith("demo-")) throw new Error("Use a demo- project ID for emulation.");
    return initializeApp({ projectId }, APP_NAME);
  }
  if (env.GATEWAY_MOCK_PUSH === "true") throw new Error("Mock push is limited to local emulation.");
  let serviceAccount: ServiceAccount | undefined;
  if (env.FIREBASE_CREDENTIALS) {
    const parsed = JSON.parse(env.FIREBASE_CREDENTIALS) as Record<string, unknown>;
    if (typeof parsed.project_id !== "string" || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
      throw new Error("Invalid Firebase credentials.");
    }
    serviceAccount = { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key };
  }
  const projectId = env.FIREBASE_PROJECT_ID || serviceAccount?.projectId;
  if (!projectId || (serviceAccount && serviceAccount.projectId !== projectId)) {
    throw new Error("Firebase project configuration is missing or inconsistent.");
  }
  return initializeApp({ projectId, credential: serviceAccount ? cert(serviceAccount) : applicationDefault() }, APP_NAME);
}

export class FirebasePushSender implements PushSender {
  constructor(private readonly messaging: Pick<Messaging, "send">) {}

  async send(token: string, messageId: string, ttlMs: number): Promise<void> {
    try {
      await this.messaging.send({
        token,
        data: { KEY_MESSAGE_ID: messageId },
        // Match upstream's data-only wake-up. No SMS content is included in FCM.
        android: { priority: "normal", ttl: Math.max(0, ttlMs) },
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "push_unavailable";
      const permanent = [
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token",
        "messaging/mismatched-credential",
        "messaging/invalid-argument",
      ].includes(code);
      // Only retain a known category; third-party messages may contain device secrets.
      throw new PushError(permanent, permanent ? "device_registration_invalid" : "push_unavailable");
    }
  }
}

let gateway: Gateway | undefined;

export function runtimeGateway(): Gateway {
  if (gateway) return gateway;
  const app = firebaseApp();
  // The REST fallback requests ADC even for local emulation. gRPC's insecure
  // emulator channel needs no credentials; production keeps the lighter REST path.
  const database = initializeFirestore(app, { preferRest: !process.env.FIRESTORE_EMULATOR_HOST });
  const push: PushSender = process.env.GATEWAY_MOCK_PUSH === "true"
    ? { send: async (_token, messageId) => { console.info(JSON.stringify({ event: "mock_phone_wakeup", message_id: messageId })); } }
    : new FirebasePushSender(getMessaging(app));
  gateway = new Gateway(new FirestoreStore(database), readConfig(), push);
  return gateway;
}
