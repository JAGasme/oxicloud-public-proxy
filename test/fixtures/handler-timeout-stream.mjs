// Child-process repro for GHSA-3qgw-9275-xf8w: a streaming reply that has
// sent its headers but is still open when handlerTimeout fires. Vulnerable
// fastify (< 5.12.8) throws ERR_HTTP_HEADERS_SENT and the process dies; a
// patched one keeps serving. Run out of process so a crash cannot take the
// test runner down with it. Prints "SURVIVED" on success.
import { Readable } from "node:stream";
import Fastify from "fastify";

const app = Fastify({ handlerTimeout: 50 });

app.get("/stall", (_req, reply) => {
  const body = new Readable({ read() {} });
  body.push("first chunk\n");
  // Never ends: the response stays open past the timeout.
  return reply.type("text/plain").send(body);
});
app.get("/ping", async () => "pong");

await app.listen({ host: "127.0.0.1", port: 0 });
const { port } = app.server.address();
const base = `http://127.0.0.1:${port}`;

const ac = new AbortController();
const res = await fetch(`${base}/stall`, { signal: ac.signal });
const reader = res.body.getReader();
await reader.read(); // headers and the first chunk are on the wire
await new Promise((r) => setTimeout(r, 300)); // well past handlerTimeout
ac.abort();

const ping = await fetch(`${base}/ping`);
if (ping.status !== 200 || (await ping.text()) !== "pong") {
  console.error(`ping after stalled stream: ${ping.status}`);
  process.exit(2);
}
await app.close();
console.log("SURVIVED");
