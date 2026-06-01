import { describe, expect, it } from 'vitest';
import {
  createAttribute,
  createClass,
  createEmptyModel,
  createOperation,
  createParameter,
  createRelationship,
  createState,
  createStateMachine,
  createTransition,
  validateModel
} from './index.js';

describe('createEmptyModel', () => {
  it('produces a model with exactly the root package', () => {
    const m = createEmptyModel();
    expect(m.schemaVersion).toBe(1);
    expect(Object.keys(m.elements)).toHaveLength(1);
    const root = m.elements[m.rootPackageId];
    expect(root.kind).toBe('Package');
    expect(root.ownerId).toBeNull();
  });

  it('validates clean', () => {
    expect(validateModel(createEmptyModel())).toEqual([]);
  });
});

describe('validateModel', () => {
  it('passes for a small but realistic model', () => {
    const m = createEmptyModel();
    const cls = createClass('Order', m.rootPackageId);
    m.elements[cls.id] = cls;

    const attr = createAttribute('id', cls.id, 'string', 'private');
    m.elements[attr.id] = attr;

    const op = createOperation('submit', cls.id, 'public', 'void');
    const p = createParameter('reason', op.id, 'string');
    op.parameterIds.push(p.id);
    m.elements[op.id] = op;
    m.elements[p.id] = p;

    const sm = createStateMachine(cls.id);
    cls.stateMachineId = sm.id;
    m.elements[sm.id] = sm;

    const draft = createState('Draft', sm.id, 'Initial');
    const submitted = createState('Submitted', sm.id);
    sm.topStateIds.push(draft.id, submitted.id);
    m.elements[draft.id] = draft;
    m.elements[submitted.id] = submitted;

    const t = createTransition(sm.id, draft.id, submitted.id);
    t.trigger = 'submit()';
    m.elements[t.id] = t;

    const cls2 = createClass('Customer', m.rootPackageId);
    m.elements[cls2.id] = cls2;
    const rel = createRelationship(
      'Association',
      cls.id,
      cls2.id,
      m.rootPackageId
    );
    m.elements[rel.id] = rel;

    expect(validateModel(m)).toEqual([]);
  });

  it('flags dangling references', () => {
    const m = createEmptyModel();
    const cls = createClass('Order', m.rootPackageId);
    m.elements[cls.id] = cls;
    cls.stateMachineId = 'does-not-exist';

    const op = createOperation('submit', cls.id);
    op.parameterIds.push('also-missing');
    m.elements[op.id] = op;

    const issues = validateModel(m);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.every(i => i.severity === 'error')).toBe(true);
    expect(
      issues.some(i => i.message.includes('missing state machine'))
    ).toBe(true);
    expect(
      issues.some(i => i.message.includes('missing parameter'))
    ).toBe(true);
  });

  it('rejects duplicate class names in the same package', () => {
    const m = createEmptyModel();
    const c1 = createClass('Order', m.rootPackageId);
    const c2 = createClass('Order', m.rootPackageId);
    m.elements[c1.id] = c1;
    m.elements[c2.id] = c2;
    const issues = validateModel(m);
    expect(issues.some(i => i.message.includes('Duplicate classifier name'))).toBe(true);
  });

  it('flags an owner pointing at a missing parent', () => {
    const m = createEmptyModel();
    const cls = createClass('Orphan', 'nope');
    m.elements[cls.id] = cls;
    const issues = validateModel(m);
    expect(issues.some(i => i.message.includes('missing owner'))).toBe(true);
  });
});
