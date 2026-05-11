/**
 * Workspace-wide validation diagnostics for VS UML.
 *
 * Subscribes to model and open-document changes; runs `validateModel` and
 * `validateDiagram` and publishes `vscode.Diagnostic`s under URIs the user
 * sees in Problems view.
 */

import * as vscode from 'vscode';
import { ModelService } from '../model/model-service.js';
import {
  validateDiagram,
  validateModel,
  type DiagramFile,
  type ValidationIssue
} from '../model/index.js';

export function registerDiagnostics(
  context: vscode.ExtensionContext,
  service: ModelService
): void {
  const collection = vscode.languages.createDiagnosticCollection('vsuml');
  context.subscriptions.push(collection);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const modelUri = folder
    ? vscode.Uri.joinPath(folder.uri, '.uml', 'model.json')
    : undefined;

  const refreshModel = async () => {
    if (!modelUri) return;
    try {
      const m = await service.getModel();
      const issues = validateModel(m);
      collection.set(modelUri, issuesToDiagnostics(issues));
    } catch (err) {
      collection.set(modelUri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `Model parse error: ${err instanceof Error ? err.message : err}`,
          vscode.DiagnosticSeverity.Error
        )
      ]);
    }
  };

  const refreshDiagram = async (doc: vscode.TextDocument) => {
    if (!isDiagramFile(doc.uri.fsPath)) return;
    try {
      const model = await service.getModel();
      const diagram = JSON.parse(doc.getText()) as DiagramFile;
      const issues = validateDiagram(model, diagram);
      collection.set(doc.uri, issuesToDiagnostics(issues));
    } catch {
      collection.set(doc.uri, []);
    }
  };

  context.subscriptions.push(
    service.onDidChange(async () => {
      await refreshModel();
      for (const doc of vscode.workspace.textDocuments) {
        if (isDiagramFile(doc.uri.fsPath)) await refreshDiagram(doc);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => void refreshDiagram(doc))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => void refreshDiagram(e.document))
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (isDiagramFile(doc.uri.fsPath)) collection.delete(doc.uri);
    })
  );

  void refreshModel();
  for (const doc of vscode.workspace.textDocuments) {
    if (isDiagramFile(doc.uri.fsPath)) void refreshDiagram(doc);
  }
}

function isDiagramFile(path: string): boolean {
  return (
    path.endsWith('.umlclass') ||
    path.endsWith('.umlsequence') ||
    path.endsWith('.umlstate')
  );
}

function issuesToDiagnostics(issues: ValidationIssue[]): vscode.Diagnostic[] {
  return issues.map(i => {
    const sev =
      i.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    const range = new vscode.Range(0, 0, 0, 1);
    const d = new vscode.Diagnostic(range, i.message, sev);
    d.source = 'vsuml';
    if (i.locator) d.code = i.locator;
    return d;
  });
}
