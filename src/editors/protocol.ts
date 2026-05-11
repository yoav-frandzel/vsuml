/**
 * RPC message protocol between the extension host and diagram webviews.
 *
 * Every message has a discriminating `type`. Host→webview and webview→host
 * use disjoint type prefixes ("host." and "view." respectively) so the
 * direction is unambiguous when reading wire logs.
 *
 * The same envelope is reused across all three diagram editors; diagram-
 * specific payloads are carried inside `payload`.
 */

import type { DiagramFile, ModelFile, ValidationIssue } from '../model/index.js';

export type ViewKind = 'class' | 'sequence' | 'state';

/* Host → Webview */

export interface HostInitMessage {
  type: 'host.init';
  viewKind: ViewKind;
  model: ModelFile;
  diagram: DiagramFile;
  /** Whether the file is read-only (e.g. opened from a read-only filesystem). */
  readOnly: boolean;
}

export interface HostModelChangedMessage {
  type: 'host.modelChanged';
  model: ModelFile;
  changed: string[];
  removed: string[];
}

export interface HostDiagramChangedMessage {
  type: 'host.diagramChanged';
  diagram: DiagramFile;
}

export interface HostValidationMessage {
  type: 'host.validation';
  issues: ValidationIssue[];
}

export interface HostAckMessage {
  type: 'host.ack';
  /** Echoes the requestId from view.request. */
  requestId: string;
  ok: boolean;
  error?: string;
  /** Optional result data (e.g. newly-minted element id). */
  data?: unknown;
}

/**
 * Sent by the host (e.g. from a Model Explorer command) to add a model
 * element to the active diagram. The webview decides whether the element
 * is admissible and where to place it.
 */
export interface HostAddElementMessage {
  type: 'host.addElement';
  elementId: string;
  /** Optional graph-space coordinates (used by class diagrams). */
  x?: number;
  y?: number;
}

export type HostToView =
  | HostInitMessage
  | HostModelChangedMessage
  | HostDiagramChangedMessage
  | HostValidationMessage
  | HostAckMessage
  | HostAddElementMessage;

/* Webview → Host */

export interface ViewReadyMessage {
  type: 'view.ready';
}

/**
 * The webview proposes a new diagram-file state. The host persists it
 * (after validation) and broadcasts host.diagramChanged to any other open
 * editors viewing the same file.
 */
export interface ViewUpdateDiagramMessage {
  type: 'view.updateDiagram';
  diagram: DiagramFile;
}

/**
 * Mutate the shared model. The host applies the mutation atomically and
 * responds with host.ack carrying any new ids.
 */
export interface ViewMutateModelMessage {
  type: 'view.mutateModel';
  requestId: string;
  /** Discriminated mutation request handled by the host. */
  mutation: ModelMutationRequest;
}

export type ModelMutationRequest =
  | { kind: 'createClass'; name: string; ownerId: string }
  | { kind: 'createInterface'; name: string; ownerId: string }
  | {
      kind: 'createOperation';
      classifierId: string;
      name: string;
      returnType?: string;
    }
  | {
      kind: 'createAttribute';
      classifierId: string;
      name: string;
      type?: string;
    }
  | {
      kind: 'createRelationship';
      relKind: 'Association' | 'Generalization' | 'Dependency';
      sourceId: string;
      targetId: string;
    }
  | {
      kind: 'createState';
      stateMachineId: string;
      name: string;
      stateKind: 'Simple' | 'Composite' | 'Initial' | 'Final' | 'Choice';
    }
  | {
      kind: 'createTransition';
      stateMachineId: string;
      sourceStateId: string;
      targetStateId: string;
      trigger?: string;
      guard?: string;
      effect?: string;
    }
  | { kind: 'renameElement'; id: string; name: string }
  | { kind: 'deleteElement'; id: string }
  | { kind: 'updateElement'; id: string; patch: Record<string, unknown> };

export interface ViewLogMessage {
  type: 'view.log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ViewQuickPickMessage {
  type: 'view.quickPick';
  requestId: string;
  items: Array<{ label: string; description?: string; detail?: string }>;
  placeHolder?: string;
  title?: string;
}

export interface ViewInputBoxMessage {
  type: 'view.inputBox';
  requestId: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  title?: string;
}

export interface ViewShowMessageMessage {
  type: 'view.showMessage';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ViewConfirmMessage {
  type: 'view.confirm';
  requestId: string;
  message: string;
  okLabel?: string;
}

export type ViewToHost =
  | ViewReadyMessage
  | ViewUpdateDiagramMessage
  | ViewMutateModelMessage
  | ViewLogMessage
  | ViewQuickPickMessage
  | ViewInputBoxMessage
  | ViewShowMessageMessage
  | ViewConfirmMessage;
