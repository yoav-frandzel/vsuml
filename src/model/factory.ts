/**
 * Factory helpers for creating new model elements with stable UUIDs and
 * sensible defaults. Centralised so that ID generation and default values
 * live in one place.
 */

import { randomUUID } from 'node:crypto';
import type {
  Attribute,
  Class,
  ElementId,
  Interface,
  ModelFile,
  Operation,
  Package,
  Parameter,
  Relationship,
  RelationshipKind,
  State,
  StateKind,
  StateMachine,
  Transition,
  Visibility
} from './types.js';
import { CURRENT_MODEL_SCHEMA_VERSION } from './types.js';

export function newId(): ElementId {
  return randomUUID();
}

export function createEmptyModel(): ModelFile {
  const rootId = newId();
  const root: Package = {
    id: rootId,
    kind: 'Package',
    ownerId: null,
    name: 'Model'
  };
  return {
    schemaVersion: CURRENT_MODEL_SCHEMA_VERSION,
    rootPackageId: rootId,
    elements: { [rootId]: root }
  };
}

export function createPackage(name: string, ownerId: ElementId): Package {
  return { id: newId(), kind: 'Package', ownerId, name };
}

export function createClass(name: string, ownerId: ElementId): Class {
  return { id: newId(), kind: 'Class', ownerId, name };
}

export function createInterface(name: string, ownerId: ElementId): Interface {
  return { id: newId(), kind: 'Interface', ownerId, name };
}

export function createAttribute(
  name: string,
  ownerId: ElementId,
  type = 'string',
  visibility: Visibility = 'private'
): Attribute {
  return {
    id: newId(),
    kind: 'Attribute',
    ownerId,
    name,
    type,
    visibility
  };
}

export function createOperation(
  name: string,
  ownerId: ElementId,
  visibility: Visibility = 'public',
  returnType?: string
): Operation {
  return {
    id: newId(),
    kind: 'Operation',
    ownerId,
    name,
    visibility,
    returnType,
    parameterIds: []
  };
}

export function createParameter(
  name: string,
  operationId: ElementId,
  type = 'string'
): Parameter {
  return {
    id: newId(),
    kind: 'Parameter',
    ownerId: operationId,
    name,
    type,
    direction: 'in'
  };
}

export function createRelationship(
  relKind: RelationshipKind,
  sourceId: ElementId,
  targetId: ElementId,
  ownerId: ElementId
): Relationship {
  return {
    id: newId(),
    kind: 'Relationship',
    ownerId,
    name: '',
    relKind,
    sourceId,
    targetId
  };
}

export function createStateMachine(classId: ElementId): StateMachine {
  return {
    id: newId(),
    kind: 'StateMachine',
    ownerId: classId,
    name: 'StateMachine',
    topStateIds: []
  };
}

export function createState(
  name: string,
  ownerId: ElementId,
  stateKind: StateKind = 'Simple'
): State {
  return {
    id: newId(),
    kind: 'State',
    ownerId,
    name,
    stateKind
  };
}

export function createTransition(
  stateMachineId: ElementId,
  sourceStateId: ElementId,
  targetStateId: ElementId
): Transition {
  return {
    id: newId(),
    kind: 'Transition',
    ownerId: stateMachineId,
    name: '',
    sourceStateId,
    targetStateId
  };
}
