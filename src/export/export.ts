/**
 * Export command: serialises the active diagram to Mermaid text.
 *
 * PNG and SVG export from the live webview canvas would require routing
 * a request through the editor; for v1 we ship Mermaid (and the user can
 * paste into any Mermaid renderer to get PNG/SVG). This keeps the surface
 * area small while still being genuinely useful.
 */

import * as vscode from 'vscode';
import { TextEncoder } from 'node:util';
import { ModelService } from '../model/model-service.js';
import type { DiagramFile } from '../model/index.js';
import { diagramToMermaid } from './mermaid.js';

export function registerExportCommand(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vsuml.exportDiagramMermaid',
      async (uri?: vscode.Uri) => {
        const target = uri ?? activeDiagramUri();
        if (!target) {
          vscode.window.showWarningMessage(
            'VS UML: open a .umlclass / .umlsequence / .umlstate file first.'
          );
          return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const service = new ModelService(folder);
        try {
          const model = await service.getModel();
          const text = await vscode.workspace.fs.readFile(target);
          const diagram = JSON.parse(
            Buffer.from(text).toString('utf8')
          ) as DiagramFile;
          const mermaid = diagramToMermaid(model, diagram);
          const outPath = target.path.replace(
            /\.(umlclass|umlsequence|umlstate)$/,
            '.mmd'
          );
          const outUri = target.with({ path: outPath });
          await vscode.workspace.fs.writeFile(
            outUri,
            new TextEncoder().encode(mermaid)
          );
          const doc = await vscode.workspace.openTextDocument(outUri);
          await vscode.window.showTextDocument(doc);
        } finally {
          service.dispose();
        }
      }
    )
  );
}

function activeDiagramUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && isDiagram(active.fsPath)) return active;
  // Custom editors may not be a text editor; fall back to tab.
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  if (tab?.uri && isDiagram(tab.uri.fsPath)) return tab.uri;
  return undefined;
}

function isDiagram(path: string): boolean {
  return (
    path.endsWith('.umlclass') ||
    path.endsWith('.umlsequence') ||
    path.endsWith('.umlstate')
  );
}
