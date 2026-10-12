import type { Config } from "@netlify/functions";
import { runtimeGateway } from "../../src/gateway/firebase.js";

export default async function handler(): Promise<Response> {
  const result = await runtimeGateway().sweep();
  console.info(JSON.stringify({ event: "gateway_sweep", ...result }));
  if (result.errors) throw new Error("Some pending dispatches could not be processed.");
  return new Response(null, { status: 204 });
}

// Netlify scheduled functions execute only on published production deploys and do
// not expose a public HTTP endpoint. Keep each invocation a bounded batch.
export const config: Config = { schedule: "* * * * *" };
