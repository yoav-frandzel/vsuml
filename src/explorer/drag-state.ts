/**
 * Cross-boundary drag state for Model Explorer → webview drops.
 *
 * VS Code's TreeView DataTransfer payload does not reliably cross the
 * webview iframe boundary, so we keep the active drag's element ids in
 * the extension host and have the webview ping us on drop.
 */

let pendingIds: readonly string[] = [];
let pendingTs = 0;

const STALENESS_MS = 30_000;

export function setPendingDrag(ids: readonly string[]): void {
  pendingIds = ids;
  pendingTs = Date.now();
}

export function consumePendingDrag(): readonly string[] {
  if (pendingIds.length === 0) return [];
  if (Date.now() - pendingTs > STALENESS_MS) {
    pendingIds = [];
    return [];
  }
  const result = pendingIds;
  pendingIds = [];
  return result;
}

export function peekPendingDrag(): readonly string[] {
  return pendingIds;
}
