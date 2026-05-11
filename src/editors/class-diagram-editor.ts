/**
 * Class Diagram custom editor — a thin specialisation of BaseDiagramEditor.
 */

import * as vscode from 'vscode';
import { ModelService } from '../model/model-service.js';
import type { ClassDiagramFile } from '../model/index.js';
import {
  BaseDiagramEditor,
  createDiagramFile,
  slug
} from './base-editor.js';

const VIEW_TYPE = 'vsuml.classDiagram';
const EXTENSION = 'umlclass';

export class ClassDiagramEditorProvider extends BaseDiagramEditor {
  static register(
    context: vscode.ExtensionContext,
    service: ModelService
  ): vscode.Disposable {
    const provider = new ClassDiagramEditorProvider(context, service, {
      viewType: VIEW_TYPE,
      extension: EXTENSION,
      diagramKind: 'ClassDiagram',
      viewKind: 'class',
      scriptPath: 'media/class-diagram.js',
      titlePrefix: 'Class Diagram',
      createEmptyDiagram: name => createEmptyClassDiagram(name)
    });
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }
}

function createEmptyClassDiagram(name: string): ClassDiagramFile {
  return {
    schemaVersion: 1,
    kind: 'ClassDiagram',
    name,
    nodes: [],
    edges: []
  };
}

export async function createNewClassDiagramFile(
  folder: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Class diagram name',
    placeHolder: 'e.g. Domain Model',
    validateInput: v => (v.trim() ? null : 'Name required')
  });
  if (!name) return;
  return createDiagramFile(
    folder,
    VIEW_TYPE,
    EXTENSION,
    createEmptyClassDiagram(name),
    slug(name)
  );
}
