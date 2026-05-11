/**
 * Renders a Class Diagram on a maxGraph canvas, synchronised with the
 * shared model and the diagram view file.
 *
 * Sync direction:
 *   model + diagram → graph cells  (sync())
 *   graph cells     → diagram      (via callbacks the caller wires up to
 *                                   maxGraph events so user moves and edge
 *                                   creations propagate back)
 *
 * The renderer is intentionally stateless aside from a Map of view-node-id →
 * cell so that any model or diagram change can be reconciled by calling
 * sync() again.
 */

import { Graph, Cell, Geometry, EventObject, InternalEvent } from '@maxgraph/core';
import type {
  ClassDiagramEdge,
  ClassDiagramFile,
  ClassDiagramNode,
  Class,
  Interface,
  ModelElement,
  ModelFile,
  Operation,
  Relationship
} from '../../model/index.js';

const NODE_MIN_WIDTH = 160;
const NODE_PADDING_TOP = 6;
const NODE_PADDING_BOTTOM = 8;
const NODE_PADDING_H = 8;
const NAME_LINE_H = 18;
const STEREO_LINE_H = 14;
const MEMBER_LINE_H = 16;
// Separator = 4px margin-top + 1px border + 4px margin-bottom.
const SEPARATOR_H = 9;

export interface ClassRendererCallbacks {
  /** Called when the user moves one or more nodes on the canvas. */
  onNodesMoved(nodes: Array<{ id: string; x: number; y: number }>): void;
  /**
   * Called when the user draws a new edge by dragging from one node to
   * another. The renderer does not assume which kind of relationship to
   * create — the host asks the user.
   */
  onEdgeRequested(req: { sourceNodeId: string; targetNodeId: string }): void;
  /** Double-click on a node — surfaces an edit intent to the host. */
  onNodeActivated(viewNodeId: string): void;
  /** A node was deleted via the keyboard (Delete key). */
  onNodeDeleted(viewNodeId: string): void;
  /** An edge was deleted via the keyboard. */
  onEdgeDeleted(viewEdgeId: string): void;
}

export class ClassDiagramRenderer {
  private readonly _vertexById = new Map<string, Cell>();
  private readonly _edgeById = new Map<string, Cell>();
  private _suppressEvents = false;

  constructor(
    private readonly graph: Graph,
    private readonly callbacks: ClassRendererCallbacks
  ) {
    this._installHandlers();
  }

  /** Replace the entire canvas with the given diagram/model state. */
  sync(model: ModelFile, diagram: ClassDiagramFile): void {
    const parent = this.graph.getDefaultParent();
    this._suppressEvents = true;
    this.graph.batchUpdate(() => {
      // Remove cells whose view nodes no longer exist.
      const aliveNodes = new Set(diagram.nodes.map(n => n.id));
      for (const [id, cell] of this._vertexById) {
        if (!aliveNodes.has(id)) {
          this.graph.removeCells([cell], true);
          this._vertexById.delete(id);
        }
      }
      const aliveEdges = new Set(diagram.edges.map(e => e.id));
      for (const [id, cell] of this._edgeById) {
        if (!aliveEdges.has(id)) {
          this.graph.removeCells([cell], true);
          this._edgeById.delete(id);
        }
      }

      for (const n of diagram.nodes) {
        this._upsertVertex(parent, model, n);
      }
      for (const e of diagram.edges) {
        this._upsertEdge(model, e);
      }
    });
    this._suppressEvents = false;
  }

  private _upsertVertex(
    parent: Cell,
    model: ModelFile,
    n: ClassDiagramNode
  ): void {
    const classifier = model.elements[n.elementId];
    if (
      !classifier ||
      (classifier.kind !== 'Class' && classifier.kind !== 'Interface')
    ) {
      return;
    }
    const html = renderClassifierHtml(model, classifier as Class | Interface);
    const computedH = computeNodeHeight(model, classifier as Class | Interface);
    const w = Math.max(NODE_MIN_WIDTH, n.width || NODE_MIN_WIDTH);
    // Always size height to fit the content tightly; ignore any stale stored
    // height. Width is preserved so the user can widen a node manually.
    const h = computedH;
    const style = classifierStyle(classifier as Class | Interface);

    let cell = this._vertexById.get(n.id);
    if (!cell) {
      cell = this.graph.insertVertex({
        parent,
        id: `node:${n.id}`,
        value: html,
        position: [n.x, n.y],
        size: [w, h],
        style
      });
      this._vertexById.set(n.id, cell);
    } else {
      this.graph.model.setValue(cell, html);
      const geo = cell.getGeometry();
      if (geo) {
        const updated = new Geometry(n.x, n.y, w, h);
        this.graph.model.setGeometry(cell, updated);
      }
      this.graph.model.setStyle(cell, style);
    }
  }

  private _upsertEdge(model: ModelFile, e: ClassDiagramEdge): void {
    const source = this._vertexById.get(e.sourceNodeId);
    const target = this._vertexById.get(e.targetNodeId);
    if (!source || !target) return;

    const rel = model.elements[e.elementId];
    const relKind =
      rel && rel.kind === 'Relationship'
        ? (rel as Relationship).relKind
        : 'Association';
    const style = edgeStyle(relKind);
    const label = rel ? edgeLabel(rel as Relationship) : '';

    let cell = this._edgeById.get(e.id);
    if (!cell) {
      cell = this.graph.insertEdge({
        parent: this.graph.getDefaultParent(),
        id: `edge:${e.id}`,
        value: label,
        source,
        target,
        style
      });
      this._edgeById.set(e.id, cell);
    } else {
      cell.value = label;
      this.graph.model.setStyle(cell, style);
      // Reconnect if endpoints changed.
      if (cell.source !== source) {
        this.graph.model.setTerminal(cell, source, true);
      }
      if (cell.target !== target) {
        this.graph.model.setTerminal(cell, target, false);
      }
    }
  }

  private _installHandlers(): void {
    // Node moves: when the user drops one or more cells.
    this.graph.addListener(InternalEvent.CELLS_MOVED, (_s: unknown, evt: EventObject) => {
      if (this._suppressEvents) return;
      const cells = evt.getProperty('cells') as Cell[] | undefined;
      if (!cells) return;
      const moved: Array<{ id: string; x: number; y: number }> = [];
      for (const cell of cells) {
        if (!cell.isVertex()) continue;
        const id = idFromCell(cell, 'node');
        if (!id) continue;
        const geo = cell.getGeometry();
        if (!geo) continue;
        moved.push({ id, x: geo.x, y: geo.y });
      }
      if (moved.length > 0) this.callbacks.onNodesMoved(moved);
    });

    // Edge creation: maxGraph fires CELL_CONNECTED when the user finishes
    // dragging from one terminal to another.
    this.graph.addListener(InternalEvent.CELL_CONNECTED, (_s: unknown, evt: EventObject) => {
      if (this._suppressEvents) return;
      const edge = evt.getProperty('edge') as Cell | undefined;
      const source = evt.getProperty('source') as boolean | undefined;
      if (!edge) return;
      // Only react when we have both terminals set.
      const s = edge.getTerminal(true);
      const t = edge.getTerminal(false);
      if (!s || !t) return;
      // Detect freshly-drawn edges by their lack of id mapping.
      const matched = [...this._edgeById.values()].some(c => c === edge);
      if (matched) return;
      const sId = idFromCell(s, 'node');
      const tId = idFromCell(t, 'node');
      if (!sId || !tId) return;
      // Remove the transient cell maxGraph inserted; the host will add a
      // proper one after the user picks a relationship kind.
      this.graph.removeCells([edge], false);
      void source;
      this.callbacks.onEdgeRequested({ sourceNodeId: sId, targetNodeId: tId });
    });

    // Double click activates a node for property editing.
    this.graph.addListener(InternalEvent.DOUBLE_CLICK, (_s: unknown, evt: EventObject) => {
      const cell = evt.getProperty('cell') as Cell | undefined;
      if (!cell) return;
      if (cell.isVertex()) {
        const id = idFromCell(cell, 'node');
        if (id) this.callbacks.onNodeActivated(id);
      }
    });

    // Delete key removes the selection.
    this.graph.getContainer().addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const cells = this.graph.getSelectionCells();
      for (const cell of cells) {
        if (cell.isVertex()) {
          const id = idFromCell(cell, 'node');
          if (id) this.callbacks.onNodeDeleted(id);
        } else if (cell.isEdge()) {
          const id = idFromCell(cell, 'edge');
          if (id) this.callbacks.onEdgeDeleted(id);
        }
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Styling                                                              */
/* ------------------------------------------------------------------ */

function classifierStyle(c: Class | Interface): Record<string, unknown> {
  return {
    shape: 'rectangle',
    rounded: 1,
    arcSize: 14,
    html: 1,
    whiteSpace: 'wrap',
    fillColor: 'var(--vscode-editorWidget-background)',
    strokeColor: 'var(--vscode-panel-border, var(--vscode-foreground))',
    fontColor: 'var(--vscode-editor-foreground)',
    align: 'left',
    verticalAlign: 'top',
    spacing: 0,
    strokeWidth: c.kind === 'Interface' ? 1.4 : 1.1
  };
}

function edgeStyle(
  kind: 'Association' | 'Generalization' | 'Dependency' | 'Realization'
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    strokeColor: 'var(--vscode-foreground)',
    fontColor: 'var(--vscode-editor-foreground)',
    rounded: false,
    endSize: 10,
    startSize: 10
  };
  switch (kind) {
    case 'Generalization':
      return { ...base, endArrow: 'block', endFill: 0 };
    case 'Realization':
      return { ...base, endArrow: 'block', endFill: 0, dashed: 1 };
    case 'Dependency':
      return { ...base, endArrow: 'open', dashed: 1 };
    case 'Association':
    default:
      return { ...base, endArrow: 'open' };
  }
}

function edgeLabel(rel: Relationship): string {
  return rel.name || '';
}

/* ------------------------------------------------------------------ */
/* HTML rendering                                                       */
/* ------------------------------------------------------------------ */

function renderClassifierHtml(
  model: ModelFile,
  c: Class | Interface
): string {
  const stereotype =
    c.kind === 'Interface' ? '«interface»' : c.stereotype ? `«${c.stereotype}»` : '';
  const attrs = childrenOf(model, c.id).filter(e => e.kind === 'Attribute');
  const ops = childrenOf(model, c.id).filter(e => e.kind === 'Operation');

  const stereoHtml = stereotype
    ? `<div style="font-size:10px;line-height:${STEREO_LINE_H}px;opacity:0.75;text-align:center;">${escapeHtml(stereotype)}</div>`
    : '';
  const nameHtml = `<div style="font-weight:600;${c.isAbstract ? 'font-style:italic;' : ''}line-height:${NAME_LINE_H}px;text-align:center;">${escapeHtml(c.name)}</div>`;

  // height:0 + border-top + symmetric margins keeps the rendered height
  // exactly SEPARATOR_H so it matches computeNodeHeight().
  const sep = `<div style="height:0;border-top:1px solid var(--vscode-foreground);opacity:0.35;margin:4px -${NODE_PADDING_H}px;"></div>`;

  const lineStyle =
    `line-height:${MEMBER_LINE_H}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;

  const attrLines = attrs
    .map(a => {
      const attr = a as Extract<ModelElement, { kind: 'Attribute' }>;
      return `<div style="${lineStyle}">${escapeHtml(vis(attr.visibility))} ${escapeHtml(attr.name)}: ${escapeHtml(attr.type)}</div>`;
    })
    .join('');
  const opLines = ops
    .map(o => {
      const op = o as Operation;
      const params = op.parameterIds
        .map(pid => model.elements[pid])
        .filter(p => p && p.kind === 'Parameter')
        .map(
          p =>
            `${escapeHtml(p.name)}: ${escapeHtml(
              (p as Extract<ModelElement, { kind: 'Parameter' }>).type
            )}`
        )
        .join(', ');
      const ret = op.returnType ? `: ${escapeHtml(op.returnType)}` : '';
      const abstract = op.isAbstract ? 'font-style:italic;' : '';
      return `<div style="${abstract}${lineStyle}">${escapeHtml(vis(op.visibility))} ${escapeHtml(op.name)}(${params})${ret}</div>`;
    })
    .join('');

  const attrsSection = attrLines ? `${sep}${attrLines}` : '';
  const opsSection = opLines ? `${sep}${opLines}` : '';

  return `<div style="height:100%;width:100%;overflow:hidden;box-sizing:border-box;padding:${NODE_PADDING_TOP}px ${NODE_PADDING_H}px ${NODE_PADDING_BOTTOM}px;font-family:var(--vscode-font-family);font-size:11px;">${stereoHtml}${nameHtml}${attrsSection}${opsSection}</div>`;
}

function computeNodeHeight(model: ModelFile, c: Class | Interface): number {
  const hasStereotype =
    c.kind === 'Interface' || !!(c as Class).stereotype;
  const attrs = childrenOf(model, c.id).filter(e => e.kind === 'Attribute').length;
  const ops = childrenOf(model, c.id).filter(e => e.kind === 'Operation').length;
  let h = NODE_PADDING_TOP + NODE_PADDING_BOTTOM + NAME_LINE_H + (hasStereotype ? STEREO_LINE_H : 0);
  if (attrs > 0) h += SEPARATOR_H + attrs * MEMBER_LINE_H;
  if (ops > 0) h += SEPARATOR_H + ops * MEMBER_LINE_H;
  return h;
}

function childrenOf(model: ModelFile, ownerId: string): ModelElement[] {
  return Object.values(model.elements).filter(e => e.ownerId === ownerId);
}

function vis(v: string): string {
  switch (v) {
    case 'public':
      return '+';
    case 'protected':
      return '#';
    case 'private':
      return '−';
    case 'package':
      return '~';
    default:
      return '+';
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c] as string
  );
}

function idFromCell(cell: Cell, prefix: 'node' | 'edge'): string | undefined {
  const id = cell.getId();
  if (!id) return undefined;
  const tag = `${prefix}:`;
  return id.startsWith(tag) ? id.slice(tag.length) : undefined;
}
