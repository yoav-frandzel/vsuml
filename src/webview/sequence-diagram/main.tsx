/**
 * Sequence Diagram webview entry point.
 *
 * Custom React + SVG renderer. maxGraph isn't a clean fit for sequence
 * diagrams (time axis + vertical lifelines), so we render directly and
 * keep the code small.
 */

import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onHostMessage, post } from '../vscode-api.js';
import { requestMutation, resolveAck } from '../shared/rpc.js';
import type {
  Lifeline,
  ModelFile,
  SequenceDiagramFile,
  SequenceMessage,
  ValidationIssue
} from '../../model/index.js';
import {
  FIRST_MESSAGE_Y,
  LIFELINE_HEADER_H,
  LIFELINE_HEADER_W,
  LIFELINE_TOP,
  MESSAGE_ROW_H,
  layoutSequence,
  lifelineLabel,
  messageLabel,
  sortMessages
} from './layout.js';

interface AppState {
  model: ModelFile | undefined;
  diagram: SequenceDiagramFile | undefined;
  issues: ValidationIssue[];
}

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    model: undefined,
    diagram: undefined,
    issues: []
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [selected, setSelected] = useState<string | undefined>();

  const updateDiagram = useCallback((next: SequenceDiagramFile) => {
    setState(prev => ({ ...prev, diagram: next }));
    post({ type: 'view.updateDiagram', diagram: next });
  }, []);

  useEffect(() => {
    const off = onHostMessage(msg => {
      switch (msg.type) {
        case 'host.init':
          if (msg.diagram.kind === 'SequenceDiagram') {
            setState({
              model: msg.model,
              diagram: msg.diagram as SequenceDiagramFile,
              issues: []
            });
          }
          break;
        case 'host.modelChanged':
          setState(prev => ({ ...prev, model: msg.model }));
          break;
        case 'host.diagramChanged':
          if (msg.diagram.kind === 'SequenceDiagram') {
            setState(prev => ({
              ...prev,
              diagram: msg.diagram as SequenceDiagramFile
            }));
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

  const handleAddLifeline = useCallback(() => {
    const model = stateRef.current.model;
    const cur = stateRef.current.diagram;
    if (!model || !cur) return;
    const onDiagram = new Set(cur.lifelines.map(l => l.representsId));
    const candidates = Object.values(model.elements).filter(
      e =>
        (e.kind === 'Class' || e.kind === 'Interface') &&
        !onDiagram.has(e.id)
    );
    if (candidates.length === 0) {
      window.alert('No more model classifiers to add. Create one in a class diagram first.');
      return;
    }
    const choice = window.prompt(
      'Add which classifier as a lifeline? Enter name.\n\n' +
        candidates.map(c => `  • ${c.name} (${c.kind})`).join('\n'),
      candidates[0].name
    );
    if (!choice) return;
    const picked = candidates.find(c => c.name === choice.trim());
    if (!picked) {
      window.alert(`No classifier named "${choice}".`);
      return;
    }
    const lifeline: Lifeline = {
      id: makeId(),
      representsId: picked.id,
      x: 0,
      y: 0,
      width: LIFELINE_HEADER_W,
      height: LIFELINE_HEADER_H
    };
    updateDiagram({ ...cur, lifelines: [...cur.lifelines, lifeline] });
  }, [updateDiagram]);

  const handleAddMessage = useCallback(async () => {
    const model = stateRef.current.model;
    const cur = stateRef.current.diagram;
    if (!model || !cur) return;
    if (cur.lifelines.length < 1) {
      window.alert('Add at least one lifeline first.');
      return;
    }
    const lifelinesList = cur.lifelines
      .map((l, i) => `  ${i + 1}. ${lifelineLabel(model, l)}`)
      .join('\n');
    const srcIdx = parseInt(
      window.prompt(`Source lifeline? Enter number:\n\n${lifelinesList}`, '1') ?? '',
      10
    );
    if (!Number.isFinite(srcIdx) || srcIdx < 1 || srcIdx > cur.lifelines.length) return;
    const tgtIdx = parseInt(
      window.prompt(`Target lifeline? Enter number:\n\n${lifelinesList}`, String(srcIdx)) ?? '',
      10
    );
    if (!Number.isFinite(tgtIdx) || tgtIdx < 1 || tgtIdx > cur.lifelines.length) return;
    const kind = (window.prompt(
      'Message kind? sync / async / reply / create / destroy',
      'sync'
    ) ?? '').trim() as SequenceMessage['kind'];
    if (!['sync', 'async', 'reply', 'create', 'destroy'].includes(kind)) {
      window.alert('Unknown kind.');
      return;
    }

    const target = cur.lifelines[tgtIdx - 1];
    let operationId: string | undefined;
    let label: string | undefined;

    if (kind === 'sync' || kind === 'async') {
      const targetClass = model.elements[target.representsId];
      if (!targetClass) {
        window.alert("Target lifeline's classifier is missing.");
        return;
      }
      const ops = Object.values(model.elements).filter(
        e => e.kind === 'Operation' && e.ownerId === target.representsId
      );
      if (ops.length === 0) {
        const create = window.confirm(
          `${targetClass.name} has no operations.\nCreate one to invoke?`
        );
        if (!create) return;
        const opName = window.prompt('Operation name', 'doSomething');
        if (!opName) return;
        const created = (await requestMutation<{ id: string }>({
          kind: 'createOperation',
          classifierId: target.representsId,
          name: opName.trim()
        }));
        if (!created) return;
        operationId = created.id;
      } else {
        const choice = window.prompt(
          'Which operation?\n\n' +
            ops.map(o => `  • ${o.name}`).join('\n'),
          ops[0].name
        );
        if (!choice) return;
        const picked = ops.find(o => o.name === choice.trim());
        if (!picked) {
          window.alert(`No operation named "${choice}".`);
          return;
        }
        operationId = picked.id;
      }
    } else {
      label = window.prompt('Message label (optional)') ?? undefined;
    }

    const nextY =
      cur.messages.length === 0
        ? FIRST_MESSAGE_Y
        : Math.max(...cur.messages.map(m => m.y)) + MESSAGE_ROW_H;

    const msg: SequenceMessage = {
      id: makeId(),
      sourceLifelineId: cur.lifelines[srcIdx - 1].id,
      targetLifelineId: target.id,
      kind,
      y: nextY,
      operationId,
      label
    };
    updateDiagram({ ...cur, messages: [...cur.messages, msg] });
  }, [updateDiagram]);

  const handleDelete = useCallback(() => {
    if (!selected) return;
    const cur = stateRef.current.diagram;
    if (!cur) return;
    // Lifeline?
    if (cur.lifelines.some(l => l.id === selected)) {
      const remove = window.confirm(
        'Remove this lifeline and all its messages from the diagram?'
      );
      if (!remove) return;
      updateDiagram({
        ...cur,
        lifelines: cur.lifelines.filter(l => l.id !== selected),
        messages: cur.messages.filter(
          m => m.sourceLifelineId !== selected && m.targetLifelineId !== selected
        )
      });
      setSelected(undefined);
      return;
    }
    // Message?
    if (cur.messages.some(m => m.id === selected)) {
      updateDiagram({
        ...cur,
        messages: cur.messages.filter(m => m.id !== selected)
      });
      setSelected(undefined);
    }
  }, [selected, updateDiagram]);

  // Keyboard delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') handleDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDelete]);

  return (
    <>
      <div className="vsuml-toolbar">
        <strong>{state.diagram?.name ?? 'Sequence Diagram'}</strong>
        <button onClick={handleAddLifeline}>+ Lifeline</button>
        <button onClick={handleAddMessage}>+ Message</button>
        <button onClick={handleDelete} disabled={!selected}>Delete</button>
        <span className="vsuml-toolbar-info">
          {state.diagram?.lifelines.length ?? 0} lifeline(s) · {state.diagram?.messages.length ?? 0} message(s)
          {state.issues.length > 0 && ` · ⚠ ${state.issues.length} issue(s)`}
        </span>
      </div>
      <div className="vsuml-canvas" style={{ overflow: 'auto', padding: 16 }} tabIndex={0}>
        {state.diagram ? (
          <SequenceSvg
            model={state.model}
            diagram={state.diagram}
            selected={selected}
            onSelect={setSelected}
            onReorder={(messages) => {
              const cur = stateRef.current.diagram;
              if (cur) updateDiagram({ ...cur, messages });
            }}
          />
        ) : (
          'Loading…'
        )}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* SVG                                                                  */
/* ------------------------------------------------------------------ */

interface SequenceSvgProps {
  model: ModelFile | undefined;
  diagram: SequenceDiagramFile;
  selected: string | undefined;
  onSelect(id: string | undefined): void;
  onReorder(messages: SequenceMessage[]): void;
}

const SequenceSvg: React.FC<SequenceSvgProps> = ({
  model,
  diagram,
  selected,
  onSelect,
  onReorder
}) => {
  const layout = layoutSequence(diagram);
  const sorted = sortMessages(diagram.messages);

  // Track dragging state for vertical message reorder.
  const dragRef = useRef<{ id: string; startY: number; origY: number } | null>(null);
  const [dragY, setDragY] = useState<{ id: string; y: number } | null>(null);

  const onMouseDownMessage = (e: React.MouseEvent, m: SequenceMessage) => {
    e.stopPropagation();
    onSelect(m.id);
    dragRef.current = { id: m.id, startY: e.clientY, origY: m.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    setDragY({ id: dragRef.current.id, y: dragRef.current.origY + dy });
  };
  const onMouseUp = () => {
    if (!dragRef.current || !dragY) {
      dragRef.current = null;
      setDragY(null);
      return;
    }
    const id = dragRef.current.id;
    const newY = Math.max(FIRST_MESSAGE_Y, dragY.y);
    dragRef.current = null;
    setDragY(null);
    onReorder(diagram.messages.map(m => (m.id === id ? { ...m, y: newY } : m)));
  };

  return (
    <svg
      width={layout.totalWidth}
      height={layout.totalHeight}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={() => onSelect(undefined)}
      style={{ userSelect: 'none', display: 'block' }}
    >
      <defs>
        <marker id="sm-sync" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto">
          <path d="M 0 0 L 12 6 L 0 12 z" fill="currentColor" />
        </marker>
        <marker id="sm-async" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto">
          <path d="M 0 0 L 12 6 L 0 12" fill="none" stroke="currentColor" />
        </marker>
        <marker id="sm-open" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto">
          <path d="M 0 0 L 12 6 L 0 12" fill="none" stroke="currentColor" />
        </marker>
      </defs>

      {/* Lifelines */}
      {diagram.lifelines.map(l => {
        const cx = layout.lifelineX.get(l.id) ?? 0;
        const isSelected = selected === l.id;
        return (
          <g key={l.id} onClick={e => { e.stopPropagation(); onSelect(l.id); }}>
            <rect
              x={cx - LIFELINE_HEADER_W / 2}
              y={LIFELINE_TOP}
              width={LIFELINE_HEADER_W}
              height={LIFELINE_HEADER_H}
              rx={4}
              fill="var(--vscode-editorWidget-background)"
              stroke={isSelected ? 'var(--vscode-focusBorder)' : 'var(--vscode-foreground)'}
              strokeWidth={isSelected ? 2 : 1}
              style={{ cursor: 'pointer' }}
            />
            <text
              x={cx}
              y={LIFELINE_TOP + LIFELINE_HEADER_H / 2 + 4}
              textAnchor="middle"
              fill="var(--vscode-editor-foreground)"
              fontSize={12}
              fontFamily="var(--vscode-font-family)"
            >
              {lifelineLabel(model, l)}
            </text>
            <line
              x1={cx}
              y1={LIFELINE_TOP + LIFELINE_HEADER_H}
              x2={cx}
              y2={layout.stemBottom}
              stroke="var(--vscode-foreground)"
              strokeDasharray="4 4"
              opacity={0.5}
            />
          </g>
        );
      })}

      {/* Messages */}
      {sorted.map(m => {
        const fromX = layout.lifelineX.get(m.sourceLifelineId);
        const toX = layout.lifelineX.get(m.targetLifelineId);
        if (fromX === undefined || toX === undefined) return null;
        const isDrag = dragY?.id === m.id;
        const y = isDrag ? dragY!.y : m.y;
        const isSelfMessage = m.sourceLifelineId === m.targetLifelineId;
        const isSelected = selected === m.id;
        const colour = isSelected ? 'var(--vscode-focusBorder)' : 'var(--vscode-editor-foreground)';
        const isDashed = m.kind === 'reply';
        const marker = m.kind === 'sync' ? 'sm-sync' : 'sm-open';
        const label = messageLabel(model, m);
        if (isSelfMessage) {
          const x = fromX;
          const w = 40;
          return (
            <g
              key={m.id}
              style={{ cursor: 'grab', color: colour }}
              onMouseDown={e => onMouseDownMessage(e, m)}
            >
              <path
                d={`M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + 18} L ${x + 4} ${y + 18}`}
                fill="none"
                stroke={colour}
                strokeDasharray={isDashed ? '4 4' : undefined}
                markerEnd={`url(#${marker})`}
              />
              <text x={x + w + 6} y={y + 4} fill={colour} fontSize={11}>
                {label}
              </text>
            </g>
          );
        }
        return (
          <g
            key={m.id}
            style={{ cursor: 'grab', color: colour }}
            onMouseDown={e => onMouseDownMessage(e, m)}
          >
            <line
              x1={fromX}
              y1={y}
              x2={toX}
              y2={y}
              stroke={colour}
              strokeDasharray={isDashed ? '4 4' : undefined}
              markerEnd={`url(#${marker})`}
              strokeWidth={isSelected ? 2 : 1}
            />
            <text
              x={(fromX + toX) / 2}
              y={y - 4}
              textAnchor="middle"
              fill={colour}
              fontSize={11}
              fontFamily="var(--vscode-font-family)"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/* ------------------------------------------------------------------ */

function makeId(): string {
  return (
    'v_' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

// Awaitable wrapper kept simple — sequence diagrams currently only call
// `requestMutation` directly; remove this stub if you don't extend.
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');
createRoot(container).render(<App />);
