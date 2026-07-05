/**
 * Builds the HTML scaffolding for a diagram webview.
 *
 * Each diagram editor (class/sequence/state) loads a different bundle from
 * `media/`. Webviews run with a strict CSP and use VS Code's nonce mechanism
 * to allow only our own inline init script and our bundled script.
 */

import * as vscode from 'vscode';

export interface WebviewBundle {
  /** Path to the JS bundle, relative to the extension root (e.g. `media/class-diagram.js`). */
  scriptPath: string;
  title: string;
}

export function renderDiagramHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: WebviewBundle
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, bundle.scriptPath)
  );
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>${escapeHtml(bundle.title)}</title>
    <style>
      html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
      #root { height: 100vh; display: flex; flex-direction: column; }
      .vsuml-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorWidget-background); font-size: 12px; flex-wrap: wrap; }
      .vsuml-toolbar strong { margin-right: 8px; }
      .vsuml-toolbar button, .vsuml-toolbar select { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); border: 1px solid var(--vscode-button-border, transparent); padding: 2px 8px; cursor: pointer; font-size: 12px; font-family: inherit; }
      .vsuml-toolbar button:hover { background: var(--vscode-button-hoverBackground); }
      .vsuml-zoom { display: inline-flex; align-items: center; gap: 2px; }
      .vsuml-zoom button { min-width: 24px; text-align: center; }
      .vsuml-toolbar-info { margin-left: auto; opacity: 0.75; }
      .vsuml-canvas { flex: 1; overflow: hidden; position: relative; outline: none; }
      .vsuml-status { padding: 4px 8px; font-size: 12px; border-top: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); }
    </style>
  </head>
  <body>
    <div id="root"><div style="padding:12px;">Loading diagram…</div></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function makeNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c] as string
  );
}
