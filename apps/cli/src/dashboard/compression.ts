import type http from "node:http";
import { gzipSync } from "node:zlib";

const EVENT_STREAM = /^\s*text\/event-stream\b/iu;

/** The content type a writeHead call declares, from its headers object or
 * raw [name, value, ...] list, else whatever setHeader already stored. */
function declaredContentType(response: http.ServerResponse, args: unknown[]): string {
  for (const item of args) {
    if (Array.isArray(item)) {
      for (let index = 0; index + 1 < item.length; index += 2) {
        if (String(item[index]).toLowerCase() === "content-type") return String(item[index + 1]);
      }
    } else if (item && typeof item === "object") {
      for (const [name, value] of Object.entries(item)) if (name.toLowerCase() === "content-type") return String(value);
    }
  }
  return String(response.getHeader("content-type") ?? "");
}

/** Gzip a GET response's final body when the client accepts gzip. Only the
 * body passed to end() is compressed, so a response streamed with write() -
 * an event stream, or any write before headers are sent - keeps no gzip label
 * and goes out as plain text. */
export function configureDashboardCompression(request: http.IncomingMessage, response: http.ServerResponse): void {
  if (request.method !== "GET" || !/\bgzip\b/u.test(request.headers["accept-encoding"] ?? "")) return;

  response.setHeader("content-encoding", "gzip");
  let compress = true;
  const stopCompressing = (): void => {
    compress = false;
    if (!response.headersSent) response.removeHeader("content-encoding");
  };

  const originalWriteHead = response.writeHead.bind(response) as (...args: unknown[]) => http.ServerResponse;
  response.writeHead = ((...args: unknown[]) => {
    if (compress && EVENT_STREAM.test(declaredContentType(response, args.slice(1)))) stopCompressing();
    return originalWriteHead(...args);
  }) as typeof response.writeHead;

  const originalWrite = response.write.bind(response) as (...args: unknown[]) => boolean;
  response.write = ((...args: unknown[]) => {
    if (compress && !response.headersSent) stopCompressing();
    return originalWrite(...args);
  }) as typeof response.write;

  const originalEnd = response.end.bind(response);
  response.end = ((chunk?: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
    if (!compress) return originalEnd(chunk as never, encodingOrCallback as never, callback as never);
    if (chunk === undefined) return originalEnd(callback ?? (typeof encodingOrCallback === "function" ? encodingOrCallback : undefined));
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const body = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    return originalEnd(gzipSync(body, { level: 4 }), done);
  }) as typeof response.end;
}
