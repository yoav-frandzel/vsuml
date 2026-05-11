/**
 * Pure helpers for rendering a sequence diagram as inline SVG.
 *
 * The renderer is intentionally simple: lifelines are equally spaced along
 * the X axis, messages are drawn at their explicit `y` values. The host
 * (main.tsx) translates user interaction into mutations and re-renders.
 */

import type {
  Lifeline,
  ModelFile,
  SequenceDiagramFile,
  SequenceMessage
} from '../../model/index.js';

export const LIFELINE_HEADER_H = 40;
export const LIFELINE_HEADER_W = 140;
export const LIFELINE_GAP = 60;
export const LIFELINE_TOP = 24;
export const FIRST_MESSAGE_Y = LIFELINE_HEADER_H + LIFELINE_TOP + 30;
export const MESSAGE_ROW_H = 36;

export interface SequenceLayout {
  totalWidth: number;
  totalHeight: number;
  lifelineX: Map<string, number>;
  /** y position of the very bottom of each lifeline's stem. */
  stemBottom: number;
}

export function layoutSequence(
  diagram: SequenceDiagramFile
): SequenceLayout {
  const lifelineX = new Map<string, number>();
  diagram.lifelines.forEach((l, i) => {
    lifelineX.set(
      l.id,
      40 + LIFELINE_HEADER_W / 2 + i * (LIFELINE_HEADER_W + LIFELINE_GAP)
    );
  });
  const maxY = diagram.messages.reduce(
    (m, msg) => Math.max(m, msg.y),
    FIRST_MESSAGE_Y
  );
  const stemBottom = maxY + MESSAGE_ROW_H * 1.5;
  const totalWidth =
    40 +
    diagram.lifelines.length * (LIFELINE_HEADER_W + LIFELINE_GAP) +
    40;
  const totalHeight = stemBottom + 40;
  return { totalWidth, totalHeight, lifelineX, stemBottom };
}

export function lifelineLabel(
  model: ModelFile | undefined,
  l: Lifeline
): string {
  if (l.label) return l.label;
  if (!model) return '(unknown)';
  const el = model.elements[l.representsId];
  return el?.name ?? '(missing)';
}

export function messageLabel(
  model: ModelFile | undefined,
  m: SequenceMessage
): string {
  if (m.kind === 'reply') return m.label ?? 'return';
  if (m.kind === 'create') return m.label ?? '«create»';
  if (m.kind === 'destroy') return m.label ?? '«destroy»';
  if (m.label) return m.label;
  if (m.operationId && model) {
    const op = model.elements[m.operationId];
    if (op && op.kind === 'Operation') return `${op.name}()`;
  }
  return '(unspecified)';
}

export function sortMessages(
  messages: SequenceMessage[]
): SequenceMessage[] {
  return [...messages].sort((a, b) => a.y - b.y);
}
