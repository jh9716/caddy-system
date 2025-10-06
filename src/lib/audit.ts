export async function logAudit(params: { action: string; meta?: any }) {
  try {
    console.log('[AUDIT]', params.action, params.meta ?? null);
  } catch {
    // ignore
  }
}
