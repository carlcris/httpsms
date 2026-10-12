import { z } from "zod";
import { GatewayError } from "./errors.js";

export const phoneNumber = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const messageId = z.uuid();
export const requestId = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);

export const sendSchema = z.object({
  to: phoneNumber,
  content: z.string().min(1).max(1600).refine((value) => value.trim().length > 0),
  from: phoneNumber.optional(),
  request_id: requestId.optional(),
}).strict();

export const registerSchema = z.object({
  phone_number: phoneNumber,
  sim: z.enum(["SIM1", "SIM2"]),
  fcm_token: z.string().min(1).max(4096).refine((value) => value.trim() === value && !/\s/.test(value)),
}).strict();

export const eventSchema = z.object({
  event_name: z.enum(["SENT", "DELIVERED", "FAILED"]),
  // Android sends RFC3339 timestamps with nine fractional digits and an offset.
  timestamp: z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
  reason: z.string().max(500).nullable().optional(),
}).strict();

export const heartbeatSchema = z.object({
  phone_numbers: z.array(phoneNumber).min(1).max(2),
  charging: z.boolean(),
}).strict();

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GatewayError(422, "Invalid request payload.");
  return result.data;
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new GatewayError(415, "Use Content-Type: application/json.");
  }
  const limit = 16 * 1024;
  const declaredSize = Number(request.headers.get("content-length"));
  if (declaredSize > limit) throw new GatewayError(413, "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new GatewayError(413, "Request body is too large.");
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayError(400, "Request body must contain valid JSON.");
  }
}
