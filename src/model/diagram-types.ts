/**
 * Diagram view file types. These describe how model elements are projected
 * onto a canvas. They never duplicate semantic information from the model.
 *
 * All three diagram kinds share the same envelope (`schemaVersion`, `kind`,
 * `name`, optional `doc`). The diagram-specific payload differs.
 */

import type { ElementId } from './types.js';

export type DiagramKind = 'ClassDiagram' | 'SequenceDiagram' | 'StateDiagram';

export interface ViewNodeBase {
  /** Stable id for the *view* node (not the model element). */
  id: string;
  /** Position on the canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Class diagram                                                       */
/* ------------------------------------------------------------------ */

export interface ClassDiagramNode extends ViewNodeBase {
  /** Model element shown by this node. Must be a Class or Interface. */
  elementId: ElementId;
  /** Optional collapsed compartments. Default: all expanded. */
  collapsed?: { attributes?: boolean; operations?: boolean };
}

export interface ClassDiagramEdge {
  id: string;
  /** Model Relationship element id. */
  elementId: ElementId;
  /** View node ids the edge visually connects (denormalised for fast render). */
  sourceNodeId: string;
  targetNodeId: string;
  waypoints?: Array<{ x: number; y: number }>;
}

export interface ClassDiagramFile {
  schemaVersion: 1;
  kind: 'ClassDiagram';
  name: string;
  doc?: string;
  nodes: ClassDiagramNode[];
  edges: ClassDiagramEdge[];
}

/* ------------------------------------------------------------------ */
/* Sequence diagram                                                    */
/* ------------------------------------------------------------------ */

export interface Lifeline extends ViewNodeBase {
  /** Class or Interface represented by this lifeline. */
  representsId: ElementId;
  /** Optional display label override (defaults to the class name). */
  label?: string;
}

export type MessageKind = 'sync' | 'async' | 'reply' | 'create' | 'destroy';

export interface SequenceMessage {
  id: string;
  /** Source lifeline (caller). */
  sourceLifelineId: string;
  /** Target lifeline (callee). May equal source for self-messages. */
  targetLifelineId: string;
  /** Operation invoked on the target's class. Empty for reply/create/destroy. */
  operationId?: ElementId;
  kind: MessageKind;
  /** Y position on the time axis. Ordering is determined by this value. */
  y: number;
  /** Optional message-level label (e.g. arguments, return value). */
  label?: string;
}

export interface SequenceDiagramFile {
  schemaVersion: 1;
  kind: 'SequenceDiagram';
  name: string;
  doc?: string;
  lifelines: Lifeline[];
  messages: SequenceMessage[];
}

/* ------------------------------------------------------------------ */
/* State diagram                                                       */
/* ------------------------------------------------------------------ */

export interface StateDiagramNode extends ViewNodeBase {
  /** State model element id. */
  elementId: ElementId;
}

export interface StateDiagramEdge {
  id: string;
  /** Transition model element id. */
  elementId: ElementId;
  sourceNodeId: string;
  targetNodeId: string;
  waypoints?: Array<{ x: number; y: number }>;
}

export interface StateDiagramFile {
  schemaVersion: 1;
  kind: 'StateDiagram';
  name: string;
  doc?: string;
  /** Class that owns the state machine this diagram visualises. */
  ownerClassId: ElementId;
  /** State machine element id. */
  stateMachineId: ElementId;
  nodes: StateDiagramNode[];
  edges: StateDiagramEdge[];
}

export type DiagramFile =
  | ClassDiagramFile
  | SequenceDiagramFile
  | StateDiagramFile;
