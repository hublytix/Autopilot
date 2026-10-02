import 'server-only';

// Reading a request body with a hard size limit (PLAN §10, D-82). `req.arrayBuffer()`/`req.text()`
// read the whole body before any size check, and a chunked request has no Content-Length to refuse
// early, so an anonymous client could make the function buffer bodies up to the platform's limit
// (4.5 MB on Vercel; unbounded under `next start`) on every request to a route that runs before any
// signature check. This reads the stream chunk by chunk, counts bytes, and cancels it as soon as the
// limit is passed. A declared Content-Length over the limit is refused without reading at all.

export type BoundedBody = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false };

export async function readBoundedBody(req: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > maxBytes) return { ok: false };
  if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** The bounded body as UTF-8 text (invalid sequences replaced, as `req.text()` does), or null when too large. */
export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const body = await readBoundedBody(req, maxBytes);
  return body.ok ? new TextDecoder('utf-8').decode(body.bytes) : null;
}
