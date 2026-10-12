import type { GatewayConfig } from "./types.js";

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error("Invalid gateway configuration.");
  }
  return number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const collectionPrefix = env.GATEWAY_COLLECTION_PREFIX || "sms_gateway";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(collectionPrefix)) {
    throw new Error("Invalid collection prefix.");
  }
  return {
    collectionPrefix,
    messageTTLSeconds: positiveInteger(env.GATEWAY_MESSAGE_TTL_SECONDS, 300, 86400),
    dispatchIntervalSeconds: positiveInteger(env.GATEWAY_DISPATCH_INTERVAL_SECONDS, 60, 3600),
    sweepBatchSize: positiveInteger(env.GATEWAY_SWEEP_BATCH_SIZE, 5, 10),
  };
}
