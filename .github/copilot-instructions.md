# VS UML — Copilot instructions

A VS Code extension that recreates Visual Studio 2010's UML modelling: a shared
workspace **model** projected onto multiple **diagram views**. There is no
two-way binding with source code — UML is used here as an abstraction layer,
not as a code transformation. Keep these invariants intact.

## Core architecture

- **Model is the source of truth.** Persisted as a single JSON file at
  `<workspace>/.uml/model.json`. Loaded, mutated, and saved via
  `src/model/model-service.ts`. Element kinds live in `src/model/types.ts`.
- **Diagrams are views.** Each diagram file (`*.umlclass`, `*.umlsequence`,
  `*.umlstate`) is a JSON document with view-specific layout state and
  **references to model elements by UUID** (`elementId`). Diagrams never
  duplicate model data; they only position and select what already exists in
  the model.
- **Three diagram kinds, no more:** Class, Sequence, State. State diagrams
  are owned by a single `StateMachine` (which is owned by a `Class`).
- **Relationship kinds** for class diagrams: `Association`, `Generalization`,
  `Dependency`. (Realization was intentionally removed.) Source of truth is
  the `RelationshipKind` union in `src/model/types.ts`; the toolbar dropdown,
  the renderer edge styles, and the Mermaid exporter must all stay in sync
  with that union.
- **The Model Explorer** (`src/explorer/model-explorer.ts`) is the canonical
  list of model elements. Diagrams and the explorer subscribe to
  `ModelService.onDidChange`.
- **Mermaid export** (`src/export/mermaid.ts`) is the only "downstream"
  representation; tests in `src/export/mermaid.test.ts` lock in the
  expected output for each diagram kind.

## Repository layout (key files)

```
src/
  extension.ts                 activation entry; registers the explorer,
                               editors, commands, diagnostics
  model/
    types.ts                   ModelElement union (Class, Interface, ...)
    model-service.ts           single-instance model loader/writer
    factory.ts                 createClass / createOperation / ...
    validate.ts                model-level validation rules
    serialise.ts               JSON read/write
  editors/
    base-editor.ts             shared CustomTextEditor base for all 3 kinds
    class-diagram-editor.ts    one of 3 thin wrappers around base-editor
    sequence-diagram-editor.ts
    state-diagram-editor.ts
    protocol.ts                ViewToHost / HostToView message envelope
    active-registry.ts         which diagram panel is currently focused
    webview-html.ts            webview shell + CSP
  webview/
    vscode-api.ts              cached acquireVsCodeApi + post / onHostMessage
    shared/rpc.ts              QuickPick / InputBox / confirm / showMessage
                               helpers + requestMutation
    class-diagram/             {main.tsx, renderer.ts, toolbar.tsx}
    sequence-diagram/          {main.tsx, layout.ts}
    state-diagram/             {main.tsx, renderer.ts}
  explorer/model-explorer.ts   TreeDataProvider + view commands
  export/mermaid.ts            diagram → Mermaid converter
  validation/diagnostics.ts    surfaces model issues in the Problems panel
```

## Build / test / verify

Run these after any change (in order):

```bash
npm run typecheck      # tsc --noEmit
npm run build          # esbuild bundles host + 3 webview entries
npm test               # vitest run (model, serialise, mermaid)
```

Lint is available (`npm run lint`) but isn't part of the default verify loop.

To exercise the extension end-to-end, press **F5** in VS Code to launch the
Extension Development Host. `.vscode/tasks.json` has explicit `npm: build`
and `npm: watch` labels because VS Code Insiders does not auto-resolve
implicit task labels.

## Hard rules — gotchas we already paid for

1. **Never call `window.prompt`, `window.alert`, or `window.confirm` inside
   a webview.** They are no-ops in VS Code webviews and fail silently. Use
   the host-mediated helpers from `src/webview/shared/rpc.ts`:
   `showQuickPick`, `showInputBox`, `confirm`, `showMessage`. Each is backed
   by a `view.quickPick` / `view.inputBox` / `view.confirm` /
   `view.showMessage` RPC message handled in `base-editor.ts`.

2. **`acquireVsCodeApi()` may only be called once per webview.**
   `src/webview/vscode-api.ts` caches it. Import `post` / `onHostMessage`
   from there; do not call the underlying API directly.

3. **QuickPick item id passthrough.** `vscode.window.showQuickPick` returns
   the original item object. To recover an element id, stash it in the
   item's `detail` field (not `description` and not by name-matching the
   `label`). The shared `showQuickPick` helper returns
   `{ label, description?, detail? }`.

4. **Drag-and-drop from a `TreeView` to a webview is not viable.** The
   `DataTransfer` payload does not cross the webview iframe boundary —
   only the MIME type list does, `getData()` returns empty. We tried
   capture-phase window listeners; it still doesn't work reliably. The
   accepted pattern is the **`vsuml.explorer.addToActiveDiagram` command**
   plus `active-registry.ts` to track which diagram is focused. Add new
   ways of moving elements onto a diagram by extending that command, not
   by re-attempting HTML5 DnD.

5. **Self-echo suppression.** `BaseDiagramEditor` records `lastWrittenText`
   so the host's own writes don't loop back through
   `onDidChangeTextDocument`. Preserve that pattern when you add new write
   paths.

6. **Right-click in a webview shows the browser's Cut/Copy/Paste menu by
   default.** Always `preventDefault` on `contextmenu` inside diagram
   canvases and render our own popup (see the Delete-only menu in
   `class-diagram/main.tsx`).

7. **maxGraph quirks:**
   - The HTML label is sized to the cell geometry; if the label's actual
     rendered height exceeds the cell height the content visibly overflows
     the rounded border. Always size cell geometry with explicit pixel
     line-heights — never unitless `line-height` values — and keep
     `computeNodeHeight()` in sync.
   - Use `graph.model.setValue(cell, html)` (not `cell.value = …`) to
     update the label so maxGraph re-renders the foreignObject.
   - maxGraph's drag-from-edge connection gesture has no visible handle in
     the default style; we keep an explicit **+ Edge…** toolbar button as
     the discoverable path. Drag-to-connect is also supported but
     undiscoverable.

8. **Webview drop events do not reliably fire.** See rule 4. Don't add
   `dragover` / `drop` handlers expecting them to work.

9. **`TreeItem.command` fires on a single click (default openMode).**
   There is no native double-click event on a `TreeView`. If you need
   double-click semantics, manually debounce in the command handler.

10. **Active diagram tracking.** `BaseDiagramEditor.resolveCustomTextEditor`
    registers the panel with the active-registry on resolve and on
    `onDidChangeViewState`, and clears it on dispose. New cross-pane
    actions that target "the current diagram" must read
    `getActiveDiagram()` (don't pass URIs around).

## Conventions

- **TypeScript** with `tsc --noEmit` typechecking; the bundler is esbuild
  via `esbuild.mjs`. Source files use ESM-style imports with `.js`
  extensions on relative paths (TS is configured for `moduleResolution: node16`).
- **React 19** powers the webview UIs. Keep state local to the diagram
  components; cross-cutting state goes through RPC messages, never
  through globals.
- **Tests** are vitest. Add model and exporter tests in
  `src/**/*.test.ts`; do not write tests that require a VS Code host.
- **Comments only where necessary.** Don't comment obvious code.
- **No two-way binding with source code.** Resist suggestions to generate
  C#/TypeScript from the model or vice versa — that's an explicit
  non-goal.
- **`.gitignore`** excludes `node_modules/`, `dist/`, `media/*.js`,
  `media/*.js.map`. Source-only commits.

## Common tasks

- **Add a new model element kind**: extend `ModelElement` in `types.ts`,
  add a factory in `factory.ts`, add a tree icon + label in
  `model-explorer.ts`, and add validation in `validate.ts`. Then add
  tests in `src/model/model.test.ts`.
- **Add a new view-to-host message**: extend the `ViewToHost` union in
  `protocol.ts`, add a `case` in `BaseDiagramEditor._msgSub`. For
  request/response messages, use the `view.mutateModel` →
  `host.ack { requestId }` pattern via `requestMutation` in `rpc.ts`.
- **Add a new diagram-side toolbar action**: add a handler in
  `<kind>/main.tsx`, surface it in `<kind>/toolbar.tsx` (class) or the
  inline toolbar JSX (sequence/state). Use `showQuickPick` /
  `showInputBox` for any interactive prompts.
