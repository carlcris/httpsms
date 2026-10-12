import { createServer } from "node:http";
import handler from "../netlify/functions/api.js";

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 16 * 1024) {
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const method = incoming.method || "GET";
    const response = await handler(new Request(`http://localhost:8888${incoming.url || "/"}`, {
      method, headers,
      ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(503).end();
  }
});

server.listen(8888, "127.0.0.1", () => console.info("Gateway listening at http://localhost:8888. Recovery sweeps are scheduled by Netlify in production."));
