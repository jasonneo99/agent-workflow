import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { configureDashboardCompression } from "./compression.js";
import { dashboardSource, functionSource } from "./test-source.js";

type Handler = (response: http.ServerResponse) => void;

/** Serve one request through the wrapper and return the raw, undecoded reply. */
async function fetchRaw(handler: Handler, options: { method?: string; acceptEncoding?: string } = {}) {
  const server = http.createServer((request, response) => { configureDashboardCompression(request, response); handler(response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, method: options.method ?? "GET",
        headers: { "accept-encoding": options.acceptEncoding ?? "gzip, deflate, br" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
      request.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const sseEvents = (response: http.ServerResponse, headers: http.OutgoingHttpHeaders | string[]) => {
  response.writeHead(200, headers as http.OutgoingHttpHeaders);
  response.write("event: refresh\ndata: {\"n\":1}\n\n");
  response.write("event: refresh\ndata: {\"n\":2}\n\n");
  response.end();
};

test("an event stream is not labelled gzip and reads as plain text", async () => {
  for (const headers of [
    { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
    { "Content-Type": "text/event-stream" },
    ["Content-Type", "text/event-stream; charset=utf-8"]
  ]) {
    const { headers: received, body } = await fetchRaw(response => sseEvents(response, headers));
    assert.equal(received["content-encoding"], undefined, JSON.stringify(headers));
    assert.equal(body.toString("utf8"), "event: refresh\ndata: {\"n\":1}\n\nevent: refresh\ndata: {\"n\":2}\n\n");
  }
});

test("an event stream typed with setHeader before writeHead is not labelled gzip", async () => {
  const { headers, body } = await fetchRaw(response => {
    response.setHeader("content-type", "text/event-stream");
    response.writeHead(200);
    response.write("data: one\n\n");
    response.end("data: two\n\n");
  });
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(body.toString("utf8"), "data: one\n\ndata: two\n\n");
});

test("a body streamed with write before headers are sent is not labelled gzip", async () => {
  const { headers, body } = await fetchRaw(response => { response.setHeader("content-type", "text/plain"); response.write("a"); response.end("b"); });
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(body.toString("utf8"), "ab");
});

test("a page or JSON body sent with end is still gzipped and decodes", async () => {
  const page = "<!doctype html><p>dashboard</p>".repeat(20);
  const html = await fetchRaw(response => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); });
  assert.equal(html.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(html.body).toString("utf8"), page);
  const json = await fetchRaw(response => { response.setHeader("content-type", "application/json"); response.end(Buffer.from("{\"ok\":true}")); });
  assert.equal(json.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(json.body).toString("utf8"), "{\"ok\":true}");
});

test("clients without gzip and non-GET requests get plain bodies", async () => {
  const plain = await fetchRaw(response => response.end("hello"), { acceptEncoding: "identity" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), "hello");
  const post = await fetchRaw(response => response.end("hello"), { method: "POST" });
  assert.equal(post.headers["content-encoding"], undefined);
  assert.equal(post.body.toString("utf8"), "hello");
});

test("the dashboard server applies this compression to every request", () => {
  const configure = functionSource("configureDashboardResponse", dashboardSource());
  assert.match(configure, /configureDashboardCompression\(request, response\)/u);
  assert.doesNotMatch(configure, /gzipSync/u);
});
