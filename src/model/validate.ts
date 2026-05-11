/**
 * Validation utilities for the model and diagram files.
 *
 * These functions never throw — they return arrays of problems so callers
 * (model loader, command palette, VS Code diagnostics provider) can decide
 * how to surface them.
 *
 * The validators are intentionally permissive on shape (we trust the JSON
 * structurally if it parses) and strict on *referential integrity*, which is
 * the property the rest of the system relies on.
 */

import type { ModelElement, ModelFile } from './types.js';
import type {
  ClassDiagramFile,
  DiagramFile,
  SequenceDiagramFile,
  StateDiagramFile
} from './diagram-types.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  message: string;
  /** Model element id, view node id, or other locator the UI may use. */
  locator?: string;
}

export function validateModel(model: ModelFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (model.schemaVersion !== 1) {
    issues.push({
      severity: 'error',
      message: `Unsupported schemaVersion ${model.schemaVersion}; expected 1.`
    });
  }

  const root = model.elements[model.rootPackageId];
  if (!root) {
    issues.push({
      severity: 'error',
      message: `rootPackageId ${model.rootPackageId} has no matching element.`
    });
  } else if (root.kind !== 'Package' || root.ownerId !== null) {
    issues.push({
      severity: 'error',
      message: 'Root element must be a Package with ownerId === null.',
      locator: root.id
    });
  }

  for (const el of Object.values(model.elements)) {
    // Owner integrity (every non-root element points at an existing parent).
    if (el.id !== model.rootPackageId) {
      if (el.ownerId === null) {
        issues.push({
          severity: 'error',
          message: `Element ${describe(el)} has ownerId null but is not the root.`,
          locator: el.id
        });
      } else if (!model.elements[el.ownerId]) {
        issues.push({
          severity: 'error',
          message: `Element ${describe(el)} references missing owner ${el.ownerId}.`,
          locator: el.id
        });
      }
    }

    // Kind-specific reference integrity.
    switch (el.kind) {
      case 'Operation':
        for (const pid of el.parameterIds) {
          if (!model.elements[pid]) {
            issues.push({
              severity: 'error',
              message: `Operation ${describe(el)} references missing parameter ${pid}.`,
              locator: el.id
            });
          }
        }
        break;
      case 'Class':
        if (el.stateMachineId && !model.elements[el.stateMachineId]) {
          issues.push({
            severity: 'error',
            message: `Class ${describe(el)} references missing state machine ${el.stateMachineId}.`,
            locator: el.id
          });
        }
        break;
      case 'Relationship':
        if (!model.elements[el.sourceId]) {
          issues.push({
            severity: 'error',
            message: `Relationship ${describe(el)} references missing source ${el.sourceId}.`,
            locator: el.id
          });
        }
        if (!model.elements[el.targetId]) {
          issues.push({
            severity: 'error',
            message: `Relationship ${describe(el)} references missing target ${el.targetId}.`,
            locator: el.id
          });
        }
        break;
      case 'StateMachine':
        for (const sid of el.topStateIds) {
          if (!model.elements[sid]) {
            issues.push({
              severity: 'error',
              message: `StateMachine ${describe(el)} references missing top state ${sid}.`,
              locator: el.id
            });
          }
        }
        break;
      case 'Transition':
        if (!model.elements[el.sourceStateId]) {
          issues.push({
            severity: 'error',
            message: `Transition ${describe(el)} references missing source state.`,
            locator: el.id
          });
        }
        if (!model.elements[el.targetStateId]) {
          issues.push({
            severity: 'error',
            message: `Transition ${describe(el)} references missing target state.`,
            locator: el.id
          });
        }
        break;
    }
  }

  return issues;
}

export function validateDiagram(
  model: ModelFile,
  diagram: DiagramFile
): ValidationIssue[] {
  switch (diagram.kind) {
    case 'ClassDiagram':
      return validateClassDiagram(model, diagram);
    case 'SequenceDiagram':
      return validateSequenceDiagram(model, diagram);
    case 'StateDiagram':
      return validateStateDiagram(model, diagram);
  }
}

function validateClassDiagram(
  model: ModelFile,
  d: ClassDiagramFile
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  for (const n of d.nodes) {
    nodeIds.add(n.id);
    const el = model.elements[n.elementId];
    if (!el) {
      issues.push({
        severity: 'error',
        message: `Class diagram node references missing model element ${n.elementId}.`,
        locator: n.id
      });
      continue;
    }
    if (el.kind !== 'Class' && el.kind !== 'Interface') {
      issues.push({
        severity: 'error',
        message: `Node ${n.id} references ${el.kind} ${el.name}; expected Class or Interface.`,
        locator: n.id
      });
    }
  }
  for (const e of d.edges) {
    if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) {
      issues.push({
        severity: 'error',
        message: `Edge ${e.id} connects unknown view nodes.`,
        locator: e.id
      });
    }
    const rel = model.elements[e.elementId];
    if (!rel || rel.kind !== 'Relationship') {
      issues.push({
        severity: 'error',
        message: `Edge ${e.id} references missing or non-Relationship element ${e.elementId}.`,
        locator: e.id
      });
    }
  }
  return issues;
}

function validateSequenceDiagram(
  model: ModelFile,
  d: SequenceDiagramFile
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lifelineToClass = new Map<string, string>();

  for (const l of d.lifelines) {
    const el = model.elements[l.representsId];
    if (!el) {
      issues.push({
        severity: 'error',
        message: `Lifeline ${l.id} represents missing element ${l.representsId}.`,
        locator: l.id
      });
      continue;
    }
    if (el.kind !== 'Class' && el.kind !== 'Interface') {
      issues.push({
        severity: 'error',
        message: `Lifeline ${l.id} must represent a Class or Interface (got ${el.kind}).`,
        locator: l.id
      });
      continue;
    }
    lifelineToClass.set(l.id, el.id);
  }

  for (const m of d.messages) {
    const targetClassId = lifelineToClass.get(m.targetLifelineId);
    if (!targetClassId) {
      issues.push({
        severity: 'error',
        message: `Message ${m.id} targets unknown lifeline ${m.targetLifelineId}.`,
        locator: m.id
      });
      continue;
    }
    if (!lifelineToClass.has(m.sourceLifelineId)) {
      issues.push({
        severity: 'error',
        message: `Message ${m.id} sourced from unknown lifeline ${m.sourceLifelineId}.`,
        locator: m.id
      });
    }
    // For sync/async messages we require the operation to belong to the target's class.
    if (m.kind === 'sync' || m.kind === 'async') {
      if (!m.operationId) {
        issues.push({
          severity: 'error',
          message: `Message ${m.id} (${m.kind}) has no operationId.`,
          locator: m.id
        });
        continue;
      }
      const op = model.elements[m.operationId];
      if (!op || op.kind !== 'Operation') {
        issues.push({
          severity: 'error',
          message: `Message ${m.id} references missing operation ${m.operationId}.`,
          locator: m.id
        });
        continue;
      }
      if (op.ownerId !== targetClassId) {
        issues.push({
          severity: 'error',
          message: `Message ${m.id} invokes operation ${op.name} which does not belong to the target lifeline's class.`,
          locator: m.id
        });
      }
    }
  }

  return issues;
}

function validateStateDiagram(
  model: ModelFile,
  d: StateDiagramFile
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const owner = model.elements[d.ownerClassId];
  if (!owner || owner.kind !== 'Class') {
    issues.push({
      severity: 'error',
      message: `State diagram ownerClassId ${d.ownerClassId} is missing or not a Class.`
    });
  }
  const sm = model.elements[d.stateMachineId];
  if (!sm || sm.kind !== 'StateMachine') {
    issues.push({
      severity: 'error',
      message: `State diagram stateMachineId ${d.stateMachineId} is missing or not a StateMachine.`
    });
  } else if (sm.ownerId !== d.ownerClassId) {
    issues.push({
      severity: 'error',
      message: `StateMachine ${d.stateMachineId} is not owned by class ${d.ownerClassId}.`
    });
  }

  const nodeIds = new Set<string>();
  for (const n of d.nodes) {
    nodeIds.add(n.id);
    const el = model.elements[n.elementId];
    if (!el || el.kind !== 'State') {
      issues.push({
        severity: 'error',
        message: `State diagram node ${n.id} references missing or non-State element.`,
        locator: n.id
      });
    }
  }
  for (const e of d.edges) {
    if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) {
      issues.push({
        severity: 'error',
        message: `Edge ${e.id} connects unknown view nodes.`,
        locator: e.id
      });
    }
    const t = model.elements[e.elementId];
    if (!t || t.kind !== 'Transition') {
      issues.push({
        severity: 'error',
        message: `Edge ${e.id} references missing or non-Transition element.`,
        locator: e.id
      });
    }
  }
  return issues;
}

function describe(el: ModelElement): string {
  return `${el.kind}${el.name ? ` "${el.name}"` : ''} (${el.id})`;
}
