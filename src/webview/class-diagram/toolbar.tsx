import React from 'react';
import type {
  ClassDiagramFile,
  ModelFile,
  ValidationIssue
} from '../../model/index.js';

export type RelationshipKind =
  | 'Association'
  | 'Aggregation'
  | 'Generalization'
  | 'Dependency';

interface ToolbarProps {
  diagram: ClassDiagramFile | undefined;
  model: ModelFile | undefined;
  issues: ValidationIssue[];
  onAddClass(): void;
  onAddInterface(): void;
  onAddModelClass(): void;
  onZoomFit(): void;
}

/**
 * Top-of-canvas toolbar for the class diagram editor.
 *
 * Edges are created by dragging from one classifier's edge to another;
 * the kind is changed afterwards via right-click on the resulting edge.
 */
export const Toolbar: React.FC<ToolbarProps> = ({
  diagram,
  model,
  issues,
  onAddClass,
  onAddInterface,
  onAddModelClass,
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
      <button onClick={onZoomFit}>Fit</button>
      <span className="vsuml-toolbar-info">
        {elementCount} model element(s) · {diagram?.nodes.length ?? 0} node(s) · {diagram?.edges.length ?? 0} edge(s){issueLabel}
      </span>
    </div>
  );
};
