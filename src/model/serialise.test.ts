import { describe, expect, it } from 'vitest';
import {
  createAttribute,
  createClass,
  createEmptyModel,
  createOperation
} from './index.js';
import { collectDescendants, serialiseModel } from './serialise.js';

describe('serialiseModel', () => {
  it('emits keys in a deterministic order', () => {
    const m = createEmptyModel();
    const cls = createClass('Order', m.rootPackageId);
    m.elements[cls.id] = cls;
    const op = createOperation('submit', cls.id);
    m.elements[op.id] = op;
    const attr = createAttribute('id', cls.id);
    m.elements[attr.id] = attr;

    const a = serialiseModel(m);
    const b = serialiseModel(m);
    expect(a).toBe(b);

    // Element id order in the output should be the sorted id order.
    const sortedIds = Object.keys(m.elements).sort();
    const parsed = JSON.parse(a);
    expect(Object.keys(parsed.elements)).toEqual(sortedIds);

    // Per-element key order should start with id, kind, ownerId, name.
    const firstKeys = Object.keys(parsed.elements[sortedIds[0]]).slice(0, 4);
    expect(firstKeys).toEqual(['id', 'kind', 'ownerId', 'name']);
  });

  it('round-trips through JSON.parse', () => {
    const m = createEmptyModel();
    const cls = createClass('Order', m.rootPackageId);
    m.elements[cls.id] = cls;

    const text = serialiseModel(m);
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.rootPackageId).toBe(m.rootPackageId);
    expect(parsed.elements[cls.id].name).toBe('Order');
  });
});

describe('collectDescendants', () => {
  it('returns the root and all descendants', () => {
    const m = createEmptyModel();
    const cls = createClass('Order', m.rootPackageId);
    m.elements[cls.id] = cls;
    const op = createOperation('submit', cls.id);
    m.elements[op.id] = op;
    const attr = createAttribute('id', cls.id);
    m.elements[attr.id] = attr;

    const ids = collectDescendants(m, cls.id).sort();
    expect(ids).toEqual([cls.id, op.id, attr.id].sort());
  });

  it('returns empty when the root id is missing', () => {
    const m = createEmptyModel();
    expect(collectDescendants(m, 'no-such-id')).toEqual([]);
  });
});
