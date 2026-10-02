import { privatePhotoCacheHeaders } from "@/lib/privatePhotoCache";

export type PhotoObjectBody = ReadableStream<Uint8Array> | Uint8Array;

export function photoObjectToResponseBody(body: PhotoObjectBody): BodyInit {
  if (body instanceof ReadableStream) return body;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

export function privatePhotoBodyHeaders(
  etag: string,
  mimeType: string,
  size: number,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    ...privatePhotoCacheHeaders(etag, mimeType),
    "Content-Length": String(size),
    ...extra,
  };
}

export function formatPhotoServerTiming(parts: Record<string, number>): string {
  return Object.entries(parts)
    .map(([name, dur]) => `${name};dur=${Math.max(0, dur).toFixed(1)}`)
    .join(", ");
}
