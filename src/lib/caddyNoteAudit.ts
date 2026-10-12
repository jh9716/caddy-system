/** Audit rows reused as caddy notes. Delete must stay scoped to this shape. */

export const CADDY_NOTE_ACTION = "CADDY_NOTE";
export const CADDY_NOTE_ENTITY = "Caddy";

export function caddyNoteDeleteWhere(caddyId: number, noteId: number) {
  return {
    id: noteId,
    entity: CADDY_NOTE_ENTITY,
    entityId: caddyId,
    action: CADDY_NOTE_ACTION,
  };
}
