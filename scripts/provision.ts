import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest } from "../src/gateway/auth.js";
import { runtimeGateway } from "../src/gateway/firebase.js";
import type { Application, Device, Principal } from "../src/gateway/types.js";
import { identifier, parse, phoneNumber } from "../src/gateway/validation.js";

const { values } = parseArgs({ options: {
  app: { type: "string" }, device: { type: "string", default: "primary-phone" },
  phone: { type: "string" }, sim: { type: "string", default: "SIM1" },
  "app-limit": { type: "string", default: "10" },
  "device-limit": { type: "string", default: "3" },
  out: { type: "string" }, help: { type: "boolean" },
} });

if (values.help) {
  console.info("Usage: npm run provision -- --app notifications --phone +639171234567 [--device primary-phone] [--sim SIM1] [--app-limit 10] [--device-limit 3] [--out gateway-credentials-notifications.json]\nTo add another application to an existing device, pass --app and --device. Phone and SIM identity cannot be changed by provisioning.");
} else {
  try {
    const appId = parse(identifier, values.app);
    const deviceId = parse(identifier, values.device);
    const phone = values.phone ? parse(phoneNumber, values.phone) : undefined;
    if (values.sim !== "SIM1" && values.sim !== "SIM2") throw new Error("Use SIM1 or SIM2.");
    const sim = values.sim;
    const appLimit = Number(values["app-limit"]);
    const deviceLimit = Number(values["device-limit"]);
    if (![appLimit, deviceLimit].every((number) => Number.isSafeInteger(number) && number >= 1 && number <= 1000)) {
      throw new Error("Rate limits must be integers from 1 to 1000.");
    }
    const gateway = runtimeGateway();
    const existingDevice = await gateway.store.get<Device>(gateway.path("devices", deviceId));
    if (!existingDevice && !phone) throw new Error("A new device requires --phone.");
    if (existingDevice && (phone && phone !== existingDevice.phone_number)) throw new Error("Device identity cannot be changed.");
    if (existingDevice && !existingDevice.active) throw new Error("The target device is disabled.");
    const appKey = randomBytes(32).toString("hex");
    const deviceKey = existingDevice ? null : randomBytes(32).toString("hex");
    const output = resolve(values.out || `gateway-credentials-${appId}.json`);
    // Save keys privately before the remote write. Keep them if the write's outcome
    // is uncertain; deleting them could make a committed registration unrecoverable.
    await writeFile(output, `${JSON.stringify({
      application_id: appId, application_api_key: appKey, device_id: deviceId,
      device_api_key: deviceKey,
      phone_number: existingDevice?.phone_number || phone,
      sim: existingDevice?.sim || sim,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const timestamp = new Date().toISOString();
    await gateway.store.transaction(async (tx) => {
      const application = await tx.get<Application>(gateway.path("applications", appId));
      const device = await tx.get<Device>(gateway.path("devices", deviceId));
      if (application) throw new Error("Application already exists.");
      if (Boolean(device) !== Boolean(existingDevice)) throw new Error("Device provisioning changed concurrently.");
      if (device && existingDevice && (!device.active || device.phone_number !== existingDevice.phone_number || device.sim !== existingDevice.sim)) {
        throw new Error("Device provisioning changed concurrently.");
      }
      const nextApp: Application = { id: appId, device_id: deviceId, active: true, messages_per_minute: appLimit };
      const appPrincipal: Principal = { id: appId, kind: "application", active: true };
      tx.set(gateway.path("applications", appId), nextApp);
      tx.set(gateway.path("keys", digest(appKey)), appPrincipal);
      if (!device) {
        const nextDevice: Device = {
          id: deviceId, user_id: deviceId, phone_number: phone!, sim, active: true,
          messages_per_minute: deviceLimit, fcm_token: null,
          last_seen_at: null, charging: null, updated_at: timestamp,
        };
        const devicePrincipal: Principal = { id: deviceId, kind: "device", active: true };
        tx.set(gateway.path("devices", deviceId), nextDevice);
        tx.set(gateway.path("keys", digest(deviceKey!)), devicePrincipal);
      }
    });
    console.info(`Provisioned application ${appId}. Credentials are saved privately in ${output}. Enter the device key in the Android app; keep the application key in your application's backend.`);
  } catch {
    console.error("Provisioning did not finish. Check arguments, existing registrations, and Firebase access. If a credentials file was created, retain it and inspect Firestore before retrying; it may contain keys for a completed remote write. Existing files are never overwritten.");
    process.exitCode = 1;
  }
}
