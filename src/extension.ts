import * as vscode from 'vscode';
import { ModelService } from './model/model-service.js';
import {
  ModelExplorerProvider,
  registerExplorerCommands
} from './explorer/model-explorer.js';
import {
  ClassDiagramEditorProvider,
  createNewClassDiagramFile
} from './editors/class-diagram-editor.js';
import {
  SequenceDiagramEditorProvider,
  createNewSequenceDiagramFile
} from './editors/sequence-diagram-editor.js';
import {
  StateDiagramEditorProvider,
  createNewStateDiagramFile
} from './editors/state-diagram-editor.js';
import { registerDiagnostics } from './validation/diagnostics.js';
import { registerExportCommand } from './export/export.js';

let modelService: ModelService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    modelService = new ModelService(folder);
    context.subscriptions.push(modelService);

    const provider = new ModelExplorerProvider(modelService);
    context.subscriptions.push(provider);
    const explorerView = vscode.window.createTreeView('vsumlModelExplorer', {
      treeDataProvider: provider,
      canSelectMany: false
    });
    context.subscriptions.push(explorerView);
    registerExplorerCommands(context, modelService, provider);

    context.subscriptions.push(
      ClassDiagramEditorProvider.register(context, modelService)
    );
    context.subscriptions.push(
      SequenceDiagramEditorProvider.register(context, modelService)
    );
    context.subscriptions.push(
      StateDiagramEditorProvider.register(context, modelService)
    );

    registerDiagnostics(context, modelService);

    context.subscriptions.push(
      vscode.commands.registerCommand('vsuml.newClassDiagram', async () => {
        await createNewClassDiagramFile(folder);
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('vsuml.newSequenceDiagram', async () => {
        await createNewSequenceDiagramFile(folder);
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('vsuml.newStateDiagram', async () => {
        if (!modelService) return;
        await createNewStateDiagramFile(folder, modelService);
      })
    );
    registerExportCommand(context);
  } else {
    for (const id of [
      'vsuml.newClassDiagram',
      'vsuml.newSequenceDiagram',
      'vsuml.newStateDiagram'
    ]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () => {
          vscode.window.showWarningMessage(
            'VS UML: open a workspace folder first.'
          );
        })
      );
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vsuml.helloWorld', async () => {
      if (!modelService) {
        vscode.window.showWarningMessage(
          'VS UML: open a workspace folder to use the model.'
        );
        return;
      }
      const model = await modelService.getModel();
      const count = Object.keys(model.elements).length;
      vscode.window.showInformationMessage(
        `VS UML: model loaded with ${count} element(s).`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vsuml.validateModel', async () => {
      if (!modelService) {
        vscode.window.showWarningMessage('VS UML: no workspace open.');
        return;
      }
      const issues = await modelService.validate();
      if (issues.length === 0) {
        vscode.window.showInformationMessage('VS UML: model is clean.');
      } else {
        vscode.window.showWarningMessage(
          `VS UML: ${issues.length} validation issue(s). See output panel.`
        );
        const channel = vscode.window.createOutputChannel('VS UML');
        for (const i of issues) {
          channel.appendLine(`[${i.severity}] ${i.message}`);
        }
        channel.show(true);
      }
    })
  );
}

export function deactivate(): void {
  modelService?.dispose();
  modelService = undefined;
}
