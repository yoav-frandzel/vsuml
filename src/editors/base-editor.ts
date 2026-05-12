/**
 * Base implementation shared by the three diagram editors.
 *
 * Concrete editors (class / sequence / state) only need to declare:
 *  - the viewType, file extension, expected diagram kind,
 *  - the script bundle path,
 *  - the function that creates an empty diagram for the "new" command.
 *
 * Everything else — webview HTML, model+document subscription, RPC handling,
 * model mutation dispatch — lives here.
 */

import * as vscode from 'vscode';
import { TextEncoder } from 'node:util';
import { ModelService } from '../model/model-service.js';
import {
  validateDiagram,
  type DiagramFile,
  type DiagramKind
} from '../model/index.js';
import { renderDiagramHtml } from './webview-html.js';
import type { HostToView, ViewKind, ViewToHost } from './protocol.js';
import {
  clearIfMatches,
  setActiveDiagram
} from './active-registry.js';

export interface DiagramEditorConfig {
  viewType: string;
  /** File extension without the leading dot. */
  extension: string;
  diagramKind: DiagramKind;
  viewKind: ViewKind;
  scriptPath: string;
  titlePrefix: string;
  /** Build a fresh diagram for the "New …" command. */
  createEmptyDiagram(
    name: string,
    service: ModelService
  ): Promise<DiagramFile> | DiagramFile;
}

export class BaseDiagramEditor implements vscode.CustomTextEditorProvider {
  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly service: ModelService,
    protected readonly config: DiagramEditorConfig
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };
    webviewPanel.webview.html = renderDiagramHtml(
      webviewPanel.webview,
      this.context.extensionUri,
      {
        scriptPath: this.config.scriptPath,
        title: `${this.config.titlePrefix} — ${document.uri.path}`
      }
    );

    const post = (msg: HostToView) => webviewPanel.webview.postMessage(msg);
    let lastWrittenText: string | undefined;

    const sendInit = async () => {
      const diagram = this._parse(document);
      const model = await this.service.getModel();
      post({
        type: 'host.init',
        viewKind: this.config.viewKind,
        model,
        diagram,
        readOnly: false
      });
      post({ type: 'host.validation', issues: validateDiagram(model, diagram) });
    };

    const modelSub = this.service.onDidChange(async event => {
      const model = await this.service.getModel();
      post({
        type: 'host.modelChanged',
        model,
        changed: event.changed,
        removed: event.removed
      });
      try {
        const diagram = this._parse(document);
        post({ type: 'host.validation', issues: validateDiagram(model, diagram) });
      } catch {
        /* mid-edit; ignore */
      }
    });

    const docSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const text = e.document.getText();
      if (text === lastWrittenText) {
        lastWrittenText = undefined;
        return;
      }
      try {
        const diagram = this._parse(document);
        post({ type: 'host.diagramChanged', diagram });
      } catch {
        /* ignore */
      }
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage(
      async (raw: ViewToHost) => {
        switch (raw.type) {
          case 'view.ready':
            await sendInit();
            break;
          case 'view.updateDiagram':
            lastWrittenText = await this._write(document, raw.diagram);
            break;
          case 'view.mutateModel':
            await this._handleMutation(post, raw);
            break;
          case 'view.log':
            log(raw.level, `[webview ${this.config.viewKind}] ${raw.message}`);
            break;
          case 'view.quickPick': {
            const pick = await vscode.window.showQuickPick(raw.items, {
              placeHolder: raw.placeHolder,
              title: raw.title
            });
            const index = pick ? raw.items.indexOf(pick) : -1;
            post({
              type: 'host.ack',
              requestId: raw.requestId,
              ok: true,
              data: index >= 0 ? { index } : undefined
            });
            break;
          }
          case 'view.inputBox': {
            const value = await vscode.window.showInputBox({
              prompt: raw.prompt,
              value: raw.value,
              placeHolder: raw.placeHolder,
              title: raw.title
            });
            post({
              type: 'host.ack',
              requestId: raw.requestId,
              ok: true,
              data: value === undefined ? undefined : { value }
            });
            break;
          }
          case 'view.confirm': {
            const choice = await vscode.window.showWarningMessage(
              raw.message,
              { modal: true },
              raw.okLabel ?? 'OK'
            );
            post({
              type: 'host.ack',
              requestId: raw.requestId,
              ok: true,
              data: { confirmed: choice !== undefined }
            });
            break;
          }
          case 'view.showMessage':
            if (raw.level === 'error') vscode.window.showErrorMessage(raw.message);
            else if (raw.level === 'warn') vscode.window.showWarningMessage(raw.message);
            else vscode.window.showInformationMessage(raw.message);
            break;
        }
      }
    );

    const viewStateSub = webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        setActiveDiagram({
          uri: document.uri,
          viewKind: this.config.viewKind,
          post: msg => void post(msg)
        });
      } else {
        clearIfMatches(document.uri);
      }
    });

    webviewPanel.onDidDispose(() => {
      modelSub.dispose();
      docSub.dispose();
      msgSub.dispose();
      viewStateSub.dispose();
      clearIfMatches(document.uri);
    });

    if (webviewPanel.active) {
      setActiveDiagram({
        uri: document.uri,
        viewKind: this.config.viewKind,
        post: msg => void post(msg)
      });
    }
  }

  /* -------------------------------------------------------------- */
  /* File IO                                                         */
  /* -------------------------------------------------------------- */

  protected _parse(document: vscode.TextDocument): DiagramFile {
    const text = document.getText().trim();
    if (text.length === 0) {
      throw new Error(
        `Empty diagram file; expected JSON of kind ${this.config.diagramKind}.`
      );
    }
    const parsed = JSON.parse(text) as DiagramFile;
    if (parsed.kind !== this.config.diagramKind) {
      throw new Error(
        `Expected ${this.config.diagramKind} but file kind is ${parsed.kind}.`
      );
    }
    return parsed;
  }

  protected async _write(
    document: vscode.TextDocument,
    diagram: DiagramFile
  ): Promise<string> {
    if (diagram.kind !== this.config.diagramKind) {
      throw new Error(
        `${this.config.viewType} cannot persist a ${diagram.kind} payload.`
      );
    }
    const text = JSON.stringify(diagram, null, 2) + '\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      text
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    return text;
  }

  /* -------------------------------------------------------------- */
  /* Mutation dispatch                                               */
  /* -------------------------------------------------------------- */

  protected async _handleMutation(
    post: (msg: HostToView) => Thenable<boolean>,
    msg: Extract<ViewToHost, { type: 'view.mutateModel' }>
  ): Promise<void> {
    try {
      const factory = await import('../model/factory.js');
      let newId: string | undefined;
      switch (msg.mutation.kind) {
        case 'createClass': {
          const c = factory.createClass(
            msg.mutation.name,
            msg.mutation.ownerId
          );
          await this.service.upsert(c);
          newId = c.id;
          break;
        }
        case 'createInterface': {
          const c = factory.createInterface(
            msg.mutation.name,
            msg.mutation.ownerId
          );
          await this.service.upsert(c);
          newId = c.id;
          break;
        }
        case 'createOperation': {
          const op = factory.createOperation(
            msg.mutation.name,
            msg.mutation.classifierId,
            'public',
            msg.mutation.returnType
          );
          await this.service.upsert(op);
          newId = op.id;
          break;
        }
        case 'createAttribute': {
          const a = factory.createAttribute(
            msg.mutation.name,
            msg.mutation.classifierId,
            msg.mutation.type ?? 'string'
          );
          await this.service.upsert(a);
          newId = a.id;
          break;
        }
        case 'createRelationship': {
          const model = await this.service.getModel();
          const r = factory.createRelationship(
            msg.mutation.relKind,
            msg.mutation.sourceId,
            msg.mutation.targetId,
            model.rootPackageId
          );
          await this.service.upsert(r);
          newId = r.id;
          break;
        }
        case 'createState': {
          const sm = await this.service.getElement(msg.mutation.stateMachineId);
          if (!sm || sm.kind !== 'StateMachine') {
            throw new Error(
              `Not a StateMachine: ${msg.mutation.stateMachineId}`
            );
          }
          const s = factory.createState(
            msg.mutation.name,
            msg.mutation.stateMachineId,
            msg.mutation.stateKind
          );
          await this.service.mutate(m => {
            m.elements[s.id] = s;
            const existing = m.elements[sm.id];
            if (existing.kind === 'StateMachine') {
              const top = existing.topStateIds.includes(s.id)
                ? existing.topStateIds
                : [...existing.topStateIds, s.id];
              m.elements[sm.id] = { ...existing, topStateIds: top };
            }
            return { changed: [s.id, sm.id], removed: [] };
          });
          newId = s.id;
          break;
        }
        case 'createTransition': {
          const t = factory.createTransition(
            msg.mutation.stateMachineId,
            msg.mutation.sourceStateId,
            msg.mutation.targetStateId
          );
          if (msg.mutation.trigger) t.trigger = msg.mutation.trigger;
          if (msg.mutation.guard) t.guard = msg.mutation.guard;
          if (msg.mutation.effect) t.effect = msg.mutation.effect;
          await this.service.upsert(t);
          newId = t.id;
          break;
        }
        case 'renameElement': {
          const el = await this.service.getElement(msg.mutation.id);
          if (!el) throw new Error(`No such element: ${msg.mutation.id}`);
          await this.service.upsert({ ...el, name: msg.mutation.name });
          break;
        }
        case 'deleteElement':
          await this.service.remove(msg.mutation.id);
          break;
        case 'updateElement': {
          const el = await this.service.getElement(msg.mutation.id);
          if (!el) throw new Error(`No such element: ${msg.mutation.id}`);
          await this.service.upsert({ ...el, ...msg.mutation.patch });
          break;
        }
      }
      post({
        type: 'host.ack',
        requestId: msg.requestId,
        ok: true,
        data: newId ? { id: newId } : undefined
      });
    } catch (err) {
      post({
        type: 'host.ack',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers shared by the "New …" commands                              */
/* ------------------------------------------------------------------ */

export async function createDiagramFile(
  folder: vscode.WorkspaceFolder,
  viewType: string,
  extension: string,
  diagram: DiagramFile,
  filename: string
): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(folder.uri, '.uml', 'diagrams');
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, `${filename}.${extension}`);
  const text = JSON.stringify(diagram, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  await vscode.commands.executeCommand('vscode.openWith', file, viewType);
  return file;
}

export function slug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'diagram'
  );
}

function log(level: 'info' | 'warn' | 'error', msg: string) {
  switch (level) {
    case 'warn':
      console.warn(msg);
      break;
    case 'error':
      console.error(msg);
      break;
    default:
      console.log(msg);
  }
}
