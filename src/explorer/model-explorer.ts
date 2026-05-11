/**
 * Model Explorer — VS Code TreeView showing the workspace UML model.
 *
 * Read-only display in v1; mutations go through the explicit commands
 * (vsuml.explorer.add*, vsuml.explorer.rename, vsuml.explorer.delete) which
 * surface in the view's context menu.
 *
 * The tree reflects model containment via `ownerId`. Root is the implicit
 * Model package.
 */

import * as vscode from 'vscode';
import type {
  Class,
  ElementId,
  Interface,
  ModelElement,
  Operation
} from '../model/index.js';
import type { ModelService } from '../model/model-service.js';
import { getActiveDiagram } from '../editors/active-registry.js';

export class ModelExplorerProvider
  implements vscode.TreeDataProvider<ModelTreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ModelTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly service: ModelService) {
    this._disposables.push(
      service.onDidChange(() => this._onDidChangeTreeData.fire(undefined))
    );
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(node?: ModelTreeNode): Promise<ModelTreeNode[]> {
    const model = await this.service.getModel();
    if (!node) {
      // Root: show the implicit model package's children, plus the root
      // itself if it has a non-default name. Simpler: always show the root
      // package as the single top-level entry.
      const root = model.elements[model.rootPackageId];
      return [{ kind: 'element', element: root }];
    }
    if (node.kind === 'element') {
      const el = node.element;
      switch (el.kind) {
        case 'Package':
          return childElements(model.elements, el.id).map(toNode);
        case 'Class':
        case 'Interface':
          return classifierChildren(model.elements, el).map(toNode);
        case 'Operation':
          return el.parameterIds
            .map(id => model.elements[id])
            .filter(Boolean)
            .map(toNode);
        case 'StateMachine':
          return childElements(model.elements, el.id).map(toNode);
        case 'State':
          return childElements(model.elements, el.id).map(toNode);
        default:
          return [];
      }
    }
    return [];
  }

  getTreeItem(node: ModelTreeNode): vscode.TreeItem {
    const el = node.element;
    const label = formatLabel(el);
    const item = new vscode.TreeItem(label, collapsibleState(el));
    item.id = el.id;
    item.contextValue = `vsuml.${el.kind}`;
    item.iconPath = iconFor(el);
    item.tooltip = tooltipFor(el);
    if (el.kind === 'Class' || el.kind === 'Interface') {
      item.command = {
        command: 'vsuml.explorer.addToActiveDiagram',
        title: 'Add to active diagram',
        arguments: [node]
      };
    }
    return item;
  }
}

/* ------------------------------------------------------------------ */
/* Tree node model                                                     */
/* ------------------------------------------------------------------ */

export interface ElementTreeNode {
  kind: 'element';
  element: ModelElement;
}

export type ModelTreeNode = ElementTreeNode;

function toNode(element: ModelElement): ElementTreeNode {
  return { kind: 'element', element };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function childElements(
  elements: Record<ElementId, ModelElement>,
  ownerId: ElementId
): ModelElement[] {
  return Object.values(elements)
    .filter(e => e.ownerId === ownerId)
    .sort(compareElements);
}

function classifierChildren(
  elements: Record<ElementId, ModelElement>,
  classifier: Class | Interface
): ModelElement[] {
  const direct = Object.values(elements).filter(
    e => e.ownerId === classifier.id
  );
  // For classes, surface the state machine inline (it lives under the class
  // but we want it grouped after operations).
  return direct.sort(compareElements);
}

function compareElements(a: ModelElement, b: ModelElement): number {
  const order = kindOrder(a.kind) - kindOrder(b.kind);
  if (order !== 0) return order;
  return (a.name ?? '').localeCompare(b.name ?? '');
}

function kindOrder(kind: ModelElement['kind']): number {
  switch (kind) {
    case 'Package':
      return 0;
    case 'Interface':
      return 1;
    case 'Class':
      return 2;
    case 'Attribute':
      return 3;
    case 'Operation':
      return 4;
    case 'Parameter':
      return 5;
    case 'StateMachine':
      return 6;
    case 'State':
      return 7;
    case 'Transition':
      return 8;
    case 'Relationship':
      return 9;
    default:
      return 99;
  }
}

function collapsibleState(el: ModelElement): vscode.TreeItemCollapsibleState {
  switch (el.kind) {
    case 'Package':
    case 'StateMachine':
      return vscode.TreeItemCollapsibleState.Expanded;
    case 'Class':
    case 'Interface':
    case 'State':
      return vscode.TreeItemCollapsibleState.Collapsed;
    case 'Operation':
      return (el as Operation).parameterIds.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    default:
      return vscode.TreeItemCollapsibleState.None;
  }
}

function formatLabel(el: ModelElement): string {
  switch (el.kind) {
    case 'Attribute':
      return `${visibilityGlyph(el.visibility)} ${el.name}: ${el.type}`;
    case 'Operation': {
      const params = (el as Operation).parameterIds.length;
      const ret = el.returnType ? `: ${el.returnType}` : '';
      return `${visibilityGlyph(el.visibility)} ${el.name}(${params})${ret}`;
    }
    case 'Parameter':
      return `${el.name}: ${el.type}`;
    case 'Relationship':
      return `${el.relKind}: ${el.name || '(unnamed)'}`;
    case 'Transition':
      return el.trigger ? `→ ${el.trigger}` : '→';
    case 'State':
      return el.stateKind === 'Simple'
        ? el.name
        : `${el.name} «${el.stateKind}»`;
    default:
      return el.name || `(unnamed ${el.kind})`;
  }
}

function visibilityGlyph(v: string): string {
  switch (v) {
    case 'public':
      return '+';
    case 'protected':
      return '#';
    case 'private':
      return '−';
    case 'package':
      return '~';
    default:
      return '+';
  }
}

function tooltipFor(el: ModelElement): string {
  const parts = [`${el.kind}: ${el.name || '(unnamed)'}`, `id: ${el.id}`];
  return parts.join('\n');
}

function iconFor(el: ModelElement): vscode.ThemeIcon {
  switch (el.kind) {
    case 'Package':
      return new vscode.ThemeIcon('package');
    case 'Class':
      return new vscode.ThemeIcon('symbol-class');
    case 'Interface':
      return new vscode.ThemeIcon('symbol-interface');
    case 'Attribute':
      return new vscode.ThemeIcon('symbol-field');
    case 'Operation':
      return new vscode.ThemeIcon('symbol-method');
    case 'Parameter':
      return new vscode.ThemeIcon('symbol-parameter');
    case 'StateMachine':
      return new vscode.ThemeIcon('circuit-board');
    case 'State':
      return new vscode.ThemeIcon('debug-stackframe-dot');
    case 'Transition':
      return new vscode.ThemeIcon('arrow-right');
    case 'Relationship':
      return new vscode.ThemeIcon('references');
    default:
      return new vscode.ThemeIcon('symbol-misc');
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export function registerExplorerCommands(
  context: vscode.ExtensionContext,
  service: ModelService,
  provider: ModelExplorerProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vsuml.explorer.addPackage',
      (node?: ElementTreeNode) => addPackage(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.addClass',
      (node?: ElementTreeNode) => addClass(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.addInterface',
      (node?: ElementTreeNode) => addInterface(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.addAttribute',
      (node?: ElementTreeNode) => addAttribute(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.addOperation',
      (node?: ElementTreeNode) => addOperation(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.rename',
      (node?: ElementTreeNode) => renameElement(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.delete',
      (node?: ElementTreeNode) => deleteElement(service, node)
    ),
    vscode.commands.registerCommand(
      'vsuml.explorer.addToActiveDiagram',
      (node?: ElementTreeNode) => addToActiveDiagram(node)
    ),
    vscode.commands.registerCommand('vsuml.explorer.refresh', () =>
      provider.refresh()
    )
  );
}

function addToActiveDiagram(node?: ElementTreeNode): void {
  if (!node) {
    vscode.window.showInformationMessage(
      'VS UML: right-click an element in the Model Explorer.'
    );
    return;
  }
  const active = getActiveDiagram();
  if (!active) {
    vscode.window.showWarningMessage(
      'VS UML: open a diagram first, then run this command.'
    );
    return;
  }
  const el = node.element;
  if (active.viewKind === 'class' && el.kind !== 'Class' && el.kind !== 'Interface') {
    vscode.window.showWarningMessage(
      `VS UML: class diagrams accept Class or Interface, not ${el.kind}.`
    );
    return;
  }
  if (active.viewKind === 'sequence' && el.kind !== 'Class' && el.kind !== 'Interface') {
    vscode.window.showWarningMessage(
      `VS UML: sequence diagrams accept Class or Interface (as lifelines), not ${el.kind}.`
    );
    return;
  }
  if (active.viewKind === 'state') {
    vscode.window.showWarningMessage(
      'VS UML: state diagrams own their states; create new states with the diagram toolbar.'
    );
    return;
  }
  active.post({ type: 'host.addElement', elementId: el.id });
}

async function pickContainer(
  service: ModelService,
  node: ElementTreeNode | undefined,
  allowed: ModelElement['kind'][]
): Promise<ModelElement | undefined> {
  if (node && allowed.includes(node.element.kind)) return node.element;
  const model = await service.getModel();
  return model.elements[model.rootPackageId];
}

async function promptName(
  prompt: string,
  defaultValue?: string
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt,
    value: defaultValue,
    validateInput: v => (v.trim().length === 0 ? 'Name is required' : null)
  });
  return name?.trim();
}

async function addPackage(service: ModelService, node?: ElementTreeNode) {
  const owner = await pickContainer(service, node, ['Package']);
  if (!owner) return;
  const name = await promptName('New package name');
  if (!name) return;
  const { createPackage } = await import('../model/factory.js');
  const pkg = createPackage(name, owner.id);
  await service.upsert(pkg);
}

async function addClass(service: ModelService, node?: ElementTreeNode) {
  const owner = await pickContainer(service, node, ['Package']);
  if (!owner) return;
  const name = await promptName('New class name');
  if (!name) return;
  const { createClass } = await import('../model/factory.js');
  await service.upsert(createClass(name, owner.id));
}

async function addInterface(service: ModelService, node?: ElementTreeNode) {
  const owner = await pickContainer(service, node, ['Package']);
  if (!owner) return;
  const name = await promptName('New interface name');
  if (!name) return;
  const { createInterface } = await import('../model/factory.js');
  await service.upsert(createInterface(name, owner.id));
}

async function addAttribute(service: ModelService, node?: ElementTreeNode) {
  const owner = await pickContainer(service, node, ['Class', 'Interface']);
  if (!owner) {
    vscode.window.showWarningMessage('Select a Class or Interface first.');
    return;
  }
  const name = await promptName('New attribute name');
  if (!name) return;
  const type =
    (await vscode.window.showInputBox({
      prompt: 'Attribute type',
      value: 'string'
    })) ?? 'string';
  const { createAttribute } = await import('../model/factory.js');
  await service.upsert(createAttribute(name, owner.id, type));
}

async function addOperation(service: ModelService, node?: ElementTreeNode) {
  const owner = await pickContainer(service, node, ['Class', 'Interface']);
  if (!owner) {
    vscode.window.showWarningMessage('Select a Class or Interface first.');
    return;
  }
  const name = await promptName('New operation name');
  if (!name) return;
  const returnType =
    (await vscode.window.showInputBox({
      prompt: 'Return type (blank for void)',
      value: ''
    })) || undefined;
  const { createOperation } = await import('../model/factory.js');
  await service.upsert(createOperation(name, owner.id, 'public', returnType));
}

async function renameElement(
  service: ModelService,
  node?: ElementTreeNode
): Promise<void> {
  if (!node) return;
  const el = node.element;
  const next = await promptName('Rename', el.name);
  if (!next || next === el.name) return;
  await service.upsert({ ...el, name: next });
}

async function deleteElement(
  service: ModelService,
  node?: ElementTreeNode
): Promise<void> {
  if (!node) return;
  const el = node.element;
  const model = await service.getModel();
  if (el.id === model.rootPackageId) {
    vscode.window.showWarningMessage('Cannot delete the root model package.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${el.kind} "${el.name}" and everything it owns?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;
  await service.remove(el.id);
}
