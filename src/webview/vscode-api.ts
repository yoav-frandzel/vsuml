/**
 * Thin typed wrapper around the VS Code webview API for the diagram editors.
 *
 * Centralises:
 *  - acquiring the `vscode` object exactly once,
 *  - typing inbound and outbound messages against the shared protocol,
 *  - persisting webview state across reloads.
 */

import type { HostToView, ViewToHost } from '../editors/protocol.js';

interface VsCodeApi {
  postMessage(msg: ViewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cached: VsCodeApi | undefined;

export function getVsCode(): VsCodeApi {
  if (!cached) cached = acquireVsCodeApi();
  return cached;
}

export type HostMessageHandler = (msg: HostToView) => void;

export function onHostMessage(handler: HostMessageHandler): () => void {
  const listener = (e: MessageEvent) => handler(e.data as HostToView);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export function post(msg: ViewToHost): void {
  getVsCode().postMessage(msg);
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'view.log', level, message });
}
