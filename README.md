# VS UML Modeling

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/vsuml.vsuml)](https://marketplace.visualstudio.com/items?itemName=vsuml.vsuml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Visual Studio Code extension that brings back the core of the UML modeling
experience from Visual Studio 2010: a **shared workspace model** of UML
elements (classes, operations, state machines, ...) projected onto multiple
diagrams of three kinds — class, sequence, and state.

Editing a class once is reflected on every diagram that references it.
UML is used here as an abstraction; there is **no** two-way binding to source
code.

## Features

- **Class Diagrams** — visualize classes, interfaces, and relationships
  (association, aggregation, generalization, dependency)
- **Sequence Diagrams** — model object interactions with lifelines and messages
  (sync, async, reply, create)
- **State Diagrams** — define state machines with states, transitions, guards,
  and effects
- **Shared Model** — all diagrams reference one workspace model; change a class
  once and every diagram updates
- **Model Explorer** — tree view for browsing and editing model elements
- **Validation** — real-time diagnostics in the Problems panel
- **Mermaid Export** — one-click export to `.mmd` for embedding in docs

## Quick start

1. Open a folder in VS Code.
2. Open the **VS UML** view in the activity bar (the class-symbol icon).
3. From the **Model Explorer**, right-click the root package and choose
   *Add Class*, *Add Interface*, *Add Attribute*, *Add Operation* to build
   up the shared model.
4. From the command palette:
   - `VS UML: New Class Diagram`
   - `VS UML: New Sequence Diagram`
   - `VS UML: New State Diagram`
5. In a class diagram, click **+ Class** to add an existing model class to
   the canvas, then drag between two classes to create a relationship
   (kind selected from the toolbar dropdown). Double-click to rename or
   edit. Delete key removes selection.
6. In a sequence diagram, click **+ Lifeline** to pick a model class, then
   **+ Message** to add a message between lifelines. Messages of kind
   `sync`/`async` must reference an operation on the target lifeline's
   classifier — you can create one inline if needed. Drag messages
   vertically to reorder.
7. In a state diagram, add states using the toolbar, then drag between
   them to create transitions (you'll be prompted for trigger, guard and
   effect).
8. `VS UML: Export Diagram as Mermaid` writes a `.mmd` file next to the
   diagram for embedding in Markdown docs.

## File layout

```
<workspace>/
  .uml/
    model.json              # the shared model (single source of truth)
    diagrams/
      Domain.umlclass       # class diagrams
      PlaceOrder.umlsequence
      OrderLifecycle.umlstate
```

All files are deterministic JSON: stable element ordering, fixed key order,
clean git diffs.

## Strict shared-model integrity

The extension enforces that diagram view files always reference live model
elements. A sequence message of kind `sync` or `async` must point to a real
operation on the target lifeline's classifier; a state-diagram edge must
reference a valid transition between states; and so on. Violations show up
in the Problems view (`VS UML: Validate Model`).

## Development

```bash
npm install
npm run build      # one-shot build
npm run watch      # watch mode
npm run typecheck
npm test
```

Open the folder in VS Code and press `F5` to launch an Extension Development
Host.

## Building an installer (.vsix)

The extension ships as a standard VS Code `.vsix` package built with
[`@vscode/vsce`](https://github.com/microsoft/vscode-vsce):

```bash
npm install
npm run package           # produces vsuml-<version>.vsix
npm run install-extension # build + install into your local VS Code
```

To install a pre-built `.vsix` manually:

```bash
code --install-extension vsuml-0.0.1.vsix
```

Or in VS Code: **Extensions** view → `...` menu → **Install from VSIX...**

## Architecture

- **Model service** (`src/model/`): single source of truth. Loads and saves
  `.uml/model.json`, exposes `mutate / upsert / remove / onDidChange`.
- **Custom editors** (`src/editors/`): one per diagram kind; all share
  `BaseDiagramEditor` for RPC, document IO, and mutation dispatch.
- **Webview renderers** (`src/webview/`): React entry points.
  Class and state use [maxGraph](https://github.com/maxgraph/maxGraph).
  Sequence uses a custom React+SVG renderer because the time axis fits
  poorly into a graph engine.
- **Validation** (`src/validation/`): publishes `vscode.Diagnostic` for
  model and per-diagram referential integrity issues.
- **Export** (`src/export/`): one-way Mermaid serializers for all three
  diagram kinds.

## Status

v1. Three diagram kinds, shared model, validation diagnostics, Mermaid
export. No reverse-engineering from source code, no Mermaid→model
round-trip — by design.

