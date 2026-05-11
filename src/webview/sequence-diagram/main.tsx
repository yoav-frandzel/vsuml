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
import {
  confirm,
  requestMutation,
  resolveAck,
  showInputBox,
  showMessage,
  showQuickPick
} from '../shared/rpc.js';
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
        case 'host.addElement': {
          const cur = stateRef.current.diagram;
          const model = stateRef.current.model;
          if (!cur || !model) break;
          const el = model.elements[msg.elementId];
          if (!el || (el.kind !== 'Class' && el.kind !== 'Interface')) break;
          if (cur.lifelines.some(l => l.representsId === el.id)) break;
          const lifeline: Lifeline = {
            id: makeId(),
            representsId: el.id,
            x: 0,
            y: 0,
            width: LIFELINE_HEADER_W,
            height: LIFELINE_HEADER_H
          };
          updateDiagram({ ...cur, lifelines: [...cur.lifelines, lifeline] });
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

  /* --- Toolbar actions --- */

  const handleAddLifeline = useCallback(async () => {
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
      showMessage(
        'info',
        'No more model classifiers to add. Create one in a class diagram first.'
      );
      return;
    }
    const picked = await showQuickPick(
      candidates.map(c => ({ label: c.name, description: c.kind, detail: c.id })),
      { placeHolder: 'Pick a classifier to add as a lifeline' }
    );
    if (!picked || !picked.detail) return;
    const lifeline: Lifeline = {
      id: makeId(),
      representsId: picked.detail,
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
      showMessage('warn', 'Add at least one lifeline first.');
      return;
    }
    const lifelineItems = cur.lifelines.map(l => ({
      label: lifelineLabel(model, l),
      detail: l.id
    }));
    const src = await showQuickPick(lifelineItems, {
      placeHolder: 'Source lifeline (caller)'
    });
    if (!src || !src.detail) return;
    const tgt = await showQuickPick(lifelineItems, {
      placeHolder: 'Target lifeline (callee)'
    });
    if (!tgt || !tgt.detail) return;

    const kindPick = await showQuickPick(
      [
        { label: 'sync', description: 'synchronous call (solid filled arrow)' },
        { label: 'async', description: 'asynchronous call (open arrow)' },
        { label: 'reply', description: 'return value (dashed)' },
        { label: 'create', description: 'object creation' },
        { label: 'destroy', description: 'object destruction' }
      ],
      { placeHolder: 'Message kind' }
    );
    if (!kindPick) return;
    const kind = kindPick.label as SequenceMessage['kind'];

    const target = cur.lifelines.find(l => l.id === tgt.detail);
    if (!target) return;
    let operationId: string | undefined;
    let label: string | undefined;

    if (kind === 'sync' || kind === 'async') {
      const targetClass = model.elements[target.representsId];
      if (!targetClass) {
        showMessage('error', "Target lifeline's classifier is missing.");
        return;
      }
      const ops = Object.values(model.elements).filter(
        e => e.kind === 'Operation' && e.ownerId === target.representsId
      );
      if (ops.length === 0) {
        const create = await confirm(
          `${targetClass.name} has no operations. Create one to invoke?`,
          'Create operation'
        );
        if (!create) return;
        const opName = await showInputBox({
          prompt: 'Operation name',
          value: 'doSomething'
        });
        if (!opName) return;
        const created = await requestMutation<{ id: string }>({
          kind: 'createOperation',
          classifierId: target.representsId,
          name: opName.trim()
        });
        if (!created) return;
        operationId = created.id;
      } else {
        const opPick = await showQuickPick(
          ops.map(o => ({ label: o.name, detail: o.id })),
          { placeHolder: `Which operation on ${targetClass.name}?` }
        );
        if (!opPick || !opPick.detail) return;
        operationId = opPick.detail;
      }
    } else {
      label = await showInputBox({
        prompt: 'Message label (optional)',
        placeHolder: kind === 'reply' ? 'return value' : ''
      });
    }

    const nextY =
      cur.messages.length === 0
        ? FIRST_MESSAGE_Y
        : Math.max(...cur.messages.map(m => m.y)) + MESSAGE_ROW_H;

    const msg: SequenceMessage = {
      id: makeId(),
      sourceLifelineId: src.detail,
      targetLifelineId: target.id,
      kind,
      y: nextY,
      operationId,
      label
    };
    updateDiagram({ ...cur, messages: [...cur.messages, msg] });
  }, [updateDiagram]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const cur = stateRef.current.diagram;
    if (!cur) return;
    if (cur.lifelines.some(l => l.id === selected)) {
      const remove = await confirm(
        'Remove this lifeline and all its messages from the diagram?',
        'Remove'
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
