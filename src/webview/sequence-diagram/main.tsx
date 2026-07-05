/**
 * Sequence Diagram webview entry point.
 *
 * Custom React + SVG renderer. maxGraph isn't a clean fit for sequence
 * diagrams (time axis + vertical lifelines), so we render directly and
 * keep the code small.
 */

import { createRoot } from 'react-dom/client';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onHostMessage, post } from '../vscode-api.js';
import {
  requestMutation,
  resolveAck,
  showInputBox,
  showMessage,
  showQuickPick
} from '../shared/rpc.js';
import { PopupMenu, useDismissOnOutsideClick } from '../shared/popup-menu.js';
import { installScrollPan } from '../shared/pan.js';
import type {
  Lifeline,
  ModelFile,
  Operation,
  Relationship,
  SequenceDiagramFile,
  SequenceMessage,
  ValidationIssue
} from '../../model/index.js';
import {
  FIRST_MESSAGE_Y,
  LIFELINE_HEADER_H,
  LIFELINE_HEADER_W,
  LIFELINE_TOP,
  layoutSequence,
  lifelineLabel,
  messageLabel,
  sortMessages,
  type SequenceLayout
} from './layout.js';

/**
 * Collect the classifier id plus all ancestor ids reachable via
 * Generalization relationships (source = child, target = parent).
 */
function collectAncestorIds(model: ModelFile, classifierId: string): string[] {
  const result: string[] = [classifierId];
  const visited = new Set<string>([classifierId]);
  const rels = Object.values(model.elements).filter(
    (e): e is Relationship => e.kind === 'Relationship' && e.relKind === 'Generalization'
  );
  const queue = [classifierId];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const r of rels) {
      if (r.sourceId === cur && !visited.has(r.targetId)) {
        visited.add(r.targetId);
        result.push(r.targetId);
        queue.push(r.targetId);
      }
    }
  }
  return result;
}

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
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomAnchorRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    return installScrollPan(canvasRef.current);
  }, []);

  // Zoom around a client point (defaults to the viewport centre). The scroll
  // adjustment is deferred to a layout effect so it runs after the SVG resizes.
  const applyZoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const el = canvasRef.current;
    setZoom(prev => {
      const next = Math.min(4, Math.max(0.25, prev * factor));
      if (next === prev) return prev;
      if (el) {
        const rect = el.getBoundingClientRect();
        const cx = clientX ?? rect.left + el.clientWidth / 2;
        const cy = clientY ?? rect.top + el.clientHeight / 2;
        const contentX = el.scrollLeft + (cx - rect.left);
        const contentY = el.scrollTop + (cy - rect.top);
        const ratio = next / prev;
        zoomAnchorRef.current = { dx: contentX * (ratio - 1), dy: contentY * (ratio - 1) };
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    const anchor = zoomAnchorRef.current;
    if (el && anchor) {
      el.scrollLeft += anchor.dx;
      el.scrollTop += anchor.dy;
    }
    zoomAnchorRef.current = null;
  }, [zoom]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

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
      candidates.map(c => ({ label: c.name, description: c.kind, elementId: c.id })),
      { placeHolder: 'Pick a classifier to add as a lifeline' }
    );
    if (!picked) return;
    const lifeline: Lifeline = {
      id: makeId(),
      representsId: picked.elementId,
      x: 0,
      y: 0,
      width: LIFELINE_HEADER_W,
      height: LIFELINE_HEADER_H
    };
    updateDiagram({ ...cur, lifelines: [...cur.lifelines, lifeline] });
  }, [updateDiagram]);

  /**
   * Create a sync message between two lifelines at a specific Y, leaving
   * the operation unset. The user binds an operation by right-clicking the
   * resulting message.
   */
  const createMessage = useCallback(
    (sourceLifelineId: string, targetLifelineId: string, dropY: number) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const y = Math.max(FIRST_MESSAGE_Y, dropY);
      const msg: SequenceMessage = {
        id: makeId(),
        sourceLifelineId,
        targetLifelineId,
        kind: 'sync',
        y,
        operationId: undefined,
        label: undefined
      };
      updateDiagram({ ...cur, messages: [...cur.messages, msg] });
    },
    [updateDiagram]
  );

  const handleDelete = useCallback(() => {
    if (!selected) return;
    const cur = stateRef.current.diagram;
    if (!cur) return;
    if (cur.lifelines.some(l => l.id === selected)) {
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
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      handleDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDelete]);

  /* --- Message popup (right-click / double-click on a message) --- */

  const [msgMenu, setMsgMenu] = useState<
    { messageId: string; x: number; y: number } | undefined
  >();
  const msgMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(!!msgMenu, msgMenuRef, () => setMsgMenu(undefined));

  const openMessageMenu = useCallback(
    (messageId: string, clientX: number, clientY: number) => {
      setMsgMenu({ messageId, x: clientX, y: clientY });
    },
    []
  );

  /* --- Lifeline popup (right-click on a lifeline) --- */

  const [lifelineMenu, setLifelineMenu] = useState<
    { lifelineId: string; x: number; y: number } | undefined
  >();
  const lifelineMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(
    !!lifelineMenu,
    lifelineMenuRef,
    () => setLifelineMenu(undefined)
  );

  const openLifelineMenu = useCallback(
    (lifelineId: string, clientX: number, clientY: number) => {
      setLifelineMenu({ lifelineId, x: clientX, y: clientY });
    },
    []
  );

  const deleteLifeline = useCallback(
    (lifelineId: string) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      updateDiagram({
        ...cur,
        lifelines: cur.lifelines.filter(l => l.id !== lifelineId),
        messages: cur.messages.filter(
          m => m.sourceLifelineId !== lifelineId && m.targetLifelineId !== lifelineId
        )
      });
      if (selected === lifelineId) setSelected(undefined);
    },
    [selected, updateDiagram]
  );

  /* --- Message mutations from the popup --- */

  const setMessageOperation = useCallback(
    (messageId: string, operationId: string | undefined) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      updateDiagram({
        ...cur,
        messages: cur.messages.map(m =>
          m.id === messageId ? { ...m, operationId } : m
        )
      });
    },
    [updateDiagram]
  );

  const setMessageKind = useCallback(
    (messageId: string, kind: SequenceMessage['kind']) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      updateDiagram({
        ...cur,
        messages: cur.messages.map(m =>
          m.id === messageId ? { ...m, kind } : m
        )
      });
    },
    [updateDiagram]
  );

  const editMessageLabel = useCallback(
    async (messageId: string) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      const msg = cur.messages.find(m => m.id === messageId);
      if (!msg) return;
      const next = await showInputBox({
        prompt: 'Message label',
        value: msg.label ?? '',
        placeHolder: msg.kind === 'reply' ? 'return value' : ''
      });
      if (next === undefined) return;
      updateDiagram({
        ...cur,
        messages: cur.messages.map(m =>
          m.id === messageId ? { ...m, label: next || undefined } : m
        )
      });
    },
    [updateDiagram]
  );

  const addOperationAndBind = useCallback(
    async (messageId: string, classifierId: string) => {
      const opName = await showInputBox({
        prompt: 'Operation name',
        value: 'doSomething'
      });
      if (!opName) return;
      const created = await requestMutation<{ id: string }>({
        kind: 'createOperation',
        classifierId,
        name: opName.trim()
      });
      if (!created) return;
      setMessageOperation(messageId, created.id);
    },
    [setMessageOperation]
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      const cur = stateRef.current.diagram;
      if (!cur) return;
      updateDiagram({
        ...cur,
        messages: cur.messages.filter(m => m.id !== messageId)
      });
      if (selected === messageId) setSelected(undefined);
    },
    [selected, updateDiagram]
  );

  /* --- Popup items computed from the model + current message --- */

  const msgMenuItems = (() => {
    if (!msgMenu) return null;
    const cur = state.diagram;
    const model = state.model;
    if (!cur || !model) return null;
    const msg = cur.messages.find(m => m.id === msgMenu.messageId);
    if (!msg) return null;
    const targetLifeline = cur.lifelines.find(l => l.id === msg.targetLifelineId);
    const targetClassifier = targetLifeline
      ? model.elements[targetLifeline.representsId]
      : undefined;
    const ops: Operation[] = targetClassifier
      ? (() => {
          const ownerIds = new Set(collectAncestorIds(model, targetClassifier.id));
          return Object.values(model.elements).filter(
            (e): e is Operation =>
              e.kind === 'Operation' && ownerIds.has(e.ownerId!)
          );
        })()
      : [];

    const opItems = ops.map(op => ({
      label: `${op.name}()`,
      checked: msg.operationId === op.id,
      onClick: () => {
        setMsgMenu(undefined);
        setMessageOperation(msg.id, op.id);
      }
    }));

    const kindItems = (
      ['sync', 'async', 'reply', 'create', 'destroy'] as const
    ).map(k => ({
      label: k,
      checked: msg.kind === k,
      onClick: () => {
        setMsgMenu(undefined);
        setMessageKind(msg.id, k);
      }
    }));

    return {
      msg,
      target: targetClassifier,
      ops,
      opItems,
      kindItems
    };
  })();

  return (
    <>
      <div className="vsuml-toolbar">
        <strong>{state.diagram?.name ?? 'Sequence Diagram'}</strong>
        <button onClick={handleAddLifeline}>+ Lifeline</button>
        <span className="vsuml-zoom">
          <button onClick={() => applyZoom(1 / 1.15)} title="Zoom out">−</button>
          <button onClick={() => applyZoom(1 / zoom)} title="Reset zoom to 100%">{Math.round(zoom * 100)}%</button>
          <button onClick={() => applyZoom(1.15)} title="Zoom in">+</button>
        </span>
        <span className="vsuml-toolbar-info">
          Drag from one lifeline to another to add a message · {state.diagram?.lifelines.length ?? 0} lifeline(s) · {state.diagram?.messages.length ?? 0} message(s)
          {state.issues.length > 0 && ` · ⚠ ${state.issues.length} issue(s)`}
          {' · Space/middle-drag to pan · scroll to zoom'}
        </span>
      </div>
      <div ref={canvasRef} className="vsuml-canvas" style={{ overflow: 'auto', padding: 16 }} tabIndex={0}>
        {state.diagram ? (
          <SequenceSvg
            model={state.model}
            diagram={state.diagram}
            selected={selected}
            zoom={zoom}
            onSelect={setSelected}
            onReorder={messages => {
              const cur = stateRef.current.diagram;
              if (cur) updateDiagram({ ...cur, messages });
            }}
            onCreateMessage={createMessage}
            onMessageContextMenu={openMessageMenu}
            onLifelineContextMenu={openLifelineMenu}
          />
        ) : (
          'Loading…'
        )}
      </div>
      {msgMenu && msgMenuItems && (
        <PopupMenu
          ref={msgMenuRef}
          x={msgMenu.x}
          y={msgMenu.y}
          items={[
            // Operation picker (only meaningful for sync/async)
            ...((msgMenuItems.msg.kind === 'sync' || msgMenuItems.msg.kind === 'async')
              ? [
                  ...(msgMenuItems.opItems.length === 0
                    ? [
                        {
                          label: msgMenuItems.target
                            ? `(no operations on ${msgMenuItems.target.name})`
                            : '(no target classifier)',
                          onClick: () => setMsgMenu(undefined)
                        }
                      ]
                    : msgMenuItems.opItems),
                  ...(msgMenuItems.target
                    ? [
                        {
                          label: 'Add operation…',
                          onClick: () => {
                            const id = msgMenu.messageId;
                            const cid = msgMenuItems.target!.id;
                            setMsgMenu(undefined);
                            void addOperationAndBind(id, cid);
                          }
                        }
                      ]
                    : []),
                  ...(msgMenuItems.msg.operationId
                    ? [
                        {
                          label: '(clear operation)',
                          onClick: () => {
                            const id = msgMenu.messageId;
                            setMsgMenu(undefined);
                            setMessageOperation(id, undefined);
                          }
                        }
                      ]
                    : []),
                  { separator: true } as const
                ]
              : []),
            // Label editor for non-operation kinds
            ...(msgMenuItems.msg.kind === 'reply' ||
            msgMenuItems.msg.kind === 'create' ||
            msgMenuItems.msg.kind === 'destroy'
              ? [
                  {
                    label: 'Edit label…',
                    onClick: () => {
                      const id = msgMenu.messageId;
                      setMsgMenu(undefined);
                      void editMessageLabel(id);
                    }
                  },
                  { separator: true } as const
                ]
              : []),
            // Kind picker
            ...msgMenuItems.kindItems,
            { separator: true } as const,
            {
              label: 'Delete',
              shortcut: 'Del',
              onClick: () => {
                const id = msgMenu.messageId;
                setMsgMenu(undefined);
                deleteMessage(id);
              }
            }
          ]}
        />
      )}
      {lifelineMenu && (
        <PopupMenu
          ref={lifelineMenuRef}
          x={lifelineMenu.x}
          y={lifelineMenu.y}
          items={[
            {
              label: 'Delete',
              shortcut: 'Del',
              onClick: () => {
                const id = lifelineMenu.lifelineId;
                setLifelineMenu(undefined);
                deleteLifeline(id);
              }
            }
          ]}
        />
      )}
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
  zoom: number;
  onSelect(id: string | undefined): void;
  onReorder(messages: SequenceMessage[]): void;
  onCreateMessage(
    sourceLifelineId: string,
    targetLifelineId: string,
    dropY: number
  ): void;
  onMessageContextMenu(messageId: string, clientX: number, clientY: number): void;
  onLifelineContextMenu(lifelineId: string, clientX: number, clientY: number): void;
}

const SequenceSvg: React.FC<SequenceSvgProps> = ({
  model,
  diagram,
  selected,
  zoom,
  onSelect,
  onReorder,
  onCreateMessage,
  onMessageContextMenu,
  onLifelineContextMenu
}) => {
  const layout = layoutSequence(diagram);
  const sorted = sortMessages(diagram.messages);
  const svgRef = useRef<SVGSVGElement>(null);

  // Mode 1: dragging an existing message vertically to reorder.
  const dragRef = useRef<{ id: string; startY: number; origY: number } | null>(null);
  const [dragY, setDragY] = useState<{ id: string; y: number } | null>(null);

  // Mode 2: dragging from a lifeline to another lifeline to create a message.
  const createRef = useRef<{
    sourceLifelineId: string;
    startX: number;
    startY: number;
  } | null>(null);
  const [createCur, setCreateCur] = useState<{
    sourceLifelineId: string;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  // ---- Mode 1: message drag ----
  const onMouseDownMessage = (e: React.MouseEvent, m: SequenceMessage) => {
    e.stopPropagation();
    onSelect(m.id);
    dragRef.current = { id: m.id, startY: e.clientY, origY: m.y };
  };

  // ---- Mode 2: lifeline drag-to-create ----
  const onMouseDownLifeline = (
    e: React.MouseEvent,
    lifelineId: string
  ) => {
    e.stopPropagation();
    const pt = svgPointFromEvent(e, svgRef.current);
    if (!pt) return;
    createRef.current = {
      sourceLifelineId: lifelineId,
      startX: pt.x,
      startY: pt.y
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current) {
      const dy = (e.clientY - dragRef.current.startY) / zoom;
      setDragY({ id: dragRef.current.id, y: dragRef.current.origY + dy });
      return;
    }
    if (createRef.current) {
      const pt = svgPointFromEvent(e, svgRef.current);
      if (!pt) return;
      const dx = pt.x - createRef.current.startX;
      const dy = pt.y - createRef.current.startY;
      if (createCur || Math.hypot(dx, dy) > 5) {
        setCreateCur({
          sourceLifelineId: createRef.current.sourceLifelineId,
          startX: createRef.current.startX,
          startY: createRef.current.startY,
          curX: pt.x,
          curY: pt.y
        });
      }
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (dragRef.current && dragY) {
      const id = dragRef.current.id;
      const newY = Math.max(FIRST_MESSAGE_Y, dragY.y);
      dragRef.current = null;
      setDragY(null);
      onReorder(diagram.messages.map(m => (m.id === id ? { ...m, y: newY } : m)));
      return;
    }
    dragRef.current = null;
    setDragY(null);

    if (createRef.current) {
      const c = createRef.current;
      const cur = createCur;
      createRef.current = null;
      setCreateCur(null);
      if (cur) {
        // It was an actual drag; figure out where we ended.
        const pt = svgPointFromEvent(e, svgRef.current) ?? {
          x: cur.curX,
          y: cur.curY
        };
        const targetLifelineId = lifelineAtX(pt.x, diagram, layout);
        if (targetLifelineId) {
          // Place the message at the y where the drag started (so users can
          // insert between existing messages by starting the drag at that
          // vertical position).
          onCreateMessage(c.sourceLifelineId, targetLifelineId, c.startY);
        }
      } else {
        // Click without significant move on the lifeline -> select it.
        onSelect(c.sourceLifelineId);
      }
    }
  };

  return (
    <svg
      ref={svgRef}
      width={layout.totalWidth * zoom}
      height={layout.totalHeight * zoom}
      viewBox={`0 0 ${layout.totalWidth} ${layout.totalHeight}`}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={() => onSelect(undefined)}
      // Suppress the webview's default Cut/Copy/Paste menu anywhere on
      // the canvas; specific elements (lifelines, messages) open their
      // own popups.
      onContextMenu={e => e.preventDefault()}
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
          <g
            key={l.id}
            onMouseDown={e => onMouseDownLifeline(e, l.id)}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(l.id);
              onLifelineContextMenu(l.id, e.clientX, e.clientY);
            }}
            style={{ cursor: 'crosshair' }}
          >
            <rect
              x={cx - LIFELINE_HEADER_W / 2}
              y={LIFELINE_TOP}
              width={LIFELINE_HEADER_W}
              height={LIFELINE_HEADER_H}
              rx={4}
              fill="var(--vscode-editorWidget-background)"
              stroke={isSelected ? 'var(--vscode-focusBorder)' : 'var(--vscode-foreground)'}
              strokeWidth={isSelected ? 2 : 1}
            />
            <text
              x={cx}
              y={LIFELINE_TOP + LIFELINE_HEADER_H / 2 + 4}
              textAnchor="middle"
              fill="var(--vscode-editor-foreground)"
              fontSize={12}
              fontFamily="var(--vscode-font-family)"
              style={{ pointerEvents: 'none' }}
            >
              {lifelineLabel(model, l)}
            </text>
            {/* Wide invisible stem hit area so dragging from anywhere along
                the lifeline starts a message-create gesture. */}
            <rect
              x={cx - 10}
              y={LIFELINE_TOP + LIFELINE_HEADER_H}
              width={20}
              height={Math.max(20, layout.stemBottom - (LIFELINE_TOP + LIFELINE_HEADER_H))}
              fill="transparent"
            />
            <line
              x1={cx}
              y1={LIFELINE_TOP + LIFELINE_HEADER_H}
              x2={cx}
              y2={layout.stemBottom}
              stroke="var(--vscode-foreground)"
              strokeDasharray="4 4"
              opacity={0.5}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        );
      })}

      {/* Rubber-band line during message creation */}
      {createCur && (
        <line
          x1={layout.lifelineX.get(createCur.sourceLifelineId) ?? createCur.startX}
          y1={createCur.startY}
          x2={createCur.curX}
          y2={createCur.curY}
          stroke="var(--vscode-focusBorder, #4da6ff)"
          strokeDasharray="3 3"
          markerEnd="url(#sm-open)"
          pointerEvents="none"
        />
      )}

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
        const onContextMenu = (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(m.id);
          onMessageContextMenu(m.id, e.clientX, e.clientY);
        };
        const onDoubleClick = (e: React.MouseEvent) => {
          e.stopPropagation();
          onSelect(m.id);
          onMessageContextMenu(m.id, e.clientX, e.clientY);
        };
        if (isSelfMessage) {
          const x = fromX;
          const w = 40;
          return (
            <g
              key={m.id}
              style={{ cursor: 'grab', color: colour }}
              onMouseDown={e => onMouseDownMessage(e, m)}
              onContextMenu={onContextMenu}
              onDoubleClick={onDoubleClick}
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
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
          >
            {/* Wider hit area for easier picking */}
            <line
              x1={fromX}
              y1={y}
              x2={toX}
              y2={y}
              stroke="transparent"
              strokeWidth={12}
            />
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
              style={{ pointerEvents: 'none' }}
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

function svgPointFromEvent(
  e: { clientX: number; clientY: number },
  svg: SVGSVGElement | null
): { x: number; y: number } | undefined {
  if (!svg) return undefined;
  // getScreenCTM accounts for viewBox scaling (zoom) and scroll position, so
  // this returns coordinates in the SVG's own user units regardless of zoom.
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const mapped = pt.matrixTransform(ctm.inverse());
    return { x: mapped.x, y: mapped.y };
  }
  const rect = svg.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function lifelineAtX(
  x: number,
  diagram: SequenceDiagramFile,
  layout: SequenceLayout
): string | undefined {
  // Pick the lifeline whose column center is closest to x, within a
  // tolerance of half the column pitch.
  let best: { id: string; dist: number } | undefined;
  for (const l of diagram.lifelines) {
    const cx = layout.lifelineX.get(l.id);
    if (cx === undefined) continue;
    const dist = Math.abs(cx - x);
    if (!best || dist < best.dist) best = { id: l.id, dist };
  }
  if (!best) return undefined;
  // Accept hits within LIFELINE_HEADER_W on either side of the column.
  return best.dist <= LIFELINE_HEADER_W ? best.id : undefined;
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
