/**
 * Class Diagram webview entry point.
 *
 * Owns: render state, maxGraph instance, the renderer that bridges model
 * data to maxGraph cells, and the dispatch loop that turns user gestures
 * into messages back to the extension host.
 */

import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Graph, SelectionHandler, type FitPlugin } from '@maxgraph/core';
import { onHostMessage, post, log } from '../vscode-api.js';
import {
  requestMutation,
  resolveAck,
  showInputBox,
  showMessage,
  showQuickPick
} from '../shared/rpc.js';
import type {
  ClassDiagramEdge,
  ClassDiagramFile,
  ClassDiagramNode,
  ModelElement,
  ModelFile,
  ValidationIssue
} from '../../model/index.js';
import {
  ClassDiagramRenderer,
  type ClassRendererCallbacks
} from './renderer.js';
import { Toolbar, type RelationshipKind } from './toolbar.js';
import { PopupMenu } from '../shared/popup-menu.js';
import { installGraphPanZoom, type GraphPanZoomController } from '../shared/pan.js';

interface AppState {
  model: ModelFile | undefined;
  diagram: ClassDiagramFile | undefined;
  issues: ValidationIssue[];
}

const App: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const rendererRef = useRef<ClassDiagramRenderer | null>(null);
  const panZoomRef = useRef<GraphPanZoomController | null>(null);
  const [zoomPct, setZoomPct] = useState(100);

  const [state, setState] = useState<AppState>({
    model: undefined,
    diagram: undefined,
    issues: []
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const [nodeMenu, setNodeMenu] = useState<
    { viewNodeId: string; x: number; y: number } | undefined
  >();
  const [edgeMenu, setEdgeMenu] = useState<
    { viewEdgeId: string; x: number; y: number } | undefined
  >();

  /**
   * In-memory undo stack scoped to this editor session. Each entry captures
   * enough state to reverse a destructive op:
   *   - the prior diagram snapshot (restored verbatim)
   *   - the model elements that were removed (re-inserted via restoreElement
   *     so they keep their original UUIDs and existing diagram edge
   *     references stay valid).
   * The stack is reset on host.init.
   */
  type UndoEntry = {
    diagram: ClassDiagramFile;
    removedElements: ModelElement[];
  };
  const undoStackRef = useRef<UndoEntry[]>([]);
  const UNDO_LIMIT = 100;

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > UNDO_LIMIT) {
      undoStackRef.current.shift();
    }
  }, []);

  /** Updates the local diagram, persists it through the host, and re-renders. */
  const updateDiagram = useCallback((next: ClassDiagramFile) => {
    setState(prev => ({ ...prev, diagram: next }));
    post({ type: 'view.updateDiagram', diagram: next });
    if (rendererRef.current && stateRef.current.model) {
      rendererRef.current.sync(stateRef.current.model, next);
    }
  }, []);

  /** Callbacks the renderer invokes when the user interacts with the canvas. */
  const callbacks: ClassRendererCallbacks = {
    onNodesMoved: moved => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const ids = new Set(moved.map(m => m.id));
      const nodes = cur.nodes.map(n => {
        if (!ids.has(n.id)) return n;
        const m = moved.find(x => x.id === n.id)!;
        return { ...n, x: m.x, y: m.y };
      });
      updateDiagram({ ...cur, nodes });
    },
    onEdgeRequested: async ({ sourceNodeId, targetNodeId }) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const sourceNode = cur.nodes.find(n => n.id === sourceNodeId);
      const targetNode = cur.nodes.find(n => n.id === targetNodeId);
      if (!sourceNode || !targetNode) return;
      if (edgeExistsBetween(cur, sourceNodeId, targetNodeId)) {
        showMessage(
          'info',
          'These two classifiers are already connected. Right-click the existing edge to change its kind.'
        );
        return;
      }
      // Drag-to-connect defaults to Association; the user can right-click
      // the new edge to change its kind.
      const result = await requestMutation<{ id: string }>({
        kind: 'createRelationship',
        relKind: 'Association',
        sourceId: sourceNode.elementId,
        targetId: targetNode.elementId
      });
      if (!result) return;
      const newEdge: ClassDiagramEdge = {
        id: makeId(),
        elementId: result.id,
        sourceNodeId,
        targetNodeId
      };
      updateDiagram({ ...cur, edges: [...cur.edges, newEdge] });
    },
    onNodeActivated: async viewNodeId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const node = cur.nodes.find(n => n.id === viewNodeId);
      if (!node) return;
      const el = model.elements[node.elementId];
      if (!el) return;
      const name = await showInputBox({
        prompt: `Rename ${el.kind}`,
        value: el.name
      });
      if (name && name.trim() && name !== el.name) {
        void requestMutation({
          kind: 'renameElement',
          id: el.id,
          name: name.trim()
        });
      }
    },
    onEdgeActivated: async viewEdgeId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const edge = cur.edges.find(e => e.id === viewEdgeId);
      if (!edge) return;
      const rel = model.elements[edge.elementId];
      if (!rel || rel.kind !== 'Relationship') return;
      const kinds: RelationshipKind[] = [
        'Association',
        'Aggregation',
        'Generalization',
        'Dependency'
      ];
      const picked = await showQuickPick(
        kinds.map(k => ({
          label: k,
          description: k === rel.relKind ? '(current)' : ''
        })),
        { placeHolder: 'Change edge type' }
      );
      const nextKind = kinds.find(k => k === picked?.label);
      if (!nextKind || nextKind === rel.relKind) return;
      void requestMutation({
        kind: 'updateElement',
        id: rel.id,
        patch: { relKind: nextKind }
      });
    },
    onNodeDeleted: viewNodeId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const node = cur.nodes.find(n => n.id === viewNodeId);
      if (!node) return;
      const incident = cur.edges.filter(
        e => e.sourceNodeId === viewNodeId || e.targetNodeId === viewNodeId
      );
      const removedElements = incident
        .map(e => model.elements[e.elementId])
        .filter((x): x is ModelElement => !!x);
      pushUndo({ diagram: cur, removedElements });
      for (const e of incident) {
        void requestMutation({ kind: 'deleteElement', id: e.elementId });
      }
      updateDiagram({
        ...cur,
        nodes: cur.nodes.filter(n => n.id !== viewNodeId),
        edges: cur.edges.filter(
          e => e.sourceNodeId !== viewNodeId && e.targetNodeId !== viewNodeId
        )
      });
    },
    onNodeContextMenu: (viewNodeId, x, y) => {
      setNodeMenu({ viewNodeId, x, y });
    },
    onEdgeContextMenu: (viewEdgeId, x, y) => {
      setEdgeMenu({ viewEdgeId, x, y });
    },
    onEdgeDeleted: viewEdgeId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const edge = cur.edges.find(e => e.id === viewEdgeId);
      if (!edge) return;
      const rel = model.elements[edge.elementId];
      pushUndo({
        diagram: cur,
        removedElements: rel ? [rel] : []
      });
      void requestMutation({ kind: 'deleteElement', id: edge.elementId });
      updateDiagram({
        ...cur,
        edges: cur.edges.filter(e => e.id !== viewEdgeId)
      });
    }
  };
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // One-time graph init.
  useEffect(() => {
    if (!canvasRef.current) return;
    const graph = new Graph(canvasRef.current);
    graph.setPanning(true);
    graph.setCellsEditable(false);
    graph.setHtmlLabels(true);
    graph.setConnectable(true);
    graph.setAllowDanglingEdges(false);
    graph.setMultigraph(true);
    graph.setTooltips(true);

    // Live preview: move the actual cell + its connected edges in real time
    // instead of just an outline. Default maxLivePreview is 0 (disabled).
    const selection = graph.getPlugin<SelectionHandler>(SelectionHandler.pluginId);
    if (selection) {
      selection.maxLivePreview = 1000;
    }

    graphRef.current = graph;
    const renderer = new ClassDiagramRenderer(graph, {
      onNodesMoved: m => callbacksRef.current.onNodesMoved(m),
      onEdgeRequested: m => callbacksRef.current.onEdgeRequested(m),
      onNodeActivated: id => callbacksRef.current.onNodeActivated(id),
      onEdgeActivated: id => callbacksRef.current.onEdgeActivated(id),
      onNodeContextMenu: (id, x, y) =>
        callbacksRef.current.onNodeContextMenu(id, x, y),
      onEdgeContextMenu: (id, x, y) =>
        callbacksRef.current.onEdgeContextMenu(id, x, y),
      onNodeDeleted: id => callbacksRef.current.onNodeDeleted(id),
      onEdgeDeleted: id => callbacksRef.current.onEdgeDeleted(id)
    });
    rendererRef.current = renderer;
    const panZoom = installGraphPanZoom(graph, s => setZoomPct(Math.round(s * 100)));
    panZoomRef.current = panZoom;
    return () => {
      panZoom.dispose();
      panZoomRef.current = null;
      renderer.destroy();
      graph.destroy();
      graphRef.current = null;
      rendererRef.current = null;
    };
  }, []);

  // Sync whenever model or diagram changes.
  useEffect(() => {
    if (rendererRef.current && state.model && state.diagram) {
      rendererRef.current.sync(state.model, state.diagram);
    }
  }, [state.model, state.diagram]);

  // Host message subscription.
  useEffect(() => {
    const off = onHostMessage(msg => {
      switch (msg.type) {
        case 'host.init':
          if (msg.diagram.kind !== 'ClassDiagram') {
            log('error', `unexpected kind ${msg.diagram.kind}`);
            return;
          }
          undoStackRef.current = [];
          setState({
            model: msg.model,
            diagram: msg.diagram as ClassDiagramFile,
            issues: []
          });
          break;
        case 'host.modelChanged':
          setState(prev => ({ ...prev, model: msg.model }));
          break;
        case 'host.diagramChanged':
          if (msg.diagram.kind === 'ClassDiagram') {
            setState(prev => ({
              ...prev,
              diagram: msg.diagram as ClassDiagramFile
            }));
          }
          break;
        case 'host.validation':
          setState(prev => ({ ...prev, issues: msg.issues }));
          break;
        case 'host.addElement': {
          const cur = stateRef.current.diagram;
          if (!cur) break;
          if (cur.nodes.some(n => n.elementId === msg.elementId)) break;
          const offset = cur.nodes.length * 30;
          const node: ClassDiagramNode = {
            id: makeId(),
            elementId: msg.elementId,
            x: msg.x !== undefined ? msg.x : 60 + offset,
            y: msg.y !== undefined ? msg.y : 60 + offset,
            width: 200,
            height: 120
          };
          updateDiagram({ ...cur, nodes: [...cur.nodes, node] });
          break;
        }
        case 'host.ack':
          resolveAck(msg);
          break;
      }
    });
    post({ type: 'view.ready' });
    return off;
  }, []);

  /* Toolbar handlers */

  const addExistingClassToDiagram = useCallback(
    (elementId: string, position?: { x: number; y: number }) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      if (cur.nodes.some(n => n.elementId === elementId)) return;
      const offset = cur.nodes.length * 30;
      const node: ClassDiagramNode = {
        id: makeId(),
        elementId,
        x: position ? position.x : 60 + offset,
        y: position ? position.y : 60 + offset,
        width: 200,
        height: 120
      };
      updateDiagram({ ...cur, nodes: [...cur.nodes, node] });
    },
    [updateDiagram]
  );

  const handleAddClass = useCallback(async () => {
    const name = await showInputBox({
      prompt: 'New class name',
      value: 'NewClass'
    });
    if (!name) return;
    const model = stateRef.current.model;
    if (!model) return;
    const created = await requestMutation<{ id: string }>({
      kind: 'createClass',
      name: name.trim(),
      ownerId: model.rootPackageId
    });
    if (!created) return;
    addExistingClassToDiagram(created.id);
  }, [addExistingClassToDiagram]);

  const handleAddInterface = useCallback(async () => {
    const name = await showInputBox({
      prompt: 'New interface name',
      value: 'NewInterface'
    });
    if (!name) return;
    const model = stateRef.current.model;
    if (!model) return;
    const created = await requestMutation<{ id: string }>({
      kind: 'createInterface',
      name: name.trim(),
      ownerId: model.rootPackageId
    });
    if (!created) return;
    addExistingClassToDiagram(created.id);
  }, [addExistingClassToDiagram]);

  const handleAddFromModel = useCallback(async () => {
    const model = stateRef.current.model;
    if (!model) return;
    const cur = stateRef.current.diagram;
    if (!cur) return;
    const alreadyOnDiagram = new Set(cur.nodes.map(n => n.elementId));
    const candidates = Object.values(model.elements).filter(
      e =>
        (e.kind === 'Class' || e.kind === 'Interface') &&
        !alreadyOnDiagram.has(e.id)
    );
    if (candidates.length === 0) {
      showMessage('info', 'All model classifiers are already on this diagram.');
      return;
    }
    const picked = await showQuickPick(
      candidates.map(c => ({
        label: c.name,
        description: c.kind,
        elementId: c.id
      })),
      { placeHolder: 'Pick a class or interface to add to the diagram' }
    );
    if (!picked) return;
    addExistingClassToDiagram(picked.elementId);
  }, [addExistingClassToDiagram]);

  const preFitViewRef = useRef<{ scale: number; tx: number; ty: number } | undefined>(
    undefined
  );
  const [fitActive, setFitActive] = useState(false);

  const handleToggleFit = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    if (!fitActive) {
      // Snapshot the current view, then fit.
      const view = g.view;
      preFitViewRef.current = {
        scale: view.scale,
        tx: view.translate?.x ?? 0,
        ty: view.translate?.y ?? 0
      };
      const plugin = g.getPlugin<FitPlugin>('fit');
      plugin?.fit({ margin: 24 });
      setFitActive(true);
    } else {
      // Restore the snapshot.
      const snap = preFitViewRef.current;
      if (snap) {
        g.view.scaleAndTranslate(snap.scale, snap.tx, snap.ty);
      }
      preFitViewRef.current = undefined;
      setFitActive(false);
    }
  }, [fitActive]);

  const nodeMenuRef = useRef<HTMLDivElement>(null);
  const edgeMenuRef = useRef<HTMLDivElement>(null);

  // Dismiss either context menu on any document interaction outside it.
  useEffect(() => {
    if (!nodeMenu && !edgeMenu) return;
    const dismiss = (e: Event) => {
      const target = e.target;
      const insideNode =
        target instanceof Node &&
        nodeMenuRef.current &&
        nodeMenuRef.current.contains(target);
      const insideEdge =
        target instanceof Node &&
        edgeMenuRef.current &&
        edgeMenuRef.current.contains(target);
      if (insideNode || insideEdge) return;
      setNodeMenu(undefined);
      setEdgeMenu(undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNodeMenu(undefined);
        setEdgeMenu(undefined);
      }
    };
    // Defer so the contextmenu event that opened us doesn't also close us.
    const t = setTimeout(() => {
      window.addEventListener('mousedown', dismiss);
      window.addEventListener('contextmenu', dismiss);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('contextmenu', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [nodeMenu, edgeMenu]);

  // Ctrl+Z / Cmd+Z: undo the last destructive action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
      if (!isUndo) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      const entry = undoStackRef.current.pop();
      if (!entry) return;
      e.preventDefault();
      for (const el of entry.removedElements) {
        void requestMutation({ kind: 'restoreElement', element: el });
      }
      updateDiagram(entry.diagram);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [updateDiagram]);

  const edgeMenuRel = (() => {
    if (!edgeMenu) return undefined;
    const diagram = state.diagram;
    const model = state.model;
    if (!diagram || !model) return undefined;
    const edge = diagram.edges.find(e => e.id === edgeMenu.viewEdgeId);
    if (!edge) return undefined;
    const rel = model.elements[edge.elementId];
    if (!rel || rel.kind !== 'Relationship') return undefined;
    return rel;
  })();

  return (
    <>
      <Toolbar
        diagram={state.diagram}
        model={state.model}
        issues={state.issues}
        onAddClass={handleAddClass}
        onAddInterface={handleAddInterface}
        onAddModelClass={handleAddFromModel}
        fitActive={fitActive}
        onToggleFit={handleToggleFit}
        zoomPercent={zoomPct}
        onZoomIn={() => panZoomRef.current?.zoomIn()}
        onZoomOut={() => panZoomRef.current?.zoomOut()}
        onZoomReset={() => panZoomRef.current?.reset()}
      />
      <div className="vsuml-canvas" ref={canvasRef} tabIndex={0} />
      {nodeMenu && (
        <PopupMenu
          ref={nodeMenuRef}
          x={nodeMenu.x}
          y={nodeMenu.y}
          items={[
            {
              label: 'Delete',
              shortcut: 'Del',
              onClick: () => {
                const id = nodeMenu.viewNodeId;
                setNodeMenu(undefined);
                void callbacks.onNodeDeleted(id);
              }
            }
          ]}
        />
      )}
      {edgeMenu && edgeMenuRel && (
        <PopupMenu
          ref={edgeMenuRef}
          x={edgeMenu.x}
          y={edgeMenu.y}
          items={[
            ...(
              ['Association', 'Aggregation', 'Generalization', 'Dependency'] as const
            ).map(k => ({
              label: k,
              icon: <EdgeKindIcon kind={k} />,
              shortcut: k === edgeMenuRel.relKind ? '✓' : '',
              onClick: () => {
                const relId = edgeMenuRel.id;
                setEdgeMenu(undefined);
                if (k === edgeMenuRel.relKind) return;
                void requestMutation({
                  kind: 'updateElement',
                  id: relId,
                  patch: { relKind: k }
                });
              }
            })),
            { separator: true } as const,
            {
              label: 'Delete',
              shortcut: 'Del',
              onClick: () => {
                const id = edgeMenu.viewEdgeId;
                setEdgeMenu(undefined);
                void callbacks.onEdgeDeleted(id);
              }
            }
          ]}
        />
      )}
    </>
  );
};

const EDGE_ICON_W = 56;
const EDGE_ICON_H = 14;

const EdgeKindIcon: React.FC<{ kind: RelationshipKind }> = ({ kind }) => {
  const cy = EDGE_ICON_H / 2;
  // Use currentColor so the icon follows menu text color (incl. hover).
  // Fill the closed heads with the menu background so they read as
  // "hollow" against any theme.
  const fill = 'var(--vscode-menu-background)';
  switch (kind) {
    case 'Association':
      return (
        <svg width={EDGE_ICON_W} height={EDGE_ICON_H} aria-hidden>
          <line x1={2} y1={cy} x2={46} y2={cy} stroke="currentColor" />
          <path
            d={`M 46 ${cy - 4} L 54 ${cy} L 46 ${cy + 4}`}
            fill="none"
            stroke="currentColor"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'Aggregation':
      return (
        <svg width={EDGE_ICON_W} height={EDGE_ICON_H} aria-hidden>
          <path
            d={`M 2 ${cy} L 9 ${cy - 4} L 16 ${cy} L 9 ${cy + 4} z`}
            fill={fill}
            stroke="currentColor"
            strokeLinejoin="round"
          />
          <line x1={16} y1={cy} x2={54} y2={cy} stroke="currentColor" />
        </svg>
      );
    case 'Generalization':
      return (
        <svg width={EDGE_ICON_W} height={EDGE_ICON_H} aria-hidden>
          <line x1={2} y1={cy} x2={42} y2={cy} stroke="currentColor" />
          <path
            d={`M 42 ${cy - 5} L 53 ${cy} L 42 ${cy + 5} z`}
            fill={fill}
            stroke="currentColor"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'Dependency':
      return (
        <svg width={EDGE_ICON_W} height={EDGE_ICON_H} aria-hidden>
          <line
            x1={2}
            y1={cy}
            x2={46}
            y2={cy}
            stroke="currentColor"
            strokeDasharray="3 2"
          />
          <path
            d={`M 46 ${cy - 4} L 54 ${cy} L 46 ${cy + 4}`}
            fill="none"
            stroke="currentColor"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
};

function edgeExistsBetween(
  diagram: ClassDiagramFile,
  a: string,
  b: string
): boolean {
  return diagram.edges.some(
    e =>
      (e.sourceNodeId === a && e.targetNodeId === b) ||
      (e.sourceNodeId === b && e.targetNodeId === a)
  );
}

function makeId(): string {
  return (
    'v_' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');
createRoot(container).render(<App />);
