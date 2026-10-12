import { randomUUID } from "node:crypto";
import type { Config } from "@netlify/functions";
import { runtimeGateway } from "../../src/gateway/firebase.js";
import { createHandler, errorResponse, json } from "../../src/gateway/http.js";

export default async function handler(request: Request): Promise<Response> {
  // Liveness does not initialize Firebase or reveal configuration values.
  if (new URL(request.url).pathname === "/health" && request.method === "GET") {
    return json({ service: "sms-gateway" }, "Gateway is running.");
  }
  try {
    const response = await createHandler(runtimeGateway())(request);
    const source = process.env.SOURCE_CODE_URL;
    if (source && /^https:\/\/[^\s<>]+$/.test(source)) response.headers.set("link", `<${source}>; rel="source"`);
    return response;
  } catch (error) {
    return errorResponse(error, randomUUID());
  }
}

export const config: Config = { path: ["/v1/*", "/health"] };
