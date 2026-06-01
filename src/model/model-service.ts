/**
 * ModelService — the single source of truth for the workspace model.
 *
 * Responsibilities:
 *  - Locate `.uml/model.json` in the workspace (creating it on demand).
 *  - Load and parse the file; expose an in-memory view.
 *  - Provide CRUD operations that mutate the in-memory model and persist
 *    atomically with deterministic JSON ordering (for clean git diffs).
 *  - Emit change events so the Model Explorer and any open diagram editors
 *    can update.
 *
 * This service runs in the extension host. Webviews never touch the model
 * file directly; they go through this service via postMessage RPC.
 */

import * as vscode from 'vscode';
import { TextEncoder, TextDecoder } from 'node:util';
import {
  createEmptyModel,
  validateModel,
  type ElementId,
  type ModelElement,
  type ModelFile,
  type ValidationIssue
} from './index.js';
import { collectDescendants, serialiseModel } from './serialise.js';

export interface ModelChangeEvent {
  /** ids of elements that were added, modified, or removed. */
  changed: ElementId[];
  /** ids of elements that no longer exist after this change. */
  removed: ElementId[];
}

const MODEL_DIR = '.uml';
const MODEL_FILE = 'model.json';

export class ModelService implements vscode.Disposable {
  private _model: ModelFile | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<ModelChangeEvent>();
  /** Fires after every successful mutation, with the affected element ids. */
  readonly onDidChange = this._onDidChange.event;

  private readonly _fileWatcher: vscode.FileSystemWatcher | undefined;
  private _suppressExternalReload = 0;

  constructor(private readonly workspace: vscode.WorkspaceFolder) {
    const pattern = new vscode.RelativePattern(
      workspace,
      `${MODEL_DIR}/${MODEL_FILE}`
    );
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this._fileWatcher.onDidChange(() => this._maybeReloadFromDisk());
    this._fileWatcher.onDidCreate(() => this._maybeReloadFromDisk());
  }

  dispose(): void {
    this._fileWatcher?.dispose();
    this._onDidChange.dispose();
  }

  /** URI of the model file. Does not guarantee the file exists. */
  get modelUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspace.uri, MODEL_DIR, MODEL_FILE);
  }

  /** Returns the model, loading or creating it on first access. */
  async getModel(): Promise<ModelFile> {
    if (!this._model) {
      this._model = await this._loadOrCreate();
    }
    return this._model;
  }

  /** Read-only snapshot of an element, or undefined. */
  async getElement(id: ElementId): Promise<ModelElement | undefined> {
    const m = await this.getModel();
    return m.elements[id];
  }

  /** All elements owned by `ownerId` (direct children only). */
  async getChildren(ownerId: ElementId | null): Promise<ModelElement[]> {
    const m = await this.getModel();
    return Object.values(m.elements).filter(e => e.ownerId === ownerId);
  }

  /**
   * Apply a mutation to the model. The callback receives the live model and
   * may mutate it freely; on return we persist and broadcast the diff.
   *
   * The callback must return the list of element ids it touched (added or
   * modified). Removed ids are also passed back so the persisted file no
   * longer includes them. Returning empty arrays is fine for no-ops.
   */
  async mutate(
    fn: (model: ModelFile) => Promise<ModelChangeEvent> | ModelChangeEvent
  ): Promise<ModelChangeEvent> {
    const model = await this.getModel();

    // Snapshot the elements map so we can roll back on validation failure.
    const snapshot = { ...model.elements };

    const event = await fn(model);

    for (const removedId of event.removed) {
      delete model.elements[removedId];
    }

    const issues = validateModel(model);
    const errors = issues.filter(i => i.severity === 'error');
    if (errors.length > 0) {
      // Roll back the in-memory model to the pre-mutation state.
      model.elements = snapshot;
      throw new ModelValidationError(errors);
    }

    await this._persist(model);
    this._onDidChange.fire(event);
    return event;
  }

  /** Convenience: add or replace an element by id. */
  upsert(el: ModelElement): Promise<ModelChangeEvent> {
    return this.mutate(model => {
      model.elements[el.id] = el;
      return { changed: [el.id], removed: [] };
    });
  }

  /** Convenience: remove an element and (recursively) everything it owns. */
  remove(id: ElementId): Promise<ModelChangeEvent> {
    return this.mutate(model => {
      const toRemove = collectDescendants(model, id);
      return { changed: [], removed: toRemove };
    });
  }

  /** Validate the current in-memory model. */
  async validate(): Promise<ValidationIssue[]> {
    return validateModel(await this.getModel());
  }

  /* -------------------------------------------------------------- */
  /* Internal                                                        */
  /* -------------------------------------------------------------- */

  private async _loadOrCreate(): Promise<ModelFile> {
    const uri = this.modelUri;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as ModelFile;
      const issues = validateModel(parsed);
      const errors = issues.filter(i => i.severity === 'error');
      if (errors.length > 0) {
        vscode.window.showWarningMessage(
          `model.json failed validation (${errors.length} issue(s)); ` +
            `using it as-is and exposing diagnostics.`
        );
      }
      return parsed;
    } catch (err) {
      if (isFileNotFound(err)) {
        const created = createEmptyModel();
        await this._persist(created);
        return created;
      }
      throw err;
    }
  }

  private async _persist(model: ModelFile): Promise<void> {
    const dir = vscode.Uri.joinPath(this.workspace.uri, MODEL_DIR);
    await vscode.workspace.fs.createDirectory(dir);
    const text = serialiseModel(model);
    this._suppressExternalReload++;
    try {
      await vscode.workspace.fs.writeFile(
        this.modelUri,
        new TextEncoder().encode(text)
      );
    } finally {
      // Allow at most one suppressed reload — the watcher should fire once.
      setTimeout(() => {
        this._suppressExternalReload = Math.max(
          0,
          this._suppressExternalReload - 1
        );
      }, 250);
    }
  }

  private async _maybeReloadFromDisk(): Promise<void> {
    if (this._suppressExternalReload > 0) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.modelUri);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as ModelFile;
      this._model = parsed;
      this._onDidChange.fire({
        changed: Object.keys(parsed.elements),
        removed: []
      });
    } catch {
      // Ignore — file may be momentarily missing during writes.
    }
  }
}

export class ModelValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(
      `Model validation failed:\n` +
        issues.map(i => `  - [${i.severity}] ${i.message}`).join('\n')
    );
    this.name = 'ModelValidationError';
  }
}

function isFileNotFound(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const code = (err as { code?: string }).code;
    if (code === 'FileNotFound' || code === 'ENOENT') return true;
    const name = (err as { name?: string }).name;
    if (name === 'EntryNotFound (FileSystemError)') return true;
  }
  return false;
}
