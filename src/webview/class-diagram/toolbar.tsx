import React from 'react';
import type {
  ClassDiagramFile,
  ModelFile,
  ValidationIssue
} from '../../model/index.js';

export type RelationshipKind =
  | 'Association'
  | 'Generalization'
  | 'Dependency'
  | 'Realization';

interface ToolbarProps {
  diagram: ClassDiagramFile | undefined;
  model: ModelFile | undefined;
  issues: ValidationIssue[];
  edgeKind: RelationshipKind;
  onEdgeKindChange(kind: RelationshipKind): void;
  onAddClass(): void;
  onAddInterface(): void;
  onAddModelClass(): void;
  onAddEdge(): void;
  onZoomFit(): void;
}

/**
 * Top-of-canvas toolbar for the class diagram editor.
 *
 * The "Edge type" select picks what kind of relationship is created when
 * the user drags between two existing nodes — modelled on classic
 * diagramming-tool semantics so the canvas itself doesn't need a separate
 * picker per gesture.
 */
export const Toolbar: React.FC<ToolbarProps> = ({
  diagram,
  model,
  issues,
  edgeKind,
  onEdgeKindChange,
  onAddClass,
  onAddInterface,
  onAddModelClass,
  onAddEdge,
  onZoomFit
}) => {
  const elementCount = model ? Object.keys(model.elements).length : 0;
  const issueLabel = issues.length === 0 ? '' : ` · ⚠ ${issues.length}`;
  return (
    <div className="vsuml-toolbar">
      <strong>{diagram?.name ?? 'Class Diagram'}</strong>
      <button onClick={onAddClass} title="Create a new class in the model and add it">
        + New Class
      </button>
      <button onClick={onAddInterface} title="Create a new interface in the model and add it">
        + New Interface
      </button>
      <button onClick={onAddModelClass} title="Add an existing model class to this diagram">
        Add From Model…
      </button>
      <label>
        Edge type:&nbsp;
        <select
          value={edgeKind}
          onChange={e => onEdgeKindChange(e.target.value as RelationshipKind)}
        >
          <option value="Association">Association</option>
          <option value="Generalization">Generalization</option>
          <option value="Dependency">Dependency</option>
          <option value="Realization">Realization</option>
        </select>
      </label>
      <button
        onClick={onAddEdge}
        title="Pick a source and target classifier to connect"
      >
        + Edge…
      </button>
      <button onClick={onZoomFit}>Fit</button>
      <span className="vsuml-toolbar-info">
        {elementCount} model element(s) · {diagram?.nodes.length ?? 0} node(s) · {diagram?.edges.length ?? 0} edge(s){issueLabel}
      </span>
    </div>
  );
};
