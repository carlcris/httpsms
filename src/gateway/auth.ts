import { createHash } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { Store } from "./store.js";
import type { Principal } from "./types.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function authenticate(request: Request, store: Store, prefix: string): Promise<Principal> {
  const key = request.headers.get("x-api-key");
  if (!key || key.length < 32 || key.length > 256) {
    throw new GatewayError(401, "A valid x-api-key is required.");
  }
  const principal = await store.get<Principal>(`${prefix}_keys/${digest(key)}`);
  if (!principal?.active || !["application", "device"].includes(principal.kind) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(principal.id)) {
    throw new GatewayError(401, "A valid x-api-key is required.");
  }
  return principal;
}
