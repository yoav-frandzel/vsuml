/**
 * Pure helpers for model persistence — extracted so they can be unit tested
 * without depending on the `vscode` module.
 */

import type { ElementId, ModelElement, ModelFile } from './types.js';

/**
 * Serialise the model with stable key ordering so saves produce minimal git
 * diffs. Element ids are sorted; each element's keys are emitted in a fixed
 * order regardless of insertion order.
 */
export function serialiseModel(model: ModelFile): string {
  const sortedIds = Object.keys(model.elements).sort();
  const elements: Record<string, ModelElement> = {};
  for (const id of sortedIds) {
    elements[id] = sortElementKeys(model.elements[id]);
  }
  const out = {
    schemaVersion: model.schemaVersion,
    rootPackageId: model.rootPackageId,
    elements
  };
  return JSON.stringify(out, null, 2) + '\n';
}

/** Fixed property order per element kind so JSON diffs are stable. */
function sortElementKeys(el: ModelElement): ModelElement {
  const preferred = ['id', 'kind', 'ownerId', 'name'];
  const src = el as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of preferred) {
    if (k in src) out[k] = src[k];
  }
  const remaining = Object.keys(src)
    .filter(k => !preferred.includes(k))
    .sort();
  for (const k of remaining) {
    out[k] = src[k];
  }
  return out as unknown as ModelElement;
}

/** All descendant ids of `rootId` in containment order (including rootId). */
export function collectDescendants(
  model: ModelFile,
  rootId: ElementId
): ElementId[] {
  const result: ElementId[] = [];
  const stack: ElementId[] = [rootId];
  const seen = new Set<ElementId>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!model.elements[id]) continue;
    result.push(id);
    for (const el of Object.values(model.elements)) {
      if (el.ownerId === id) stack.push(el.id);
    }
  }
  return result;
}
