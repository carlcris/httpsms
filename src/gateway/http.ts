import { randomUUID } from "node:crypto";
import { authenticate } from "./auth.js";
import { GatewayError } from "./errors.js";
import { Gateway, publicMessage } from "./gateway.js";
import { eventSchema, heartbeatSchema, messageId, parse, readJson, registerSchema, requestId, sendSchema } from "./validation.js";

export function json(data: unknown, message: string, statusCode = 200, additionalHeaders: Record<string, string> = {}): Response {
  return Response.json({ status: statusCode >= 400 ? "error" : "success", message, data }, {
    status: statusCode,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...additionalHeaders },
  });
}

export function errorResponse(error: unknown, requestTraceId: string): Response {
  if (error instanceof GatewayError) {
    return json(null, error.message, error.statusCode, {
      "x-request-id": requestTraceId,
      ...(error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}),
    });
  }
  // Never log raw Firebase errors, request bodies, phone numbers, keys, or FCM tokens.
  console.error(JSON.stringify({ event: "gateway_request_failed", request_id: requestTraceId }));
  return json(null, "The gateway is temporarily unavailable.", 503, { "x-request-id": requestTraceId });
}

export function createHandler(gateway: Gateway): (request: Request) => Promise<Response> {
  return async (request) => {
    const traceId = randomUUID();
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        return json({ service: "sms-gateway" }, "Gateway is running.");
      }
      const principal = await authenticate(request, gateway.store, gateway.config.collectionPrefix);
      if (path === "/v1/messages/send" && request.method === "POST") {
        if (principal.kind !== "application") throw new GatewayError(403, "An application API key is required.");
        const input = parse(sendSchema, await readJson(request));
        const headerKey = request.headers.get("idempotency-key");
        if (headerKey && input.request_id && headerKey !== input.request_id) {
          throw new GatewayError(422, "Idempotency-Key and request_id must match.");
        }
        const key = parse(requestId, headerKey ?? input.request_id);
        const result = await gateway.send(principal, input, key);
        // Await the wake-up attempt; never rely on work running after the HTTP response.
        // Acceptance remains durable even if the immediate attempt fails; the sweep recovers it.
        try {
          await gateway.dispatch(result.message.id);
        } catch {
          console.error(JSON.stringify({ event: "gateway_dispatch_deferred", request_id: traceId, message_id: result.message.id }));
        }
        return json(publicMessage(result.message), "Message accepted.", 202, {
          location: `/v1/messages/${result.message.id}`,
          "idempotency-replayed": String(result.replayed),
          "x-request-id": traceId,
        });
      }
      if (path === "/v1/phones/fcm-token" && request.method === "PUT") {
        const device = await gateway.register(principal, parse(registerSchema, await readJson(request)));
        return json({ id: device.id, user_id: device.user_id }, "FCM token updated successfully.");
      }
      if (path === "/v1/heartbeats" && request.method === "POST") {
        await gateway.heartbeat(principal, parse(heartbeatSchema, await readJson(request)));
        return json(null, "Heartbeat stored successfully.");
      }
      if (path === "/v1/messages/outstanding" && request.method === "GET") {
        const id = parse(messageId, new URL(request.url).searchParams.get("message_id"));
        return json(publicMessage(await gateway.claim(principal, id)), "Outstanding message fetched successfully.");
      }
      const eventMatch = /^\/v1\/messages\/([^/]+)\/events$/.exec(path);
      if (eventMatch && request.method === "POST") {
        const parts = eventMatch[1]!.split(".");
        const id = parse(messageId, parts[0]);
        if (parts.length > 2 || (parts.length === 2 && !/^\d{1,6}$/.test(parts[1]!))) {
          throw new GatewayError(422, "Invalid message ID.");
        }
        const input = parse(eventSchema, await readJson(request));
        const message = await gateway.report(principal, id, input, parts.length === 2);
        if (parts.length === 2) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        return json(publicMessage(message), "Message event stored successfully.");
      }
      const messageMatch = /^\/v1\/messages\/([^/]+)$/.exec(path);
      if (messageMatch && request.method === "GET") {
        return json(publicMessage(await gateway.getMessage(principal, parse(messageId, messageMatch[1]))), "Message fetched successfully.");
      }
      // The unchanged Android app may forward inbound SMS and missed calls. Explicitly
      // decline them so its workers stop retrying, without persisting their contents.
      if (["/v1/messages/receive", "/v1/messages/calls/missed"].includes(path) && request.method === "POST") {
        if (principal.kind !== "device") throw new GatewayError(403, "A device API key is required.");
        return json(null, "Incoming notifications are disabled on this gateway.", 410);
      }
      throw new GatewayError(404, "Endpoint not found.");
    } catch (error) {
      return errorResponse(error, traceId);
    }
  };
}
