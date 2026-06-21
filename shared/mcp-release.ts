/**
 * Pure helpers for the MCP tab's "enable for chat" flow.
 *
 * Side-effect-free so the toggle math + the draft/publish decision are
 * unit-tested without a DOM or network (per the repo's extract-pure-functions
 * practice). The DOM/network wiring lives in entrypoints/content.ts.
 *
 * Server contract this mirrors (public-api /api/v1/releases):
 *   - enabledMcpServerIds is writable only on a `draft` release (PATCH
 *     /:id update-draft throws LOCKED otherwise).
 *   - a published release is made editable by POST /:id/fork (forkReleaseAsDraft),
 *     which now carries enabledMcpServerIds/enabledSkillIds over to the draft.
 *   - the draft goes live via POST /:id/publish.
 */

/** Add or remove an id, de-duplicated, append-on-add for stable order. */
export function toggleMcpId(ids: readonly string[], id: string, on: boolean): string[] {
  const without = ids.filter((x) => x !== id);
  return on ? [...without, id] : without;
}

/**
 * What must happen before we can write enabledMcpServerIds on a release:
 *   - 'edit'  : it's a draft → PATCH it in place.
 *   - 'fork'  : it's published/other → POST /:id/fork to get an editable draft
 *               first (enabledMcpServerIds is draft-only server-side).
 */
export function releaseEditAction(status: string | undefined): "edit" | "fork" {
  return status === "draft" ? "edit" : "fork";
}

/**
 * Title for a fork. The model rejects a fork whose title equals the parent's,
 * so we always derive a distinct one.
 */
export function forkTitleFor(parentTitle: string | undefined): string {
  const base = (parentTitle || "Release").trim() || "Release";
  return `${base} (MCP edit)`;
}
