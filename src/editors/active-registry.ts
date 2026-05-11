/**
 * Registry of the currently-active diagram custom editor.
 *
 * The Model Explorer's "Add to active diagram" command needs a way to push
 * a model element into whichever diagram is in front. Each BaseDiagramEditor
 * instance registers its panel here on resolve / view-state changes.
 *
 * Only one diagram can be "active" at a time — the one most recently
 * focused.
 */

import * as vscode from 'vscode';
import type { HostToView, ViewKind } from './protocol.js';

export interface ActiveDiagram {
  uri: vscode.Uri;
  viewKind: ViewKind;
  post(msg: HostToView): void;
}

let active: ActiveDiagram | undefined;
const emitter = new vscode.EventEmitter<ActiveDiagram | undefined>();

export const onDidChangeActiveDiagram = emitter.event;

export function setActiveDiagram(d: ActiveDiagram | undefined): void {
  active = d;
  emitter.fire(active);
}

export function clearIfMatches(uri: vscode.Uri): void {
  if (active && active.uri.toString() === uri.toString()) {
    setActiveDiagram(undefined);
  }
}

export function getActiveDiagram(): ActiveDiagram | undefined {
  return active;
}
