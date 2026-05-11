/**
 * State diagram renderer. Bridges (model, diagram) → maxGraph cells.
 *
 * State shapes vary by `stateKind`:
 *  - Initial: filled black circle
 *  - Final:   black ring (doubleEllipse)
 *  - Choice:  diamond
 *  - Simple/Composite: rounded rectangle with the state's name
 */

import {
  Graph,
  type Cell,
  InternalEvent,
  type EventObject
} from '@maxgraph/core';
import type {
  ModelFile,
  StateDiagramFile,
  StateDiagramNode,
  StateKind
} from '../../model/index.js';

export interface StateRendererCallbacks {
  onNodesMoved(nodes: Array<{ id: string; x: number; y: number }>): void;
  onEdgeRequested(args: { sourceNodeId: string; targetNodeId: string }): void;
  onEdgeDoubleClicked(elementId: string): void;
  onNodeDoubleClicked(elementId: string): void;
}

const NODE_PREFIX = 'snode:';
const EDGE_PREFIX = 'sedge:';

export class StateDiagramRenderer {
  private vertexById = new Map<string, Cell>();
  private edgeById = new Map<string, Cell>();
  /** view-node-id → model element id. */
  private nodeElementId = new Map<string, string>();
  /** view-edge-id → model element id. */
  private edgeElementId = new Map<string, string>();
  private suppressEvents = false;

  constructor(
    private readonly graph: Graph,
    callbacks: StateRendererCallbacks
  ) {
    graph.setHtmlLabels(true);
    graph.setCellsEditable(false);
    graph.setAllowDanglingEdges(false);
    graph.setMultigraph(true);
    graph.setConnectable(true);

    graph.addListener(InternalEvent.CELLS_MOVED, (_: unknown, evt: EventObject) => {
      if (this.suppressEvents) return;
      const cells = (evt.getProperty('cells') as Cell[]) ?? [];
      const moved: Array<{ id: string; x: number; y: number }> = [];
      for (const c of cells) {
        const id = c.getId();
        if (!id || !id.startsWith(NODE_PREFIX)) continue;
        const geo = c.getGeometry();
        if (geo) moved.push({ id: id.slice(NODE_PREFIX.length), x: geo.x, y: geo.y });
      }
      if (moved.length) callbacks.onNodesMoved(moved);
    });

    graph.addListener(InternalEvent.CELL_CONNECTED, (_: unknown, evt: EventObject) => {
      if (this.suppressEvents) return;
      const edge = evt.getProperty('edge') as Cell | undefined;
      if (!edge) return;
      const source = edge.getTerminal(true);
      const target = edge.getTerminal(false);
      if (!source || !target) return;
      const sId = source.getId();
      const tId = target.getId();
      if (!sId || !tId) return;
      // Remove the speculative cell; the real one comes back through sync.
      try {
        this.graph.getDataModel().beginUpdate();
        this.graph.removeCells([edge], true);
      } finally {
        this.graph.getDataModel().endUpdate();
      }
      callbacks.onEdgeRequested({
        sourceNodeId: sId.slice(NODE_PREFIX.length),
        targetNodeId: tId.slice(NODE_PREFIX.length)
      });
    });

    graph.addListener(InternalEvent.DOUBLE_CLICK, (_: unknown, evt: EventObject) => {
      const cell = evt.getProperty('cell') as Cell | undefined;
      if (!cell) return;
      const id = cell.getId();
      if (!id) return;
      if (id.startsWith(NODE_PREFIX)) {
        const elementId = this.nodeElementId.get(id.slice(NODE_PREFIX.length));
        if (elementId) callbacks.onNodeDoubleClicked(elementId);
      } else if (id.startsWith(EDGE_PREFIX)) {
        const elementId = this.edgeElementId.get(id.slice(EDGE_PREFIX.length));
        if (elementId) callbacks.onEdgeDoubleClicked(elementId);
      }
    });
  }

  sync(model: ModelFile, diagram: StateDiagramFile): void {
    this.suppressEvents = true;
    this.graph.batchUpdate(() => {
      const parent = this.graph.getDefaultParent();
      const aliveNodes = new Set(diagram.nodes.map(n => n.id));
      for (const [id, cell] of this.vertexById) {
        if (!aliveNodes.has(id)) {
          this.graph.removeCells([cell], true);
          this.vertexById.delete(id);
          this.nodeElementId.delete(id);
        }
      }
      const aliveEdges = new Set(diagram.edges.map(e => e.id));
      for (const [id, cell] of this.edgeById) {
        if (!aliveEdges.has(id)) {
          this.graph.removeCells([cell], true);
          this.edgeById.delete(id);
          this.edgeElementId.delete(id);
        }
      }

      for (const node of diagram.nodes) {
        const state = model.elements[node.elementId];
        if (!state || state.kind !== 'State') continue;
        this._upsertVertex(parent, node, state.name, state.stateKind);
        this.nodeElementId.set(node.id, node.elementId);
      }
      for (const edge of diagram.edges) {
        const trans = model.elements[edge.elementId];
        if (!trans || trans.kind !== 'Transition') continue;
        const src = this.vertexById.get(edge.sourceNodeId);
        const tgt = this.vertexById.get(edge.targetNodeId);
        if (!src || !tgt) continue;
        const lbl = formatTransitionLabel(
          trans.trigger,
          trans.guard,
          trans.effect
        );
        const existing = this.edgeById.get(edge.id);
        if (existing) {
          this.graph.getDataModel().setValue(existing, lbl);
        } else {
          const cellId = EDGE_PREFIX + edge.id;
          const e = this.graph.insertEdge({
            parent,
            id: cellId,
            source: src,
            target: tgt,
            value: lbl,
            style: {
              endArrow: 'classic',
              strokeColor: '#888',
              fontColor: '#bbb',
              fontSize: 11
            }
          });
          e.setId(cellId);
          this.edgeById.set(edge.id, e);
        }
        this.edgeElementId.set(edge.id, edge.elementId);
      }
    });
    this.suppressEvents = false;
  }

  private _upsertVertex(
    parent: Cell,
    node: StateDiagramNode,
    name: string,
    kind: StateKind
  ): void {
    const existing = this.vertexById.get(node.id);
    if (existing) {
      // Update geometry + label if changed.
      const geo = existing.getGeometry();
      if (geo && (geo.x !== node.x || geo.y !== node.y)) {
        const ng = geo.clone();
        ng.x = node.x;
        ng.y = node.y;
        this.graph.getDataModel().setGeometry(existing, ng);
      }
      if (kind === 'Simple' || kind === 'Composite') {
        this.graph.getDataModel().setValue(existing, plainLabelHtml(name));
      }
      return;
    }
    const cellId = NODE_PREFIX + node.id;
    let cell: Cell;
    if (kind === 'Initial') {
      cell = this.graph.insertVertex({
        parent,
        id: cellId,
        value: '',
        position: [node.x, node.y],
        size: [24, 24],
        style: { shape: 'ellipse', fillColor: '#222', strokeColor: '#222' }
      });
    } else if (kind === 'Final') {
      cell = this.graph.insertVertex({
        parent,
        id: cellId,
        value: '',
        position: [node.x, node.y],
        size: [28, 28],
        style: {
          shape: 'doubleEllipse',
          fillColor: '#222',
          strokeColor: '#222'
        }
      });
    } else if (kind === 'Choice') {
      cell = this.graph.insertVertex({
        parent,
        id: cellId,
        value: '',
        position: [node.x, node.y],
        size: [28, 28],
        style: {
          shape: 'rhombus',
          fillColor: 'var(--vscode-editorWidget-background)',
          strokeColor: 'var(--vscode-foreground)'
        }
      });
    } else {
      cell = this.graph.insertVertex({
        parent,
        id: cellId,
        value: plainLabelHtml(name),
        position: [node.x, node.y],
        size: [Math.max(node.width, 100), Math.max(node.height, 40)],
        style: {
          shape: 'rectangle',
          rounded: true,
          fillColor: 'var(--vscode-editorWidget-background)',
          strokeColor: 'var(--vscode-foreground)',
          fontColor: 'var(--vscode-editor-foreground)'
        }
      });
    }
    cell.setId(cellId);
    this.vertexById.set(node.id, cell);
  }
}

function plainLabelHtml(name: string): string {
  return `<div style="
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      text-align: center;
      padding: 6px 12px;
    ">${escapeHtml(name)}</div>`;
}

function formatTransitionLabel(
  trigger?: string,
  guard?: string,
  effect?: string
): string {
  const parts: string[] = [];
  if (trigger) parts.push(trigger);
  if (guard) parts.push(`[${guard}]`);
  if (effect) parts.push(`/ ${effect}`);
  return parts.join(' ');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
