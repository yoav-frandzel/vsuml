/**
 * State Diagram webview entry point.
 *
 * Uses maxGraph because a state machine maps cleanly to a graph engine
 * (rounded-rectangle nodes + directed transition edges).
 */

import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Graph, type FitPlugin } from '@maxgraph/core';
import { onHostMessage, post } from '../vscode-api.js';
import { requestMutation, resolveAck } from '../shared/rpc.js';
import type {
  ModelFile,
  StateDiagramEdge,
  StateDiagramFile,
  StateDiagramNode,
  StateKind,
  ValidationIssue
} from '../../model/index.js';
import {
  StateDiagramRenderer,
  type StateRendererCallbacks
} from './renderer.js';

interface AppState {
  model: ModelFile | undefined;
  diagram: StateDiagramFile | undefined;
  issues: ValidationIssue[];
}

const App: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const rendererRef = useRef<StateDiagramRenderer | null>(null);

  const [state, setState] = useState<AppState>({
    model: undefined,
    diagram: undefined,
    issues: []
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const updateDiagram = useCallback((next: StateDiagramFile) => {
    setState(prev => ({ ...prev, diagram: next }));
    post({ type: 'view.updateDiagram', diagram: next });
    if (rendererRef.current && stateRef.current.model) {
      rendererRef.current.sync(stateRef.current.model, next);
    }
  }, []);

  const callbacks: StateRendererCallbacks = {
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

      const trigger = window.prompt('Trigger event (optional)') ?? undefined;
      const guard = window.prompt('Guard expression (optional)') ?? undefined;
      const effect = window.prompt('Effect / action (optional)') ?? undefined;

      const created = await requestMutation<{ id: string }>({
        kind: 'createTransition',
        stateMachineId: cur.stateMachineId,
        sourceStateId: sourceNode.elementId,
        targetStateId: targetNode.elementId,
        trigger: trigger || undefined,
        guard: guard || undefined,
        effect: effect || undefined
      });
      if (!created) return;
      const edge: StateDiagramEdge = {
        id: makeId(),
        elementId: created.id,
        sourceNodeId,
        targetNodeId
      };
      updateDiagram({ ...cur, edges: [...cur.edges, edge] });
    },
    onNodeDoubleClicked: async elementId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const el = model.elements[elementId];
      if (!el || el.kind !== 'State') return;
      const name = window.prompt('Rename state', el.name);
      if (!name) return;
      await requestMutation({
        kind: 'renameElement',
        id: elementId,
        name: name.trim()
      });
    },
    onEdgeDoubleClicked: async elementId => {
      const cur = stateRef.current.diagram;
      const model = stateRef.current.model;
      if (!cur || !model) return;
      const el = model.elements[elementId];
      if (!el || el.kind !== 'Transition') return;
      const trigger = window.prompt('Trigger', el.trigger ?? '') ?? undefined;
      const guard = window.prompt('Guard', el.guard ?? '') ?? undefined;
      const effect = window.prompt('Effect', el.effect ?? '') ?? undefined;
      await requestMutation({
        kind: 'updateElement',
        id: elementId,
        patch: {
          trigger: trigger || undefined,
          guard: guard || undefined,
          effect: effect || undefined
        }
      });
    }
  };

  // Init graph.
  useEffect(() => {
    if (!canvasRef.current) return;
    const graph = new Graph(canvasRef.current);
    graphRef.current = graph;
    rendererRef.current = new StateDiagramRenderer(graph, callbacks);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const selected = graph.getSelectionCells();
      if (selected.length === 0) return;
      const cur = stateRef.current.diagram;
      if (!cur) return;
      let nextNodes = cur.nodes;
      let nextEdges = cur.edges;
      const removedNodeIds: string[] = [];
      for (const cell of selected) {
        const id = cell.getId();
        if (!id) continue;
        if (id.startsWith('snode:')) {
          const viewId = id.slice('snode:'.length);
          const node = cur.nodes.find(n => n.id === viewId);
          if (!node) continue;
          removedNodeIds.push(viewId);
          nextNodes = nextNodes.filter(n => n.id !== viewId);
          nextEdges = nextEdges.filter(
            e => e.sourceNodeId !== viewId && e.targetNodeId !== viewId
          );
          // Remove the model element (state) too.
          void requestMutation({ kind: 'deleteElement', id: node.elementId });
        } else if (id.startsWith('sedge:')) {
          const viewId = id.slice('sedge:'.length);
          const edge = cur.edges.find(e => e.id === viewId);
          if (!edge) continue;
          nextEdges = nextEdges.filter(e => e.id !== viewId);
          void requestMutation({ kind: 'deleteElement', id: edge.elementId });
        }
      }
      updateDiagram({ ...cur, nodes: nextNodes, edges: nextEdges });
    };
    graph.getContainer().addEventListener('keydown', onKeyDown);
    graph.getContainer().tabIndex = 0;
    return () => {
      graph.getContainer().removeEventListener('keydown', onKeyDown);
      graph.destroy();
      graphRef.current = null;
      rendererRef.current = null;
    };
  }, [updateDiagram]);

  // Host messages.
  useEffect(() => {
    const off = onHostMessage(msg => {
      switch (msg.type) {
        case 'host.init':
          if (msg.diagram.kind === 'StateDiagram') {
            setState({
              model: msg.model,
              diagram: msg.diagram as StateDiagramFile,
              issues: []
            });
            if (rendererRef.current) {
              rendererRef.current.sync(msg.model, msg.diagram as StateDiagramFile);
            }
          }
          break;
        case 'host.modelChanged':
          setState(prev => {
            const cur = prev.diagram;
            if (cur && rendererRef.current) {
              rendererRef.current.sync(msg.model, cur);
            }
            return { ...prev, model: msg.model };
          });
          break;
        case 'host.diagramChanged':
          if (msg.diagram.kind === 'StateDiagram') {
            const dg = msg.diagram as StateDiagramFile;
            setState(prev => {
              if (prev.model && rendererRef.current) {
                rendererRef.current.sync(prev.model, dg);
              }
              return { ...prev, diagram: dg };
            });
          }
          break;
        case 'host.validation':
          setState(prev => ({ ...prev, issues: msg.issues }));
          break;
        case 'host.ack':
          resolveAck(msg);
          break;
      }
    });
    post({ type: 'view.ready' });
    return off;
  }, []);

  /* --- Toolbar actions --- */

  const addState = useCallback(
    async (stateKind: StateKind) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const defaultName =
        stateKind === 'Initial'
          ? '(initial)'
          : stateKind === 'Final'
            ? '(final)'
            : stateKind === 'Choice'
              ? '(choice)'
              : 'NewState';
      const name =
        stateKind === 'Simple' || stateKind === 'Composite'
          ? window.prompt('State name', defaultName) ?? undefined
          : defaultName;
      if (!name) return;
      const created = await requestMutation<{ id: string }>({
        kind: 'createState',
        stateMachineId: cur.stateMachineId,
        name: name.trim(),
        stateKind
      });
      if (!created) return;
      const offset = cur.nodes.length * 30;
      const node: StateDiagramNode = {
        id: makeId(),
        elementId: created.id,
        x: 100 + offset,
        y: 100 + offset,
        width: stateKind === 'Initial' || stateKind === 'Final' || stateKind === 'Choice' ? 28 : 140,
        height: stateKind === 'Initial' || stateKind === 'Final' || stateKind === 'Choice' ? 28 : 50
      };
      updateDiagram({ ...cur, nodes: [...cur.nodes, node] });
    },
    [updateDiagram]
  );

  const handleFit = () => {
    graphRef.current?.getPlugin<FitPlugin>('fit')?.fit({ margin: 24 });
  };

  return (
    <>
      <div className="vsuml-toolbar">
        <strong>{state.diagram?.name ?? 'State Diagram'}</strong>
        <button onClick={() => addState('Simple')}>+ State</button>
        <button onClick={() => addState('Initial')}>+ Initial</button>
        <button onClick={() => addState('Final')}>+ Final</button>
        <button onClick={() => addState('Choice')}>+ Choice</button>
        <button onClick={handleFit}>Fit</button>
        <span className="vsuml-toolbar-info">
          {state.diagram?.nodes.length ?? 0} state(s) · {state.diagram?.edges.length ?? 0} transition(s)
          {state.issues.length > 0 && ` · ⚠ ${state.issues.length} issue(s)`}
        </span>
      </div>
      <div ref={canvasRef} className="vsuml-canvas" tabIndex={0}/>
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
