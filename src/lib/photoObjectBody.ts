import { privatePhotoCacheHeaders } from "@/lib/privatePhotoCache";

export type PhotoObjectBody = ReadableStream<Uint8Array> | Uint8Array;

export function photoObjectToResponseBody(body: PhotoObjectBody): BodyInit {
  if (body instanceof ReadableStream) return body;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

export function privatePhotoBodyHeaders(
  etag: string,
  mimeType: string,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    ...privatePhotoCacheHeaders(etag, mimeType),
    ...extra,
  };
}

/**
 * Content-Length only when the body length is already known.
 * Do not use DB size for streams: a short/failed Blob would hang the client.
 */
export function privatePhotoStreamHeaders(
  etag: string,
  mimeType: string,
  body: PhotoObjectBody,
  extra?: Record<string, string>
): Record<string, string> {
  const headers = privatePhotoBodyHeaders(etag, mimeType, extra);
  if (body instanceof Uint8Array) {
    headers["Content-Length"] = String(body.byteLength);
  }
  return headers;
}

export function formatPhotoServerTiming(parts: Record<string, number>): string {
  return Object.entries(parts)
    .map(([name, dur]) => `${name};dur=${Math.max(0, dur).toFixed(1)}`)
    .join(", ");
}
