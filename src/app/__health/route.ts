// src/app/__health/route.ts
export async function GET() {
  return new Response(`ok ${Date.now()}`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
