/**
 * State Diagram custom editor — thin specialisation of BaseDiagramEditor.
 *
 * Creating a new state diagram requires choosing the Class that will own
 * the state machine, and a fresh StateMachine element is created if the
 * class doesn't have one yet.
 */

import * as vscode from 'vscode';
import { ModelService } from '../model/model-service.js';
import type { StateDiagramFile } from '../model/index.js';
import { createStateMachine } from '../model/factory.js';
import {
  BaseDiagramEditor,
  createDiagramFile,
  slug
} from './base-editor.js';

const VIEW_TYPE = 'vsuml.stateDiagram';
const EXTENSION = 'umlstate';

export class StateDiagramEditorProvider extends BaseDiagramEditor {
  static register(
    context: vscode.ExtensionContext,
    service: ModelService
  ): vscode.Disposable {
    const provider = new StateDiagramEditorProvider(context, service, {
      viewType: VIEW_TYPE,
      extension: EXTENSION,
      diagramKind: 'StateDiagram',
      viewKind: 'state',
      scriptPath: 'media/state-diagram.js',
      titlePrefix: 'State Diagram',
      createEmptyDiagram: () => {
        throw new Error('createEmptyDiagram unused for state diagrams');
      }
    });
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }
}

export async function createNewStateDiagramFile(
  folder: vscode.WorkspaceFolder,
  service: ModelService
): Promise<vscode.Uri | undefined> {
  const model = await service.getModel();
  const classes = Object.values(model.elements).filter(e => e.kind === 'Class');
  if (classes.length === 0) {
    vscode.window.showWarningMessage(
      'VS UML: create a Class first — state diagrams are owned by a class.'
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    classes.map(c => ({ label: c.name, description: c.id })),
    { placeHolder: 'Which class owns this state machine?' }
  );
  if (!pick) return;
  const owningClass = classes.find(c => c.id === pick.description);
  if (!owningClass || owningClass.kind !== 'Class') return;

  let stateMachineId = owningClass.stateMachineId;
  if (!stateMachineId) {
    const sm = createStateMachine(owningClass.id);
    stateMachineId = sm.id;
    await service.upsert(sm);
    await service.upsert({ ...owningClass, stateMachineId });
  }

  const name = await vscode.window.showInputBox({
    prompt: 'State diagram name',
    value: `${owningClass.name} states`,
    validateInput: v => (v.trim() ? null : 'Name required')
  });
  if (!name) return;

  const diagram: StateDiagramFile = {
    schemaVersion: 1,
    kind: 'StateDiagram',
    name,
    ownerClassId: owningClass.id,
    stateMachineId,
    nodes: [],
    edges: []
  };
  return createDiagramFile(
    folder,
    VIEW_TYPE,
    EXTENSION,
    diagram,
    slug(name)
  );
}
