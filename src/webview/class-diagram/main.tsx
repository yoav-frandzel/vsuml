/**
 * Class Diagram webview entry point.
 *
 * Owns: render state, maxGraph instance, the renderer that bridges model
 * data to maxGraph cells, and the dispatch loop that turns user gestures
 * into messages back to the extension host.
 */

import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Graph, type FitPlugin } from '@maxgraph/core';
import { onHostMessage, post, log } from '../vscode-api.js';
import {
  confirm,
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
  ModelFile,
  ValidationIssue
} from '../../model/index.js';
import {
  ClassDiagramRenderer,
  type ClassRendererCallbacks
} from './renderer.js';
import { Toolbar, type RelationshipKind } from './toolbar.js';

interface AppState {
  model: ModelFile | undefined;
  diagram: ClassDiagramFile | undefined;
  issues: ValidationIssue[];
}

const App: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const rendererRef = useRef<ClassDiagramRenderer | null>(null);

  const [state, setState] = useState<AppState>({
    model: undefined,
    diagram: undefined,
    issues: []
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const [edgeKind, setEdgeKind] = useState<RelationshipKind>('Association');
  const edgeKindRef = useRef(edgeKind);
  edgeKindRef.current = edgeKind;

  const [nodeMenu, setNodeMenu] = useState<
    { viewNodeId: string; x: number; y: number } | undefined
  >();

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
      const kind = edgeKindRef.current;
      const result = await requestMutation<{ id: string }>({
        kind: 'createRelationship',
        relKind: kind,
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
        'Generalization',
        'Dependency'
      ];
      const picked = await showQuickPick(
        kinds.map(k => ({
          label: k,
          description: k === rel.relKind ? '(current)' : '',
          detail: k
        })),
        { placeHolder: 'Change edge type' }
      );
      if (!picked || !picked.detail || picked.detail === rel.relKind) return;
      void requestMutation({
        kind: 'updateElement',
        id: rel.id,
        patch: { relKind: picked.detail }
      });
    },
    onNodeDeleted: async viewNodeId => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const node = cur.nodes.find(n => n.id === viewNodeId);
      if (!node) return;
      const remove = await confirm(
        'Remove this view node from the diagram? (The class stays in the model.)',
        'Remove'
      );
      if (!remove) return;
      const nextEdges = cur.edges.filter(
        e => e.sourceNodeId !== viewNodeId && e.targetNodeId !== viewNodeId
      );
      updateDiagram({
        ...cur,
        nodes: cur.nodes.filter(n => n.id !== viewNodeId),
        edges: nextEdges
      });
    },
    onNodeContextMenu: (viewNodeId, x, y) => {
      setNodeMenu({ viewNodeId, x, y });
    },
    onEdgeDeleted: async viewEdgeId => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const edge = cur.edges.find(e => e.id === viewEdgeId);
      if (!edge) return;
      const removeModel = await confirm(
        'Also delete the underlying relationship from the model? (Cancel removes from this diagram only.)',
        'Delete from model'
      );
      if (removeModel) {
        void requestMutation({ kind: 'deleteElement', id: edge.elementId });
      }
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
    graphRef.current = graph;
    const renderer = new ClassDiagramRenderer(graph, {
      onNodesMoved: m => callbacksRef.current.onNodesMoved(m),
      onEdgeRequested: m => callbacksRef.current.onEdgeRequested(m),
      onNodeActivated: id => callbacksRef.current.onNodeActivated(id),
      onEdgeActivated: id => callbacksRef.current.onEdgeActivated(id),
      onNodeContextMenu: (id, x, y) =>
        callbacksRef.current.onNodeContextMenu(id, x, y),
      onNodeDeleted: id => callbacksRef.current.onNodeDeleted(id),
      onEdgeDeleted: id => callbacksRef.current.onEdgeDeleted(id)
    });
    rendererRef.current = renderer;
    return () => {
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
        detail: c.id
      })),
      { placeHolder: 'Pick a class or interface to add to the diagram' }
    );
    if (!picked || !picked.detail) return;
    addExistingClassToDiagram(picked.detail);
  }, [addExistingClassToDiagram]);

  const handleAddEdge = useCallback(async () => {
    const cur = stateRef.current.diagram;
    const model = stateRef.current.model;
    if (!cur || !model) return;
    if (cur.nodes.length < 2) {
      showMessage(
        'info',
        'Add at least two classifiers to the diagram before creating an edge.'
      );
      return;
    }
    type EdgePickItem = { label: string; description: string; detail: string };
    const items: EdgePickItem[] = cur.nodes.flatMap(n => {
      const el = model.elements[n.elementId];
      if (!el) return [];
      return [{ label: el.name, description: String(el.kind), detail: n.id }];
    });

    const source = await showQuickPick(items, {
      placeHolder: `Source for new ${edgeKindRef.current}`
    });
    if (!source || !source.detail) return;
    const target = await showQuickPick(
      items.filter(i => i.detail !== source.detail),
      { placeHolder: `Target for new ${edgeKindRef.current}` }
    );
    if (!target || !target.detail) return;

    const sourceNode = cur.nodes.find(n => n.id === source.detail);
    const targetNode = cur.nodes.find(n => n.id === target.detail);
    if (!sourceNode || !targetNode) return;
    const result = await requestMutation<{ id: string }>({
      kind: 'createRelationship',
      relKind: edgeKindRef.current,
      sourceId: sourceNode.elementId,
      targetId: targetNode.elementId
    });
    if (!result) return;
    const latest = stateRef.current.diagram;
    if (!latest) return;
    const newEdge: ClassDiagramEdge = {
      id: makeId(),
      elementId: result.id,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id
    };
    updateDiagram({ ...latest, edges: [...latest.edges, newEdge] });
  }, [updateDiagram]);

  const handleZoomFit = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    const plugin = g.getPlugin<FitPlugin>('fit');
    plugin?.fit({ margin: 24 });
  }, []);

  // Dismiss the node context menu on any document interaction outside it.
  useEffect(() => {
    if (!nodeMenu) return;
    const dismiss = () => setNodeMenu(undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    const t = setTimeout(() => {
      window.addEventListener('mousedown', dismiss, true);
      window.addEventListener('contextmenu', dismiss, true);
      window.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [nodeMenu]);

  return (
    <>
      <Toolbar
        diagram={state.diagram}
        model={state.model}
        issues={state.issues}
        edgeKind={edgeKind}
        onEdgeKindChange={setEdgeKind}
        onAddClass={handleAddClass}
        onAddInterface={handleAddInterface}
        onAddModelClass={handleAddFromModel}
        onAddEdge={handleAddEdge}
        onZoomFit={handleZoomFit}
      />
      <div className="vsuml-canvas" ref={canvasRef} tabIndex={0} />
      {nodeMenu && (
        <div
          role="menu"
          style={{
            position: 'fixed',
            left: nodeMenu.x,
            top: nodeMenu.y,
            zIndex: 1000,
            background: 'var(--vscode-menu-background)',
            color: 'var(--vscode-menu-foreground)',
            border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            padding: '4px 0',
            minWidth: 160,
            fontFamily: 'var(--vscode-font-family)',
            fontSize: 12
          }}
          onMouseDown={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button
            role="menuitem"
            onClick={() => {
              const id = nodeMenu.viewNodeId;
              setNodeMenu(undefined);
              void callbacks.onNodeDeleted(id);
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              width: '100%',
              padding: '4px 12px',
              background: 'transparent',
              color: 'inherit',
              border: 0,
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseOver={e => {
              (e.currentTarget as HTMLElement).style.background =
                'var(--vscode-menu-selectionBackground)';
              (e.currentTarget as HTMLElement).style.color =
                'var(--vscode-menu-selectionForeground)';
            }}
            onMouseOut={e => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.color = 'inherit';
            }}
          >
            <span>Delete</span>
            <span style={{ opacity: 0.7, marginLeft: 16 }}>Del</span>
          </button>
        </div>
      )}
    </>
  );
};

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
