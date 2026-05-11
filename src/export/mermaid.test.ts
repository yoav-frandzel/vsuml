/**
 * Smoke tests for the Mermaid serializers. We don't try to exactly match
 * Mermaid syntax — we just want to confirm the right shapes appear so the
 * exported text is recognisably the diagram we requested.
 */

import { describe, expect, it } from 'vitest';
import { diagramToMermaid } from './mermaid.js';
import {
  createEmptyModel,
  createAttribute,
  createClass,
  createInterface,
  createOperation,
  createRelationship,
  createState,
  createStateMachine,
  createTransition,
  type ClassDiagramFile,
  type ModelFile,
  type SequenceDiagramFile,
  type StateDiagramFile
} from '../model/index.js';

function emptyModelWithStuff(): ModelFile {
  const m = createEmptyModel();
  return m;
}

describe('diagramToMermaid (class)', () => {
  it('renders classes, interfaces, members, and relationships', () => {
    const model = emptyModelWithStuff();
    const rootId = model.rootPackageId;
    const cust = createClass('Customer', rootId);
    const ord = createClass('Order', rootId);
    const iface = createInterface('Identifiable', rootId);
    const op = createOperation('checkout', ord.id, 'public', 'boolean');
    const attr = createAttribute('total', ord.id, 'number', 'private');
    const rel = createRelationship('Association', cust.id, ord.id, rootId);
    const realization = createRelationship('Realization', ord.id, iface.id, rootId);
    for (const e of [cust, ord, iface, op, attr, rel, realization]) {
      model.elements[e.id] = e;
    }
    const diagram: ClassDiagramFile = {
      schemaVersion: 1,
      kind: 'ClassDiagram',
      name: 'd',
      nodes: [
        { id: 'n1', elementId: cust.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'n2', elementId: ord.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'n3', elementId: iface.id, x: 0, y: 0, width: 0, height: 0 }
      ],
      edges: [
        { id: 'e1', elementId: rel.id, sourceNodeId: 'n1', targetNodeId: 'n2' },
        { id: 'e2', elementId: realization.id, sourceNodeId: 'n2', targetNodeId: 'n3' }
      ]
    };
    const out = diagramToMermaid(model, diagram);
    expect(out).toMatch(/^classDiagram/);
    expect(out).toContain('class Customer');
    expect(out).toContain('class Order');
    expect(out).toContain('<<interface>>');
    expect(out).toContain('+checkout()');
    expect(out).toContain('-total');
    expect(out).toContain('Order --> Customer');
    expect(out).toContain('Identifiable <|.. Order');
  });
});

describe('diagramToMermaid (sequence)', () => {
  it('renders participants and arrows with operation labels', () => {
    const model = emptyModelWithStuff();
    const cust = createClass('Customer', model.rootPackageId);
    const svc = createClass('OrderService', model.rootPackageId);
    const op = createOperation('placeOrder', svc.id);
    for (const e of [cust, svc, op]) model.elements[e.id] = e;
    const diagram: SequenceDiagramFile = {
      schemaVersion: 1,
      kind: 'SequenceDiagram',
      name: 'place',
      lifelines: [
        { id: 'l1', representsId: cust.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'l2', representsId: svc.id, x: 0, y: 0, width: 0, height: 0 }
      ],
      messages: [
        {
          id: 'm1',
          sourceLifelineId: 'l1',
          targetLifelineId: 'l2',
          operationId: op.id,
          kind: 'sync',
          y: 80
        },
        {
          id: 'm2',
          sourceLifelineId: 'l2',
          targetLifelineId: 'l1',
          kind: 'reply',
          y: 120,
          label: 'ok'
        }
      ]
    };
    const out = diagramToMermaid(model, diagram);
    expect(out).toMatch(/^sequenceDiagram/);
    expect(out).toContain('participant');
    expect(out).toContain('placeOrder()');
    expect(out).toMatch(/-->>.*: ok/);
  });
});

describe('diagramToMermaid (state)', () => {
  it('renders states and transitions including initial/final', () => {
    const model = emptyModelWithStuff();
    const cls = createClass('Order', model.rootPackageId);
    const sm = createStateMachine(cls.id);
    model.elements[cls.id] = { ...cls, stateMachineId: sm.id };
    model.elements[sm.id] = sm;
    const initial = createState('initial', sm.id, 'Initial');
    const draft = createState('Draft', sm.id, 'Simple');
    const placed = createState('Placed', sm.id, 'Simple');
    const fin = createState('final', sm.id, 'Final');
    const t1 = createTransition(sm.id, initial.id, draft.id);
    const t2 = createTransition(sm.id, draft.id, placed.id);
    t2.trigger = 'submit';
    t2.guard = 'isValid';
    const t3 = createTransition(sm.id, placed.id, fin.id);
    for (const e of [initial, draft, placed, fin, t1, t2, t3]) {
      model.elements[e.id] = e;
    }
    const diagram: StateDiagramFile = {
      schemaVersion: 1,
      kind: 'StateDiagram',
      name: 'order-states',
      ownerClassId: cls.id,
      stateMachineId: sm.id,
      nodes: [
        { id: 'n1', elementId: initial.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'n2', elementId: draft.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'n3', elementId: placed.id, x: 0, y: 0, width: 0, height: 0 },
        { id: 'n4', elementId: fin.id, x: 0, y: 0, width: 0, height: 0 }
      ],
      edges: [
        { id: 'e1', elementId: t1.id, sourceNodeId: 'n1', targetNodeId: 'n2' },
        { id: 'e2', elementId: t2.id, sourceNodeId: 'n2', targetNodeId: 'n3' },
        { id: 'e3', elementId: t3.id, sourceNodeId: 'n3', targetNodeId: 'n4' }
      ]
    };
    const out = diagramToMermaid(model, diagram);
    expect(out).toMatch(/^stateDiagram-v2/);
    expect(out).toContain('[*] -->');
    expect(out).toContain('--> [*]');
    expect(out).toMatch(/submit \[isValid\]/);
  });
});
