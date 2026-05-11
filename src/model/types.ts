/**
 * Core UML model element types.
 *
 * The model is a flat map of elements keyed by stable UUIDs. Parent/child
 * containment is expressed via `ownerId`, not nesting, which keeps lookups
 * O(1) and JSON diffs minimal when a deeply nested element changes.
 *
 * Diagrams (.umlclass / .umlsequence / .umlstate) hold only *view* data and
 * reference these elements by id; they never duplicate semantic information.
 */

export type ElementId = string;

export type Visibility = 'public' | 'protected' | 'private' | 'package';

export type ParameterDirection = 'in' | 'out' | 'inout' | 'return';

export type ElementKind =
  | 'Package'
  | 'Class'
  | 'Interface'
  | 'Attribute'
  | 'Operation'
  | 'Parameter'
  | 'Relationship'
  | 'StateMachine'
  | 'State'
  | 'Transition';

export interface ModelElementBase {
  readonly id: ElementId;
  readonly kind: ElementKind;
  /** Containing element id. The root package has ownerId === null. */
  ownerId: ElementId | null;
  name: string;
}

export interface Package extends ModelElementBase {
  kind: 'Package';
}

export interface Classifier extends ModelElementBase {
  isAbstract?: boolean;
  stereotype?: string;
  /** Free-form documentation. */
  doc?: string;
}

export interface Class extends Classifier {
  kind: 'Class';
  /** Optional state machine owned by this class. */
  stateMachineId?: ElementId;
}

export interface Interface extends Classifier {
  kind: 'Interface';
}

export interface Attribute extends ModelElementBase {
  kind: 'Attribute';
  /** ownerId is a Class or Interface. */
  visibility: Visibility;
  /** Type expressed as a free-form string (e.g. "string", "Order", "List<int>"). */
  type: string;
  multiplicity?: string;
  defaultValue?: string;
  isStatic?: boolean;
  isReadOnly?: boolean;
}

export interface Parameter extends ModelElementBase {
  kind: 'Parameter';
  /** ownerId is the owning Operation. */
  direction: ParameterDirection;
  type: string;
  defaultValue?: string;
}

export interface Operation extends ModelElementBase {
  kind: 'Operation';
  /** ownerId is a Class or Interface. */
  visibility: Visibility;
  returnType?: string;
  isStatic?: boolean;
  isAbstract?: boolean;
  /** Parameter ids in declaration order. Parameter elements live as separate model elements owned by this operation. */
  parameterIds: ElementId[];
}

export type RelationshipKind =
  | 'Association'
  | 'Generalization'
  | 'Dependency';

export interface AssociationEnd {
  /** Optional role name shown on the end. */
  roleName?: string;
  multiplicity?: string;
  /** Whether the end is navigable from the opposite side. */
  navigable?: boolean;
}

export interface Relationship extends ModelElementBase {
  kind: 'Relationship';
  relKind: RelationshipKind;
  sourceId: ElementId;
  targetId: ElementId;
  /** Only meaningful for Association. */
  sourceEnd?: AssociationEnd;
  targetEnd?: AssociationEnd;
}

export interface StateMachine extends ModelElementBase {
  kind: 'StateMachine';
  /** ownerId is the Class that owns this state machine. */
  /** Ids of top-level states (children may exist via ownerId on nested states). */
  topStateIds: ElementId[];
}

export type StateKind = 'Simple' | 'Composite' | 'Initial' | 'Final' | 'Choice';

export interface State extends ModelElementBase {
  kind: 'State';
  stateKind: StateKind;
  /** ownerId is the StateMachine, or a containing composite State. */
  entry?: string;
  exit?: string;
  doActivity?: string;
}

export interface Transition extends ModelElementBase {
  kind: 'Transition';
  /** ownerId is the containing StateMachine. */
  sourceStateId: ElementId;
  targetStateId: ElementId;
  trigger?: string;
  guard?: string;
  effect?: string;
}

export type ModelElement =
  | Package
  | Class
  | Interface
  | Attribute
  | Operation
  | Parameter
  | Relationship
  | StateMachine
  | State
  | Transition;

/** Persisted model file shape. */
export interface ModelFile {
  schemaVersion: 1;
  /** ID of the implicit root Package element. Always present after load. */
  rootPackageId: ElementId;
  elements: Record<ElementId, ModelElement>;
}

export const CURRENT_MODEL_SCHEMA_VERSION = 1 as const;
