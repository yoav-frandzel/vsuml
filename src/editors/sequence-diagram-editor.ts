/**
 * Sequence Diagram custom editor — thin specialisation of BaseDiagramEditor.
 */

import * as vscode from 'vscode';
import { ModelService } from '../model/model-service.js';
import type { SequenceDiagramFile } from '../model/index.js';
import {
  BaseDiagramEditor,
  createDiagramFile,
  slug
} from './base-editor.js';

const VIEW_TYPE = 'vsuml.sequenceDiagram';
const EXTENSION = 'umlsequence';

export class SequenceDiagramEditorProvider extends BaseDiagramEditor {
  static register(
    context: vscode.ExtensionContext,
    service: ModelService
  ): vscode.Disposable {
    const provider = new SequenceDiagramEditorProvider(context, service, {
      viewType: VIEW_TYPE,
      extension: EXTENSION,
      diagramKind: 'SequenceDiagram',
      viewKind: 'sequence',
      scriptPath: 'media/sequence-diagram.js',
      titlePrefix: 'Sequence Diagram',
      createEmptyDiagram: name => createEmptySequenceDiagram(name)
    });
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }
}

function createEmptySequenceDiagram(name: string): SequenceDiagramFile {
  return {
    schemaVersion: 1,
    kind: 'SequenceDiagram',
    name,
    lifelines: [],
    messages: []
  };
}

export async function createNewSequenceDiagramFile(
  folder: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Sequence diagram name',
    placeHolder: 'e.g. Submit Order',
    validateInput: v => (v.trim() ? null : 'Name required')
  });
  if (!name) return;
  return createDiagramFile(
    folder,
    VIEW_TYPE,
    EXTENSION,
    createEmptySequenceDiagram(name),
    slug(name)
  );
}
