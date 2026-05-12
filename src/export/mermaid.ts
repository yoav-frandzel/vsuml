/**
 * Mermaid serializers for the three diagram kinds.
 *
 * One-way: VS UML model → Mermaid text. Mermaid → model is out of scope.
 */

import type {
  ClassDiagramFile,
  DiagramFile,
  ModelFile,
  SequenceDiagramFile,
  StateDiagramFile
} from '../model/index.js';

export function diagramToMermaid(
  model: ModelFile,
  diagram: DiagramFile
): string {
  switch (diagram.kind) {
    case 'ClassDiagram':
      return classDiagramToMermaid(model, diagram);
    case 'SequenceDiagram':
      return sequenceDiagramToMermaid(model, diagram);
    case 'StateDiagram':
      return stateDiagramToMermaid(model, diagram);
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/* ------------------------------------------------------------------ */
/* Class                                                                */
/* ------------------------------------------------------------------ */

function classDiagramToMermaid(
  model: ModelFile,
  diagram: ClassDiagramFile
): string {
  const lines: string[] = ['classDiagram'];
  const known = new Set<string>();
  for (const node of diagram.nodes) {
    const el = model.elements[node.elementId];
    if (!el) continue;
    if (el.kind !== 'Class' && el.kind !== 'Interface') continue;
    const name = safeName(el.name);
    known.add(node.elementId);
    if (el.kind === 'Interface') {
      lines.push(`  class ${name} {`);
      lines.push(`    <<interface>>`);
    } else {
      lines.push(`  class ${name} {`);
    }
    for (const attr of Object.values(model.elements)) {
      if (attr.kind === 'Attribute' && attr.ownerId === el.id) {
        const visGlyph =
          attr.visibility === 'private'
            ? '-'
            : attr.visibility === 'protected'
              ? '#'
              : '+';
        lines.push(`    ${visGlyph}${attr.name} ${attr.type ?? ''}`.trimEnd());
      }
    }
    for (const op of Object.values(model.elements)) {
      if (op.kind === 'Operation' && op.ownerId === el.id) {
        const visGlyph =
          op.visibility === 'private'
            ? '-'
            : op.visibility === 'protected'
              ? '#'
              : '+';
        const ret = op.returnType ? ` ${op.returnType}` : '';
        lines.push(`    ${visGlyph}${op.name}()${ret}`);
      }
    }
    lines.push('  }');
  }
  for (const edge of diagram.edges) {
    const rel = model.elements[edge.elementId];
    if (!rel || rel.kind !== 'Relationship') continue;
    const src = model.elements[rel.sourceId];
    const tgt = model.elements[rel.targetId];
    if (!src || !tgt) continue;
    if (!known.has(rel.sourceId) || !known.has(rel.targetId)) continue;
    const a = safeName(src.name);
    const b = safeName(tgt.name);
    const arrow =
      rel.relKind === 'Generalization'
        ? '<|--'
        : rel.relKind === 'Dependency'
          ? '..>'
          : rel.relKind === 'Aggregation'
            ? '--o'
            : '-->';
    lines.push(`  ${b} ${arrow} ${a}`);
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Sequence                                                             */
/* ------------------------------------------------------------------ */

function sequenceDiagramToMermaid(
  model: ModelFile,
  diagram: SequenceDiagramFile
): string {
  const lines: string[] = ['sequenceDiagram'];
  const aliasFor = new Map<string, string>();
  for (const l of diagram.lifelines) {
    const el = model.elements[l.representsId];
    const display = l.label ?? el?.name ?? '?';
    const alias = safeName(`${display}_${l.id.slice(0, 4)}`);
    aliasFor.set(l.id, alias);
    lines.push(`  participant ${alias} as ${display}`);
  }
  const sorted = [...diagram.messages].sort((a, b) => a.y - b.y);
  for (const m of sorted) {
    const from = aliasFor.get(m.sourceLifelineId);
    const to = aliasFor.get(m.targetLifelineId);
    if (!from || !to) continue;
    const arrow =
      m.kind === 'sync'
        ? '->>'
        : m.kind === 'async'
          ? '->>+'
          : m.kind === 'reply'
            ? '-->>'
            : m.kind === 'create'
              ? '-x'
              : '->>';
    let label = m.label ?? '';
    if (!label && m.operationId) {
      const op = model.elements[m.operationId];
      if (op && op.kind === 'Operation') label = `${op.name}()`;
    }
    if (!label) label = m.kind;
    lines.push(`  ${from}${arrow}${to}: ${label}`);
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

function stateDiagramToMermaid(
  model: ModelFile,
  diagram: StateDiagramFile
): string {
  const lines: string[] = ['stateDiagram-v2'];
  const aliasFor = new Map<string, string>();
  for (const n of diagram.nodes) {
    const s = model.elements[n.elementId];
    if (!s || s.kind !== 'State') continue;
    if (s.stateKind === 'Initial') {
      aliasFor.set(n.elementId, '[*]');
      continue;
    }
    if (s.stateKind === 'Final') {
      aliasFor.set(n.elementId, '[*]');
      continue;
    }
    const alias = safeName(`${s.name}_${n.elementId.slice(0, 4)}`);
    aliasFor.set(n.elementId, alias);
    lines.push(`  ${alias} : ${s.name}`);
  }
  for (const e of diagram.edges) {
    const t = model.elements[e.elementId];
    if (!t || t.kind !== 'Transition') continue;
    const from = aliasFor.get(t.sourceStateId);
    const to = aliasFor.get(t.targetStateId);
    if (!from || !to) continue;
    const parts: string[] = [];
    if (t.trigger) parts.push(t.trigger);
    if (t.guard) parts.push(`[${t.guard}]`);
    if (t.effect) parts.push(`/ ${t.effect}`);
    const lbl = parts.length ? `: ${parts.join(' ')}` : '';
    lines.push(`  ${from} --> ${to}${lbl}`);
  }
  return lines.join('\n') + '\n';
}
