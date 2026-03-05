# tldraw-viz

VS Code extension that auto-generates tldraw call graph diagrams from source code. Companion to the official [tldraw VS Code extension](https://marketplace.visualstudio.com/items?itemName=tldraw-org.tldraw-vscode) — we generate `.tldr` files, they render them.

## Tech Stack

- **TypeScript**, Node.js (no browser/webview code)
- **web-tree-sitter** (WASM) for multi-language AST parsing
- **@dagrejs/dagre** for directed graph layout
- **VS Code Extension API** — commands, file system, workspace
- Depends on `tldraw-org.tldraw-vscode` for rendering `.tldr` files

## Dev Commands

```bash
npm run build       # esbuild production build
npm run watch       # esbuild watch mode
npm test            # vitest
npm run package     # build + vsce package → .vsix
                    # F5 in VS Code → launch Extension Development Host
```

## Architecture

```
src/              → Extension code (Node.js, runs in VS Code extension host)
grammars/         → Tree-sitter .wasm files (bundled in VSIX)
test/             → vitest tests + per-language fixture files
test/fixtures/    → Source files for testing call graph extraction
```

No webview code. We generate `.tldr` files and open them with the official tldraw extension via `vscode.commands.executeCommand('vscode.openWith', uri, 'tldraw.tldr', ViewColumn.Beside)`.

## Key Patterns

- **All .tldr generation goes through `TldrWriter.ts`** — never construct raw `.tldr` JSON elsewhere
- **Tree-sitter grammars loaded lazily** per language via `languages.ts`
- **Shadow directory logic** is in `ShadowDirectory.ts` — file mapping, caching, staleness detection
- **Call graph pipeline**: `CodeAnalyzer` (parse) → `CallGraphExtractor` (edges) → `DiagramGenerator` (layout + shapes)
- **Granularity filtering** in `GranularityFilter.ts` — skip trivial files (config, constants, types)
- **Code flows** traced cross-file by `FlowTracer.ts` using import resolution
- **Click-to-navigate** — each diagram shape has a `vscode://` URI in its `url` prop + a Quick Pick command (`Cmd+Shift+G`)

## Supported Languages

TypeScript, TSX, JavaScript, Python, Go, Rust, Java

## Shadow Directory (`.tldraw/`)

Generated diagrams live in `.tldraw/` at the project root, mirroring the source tree:
```
.tldraw/
├── src/auth/login.ts.tldr          # Per-file call graph
├── src/services/api.ts.tldr
├── flows/                          # Cross-file execution flows
│   ├── authentication.tldr
│   └── api-request.tldr
├── project-architecture.tldr       # Whole-project overview (Claude-generated)
└── tldraw.config.json              # Skip patterns, flow config
```

Committed to git as living documentation.

## Adding a New Language

1. Download the `.wasm` grammar file to `grammars/`
2. Add language config to `languages.ts` (VS Code language ID → grammar file, AST node types for functions and calls)
3. Add a fixture file to `test/fixtures/` with known call relationships
4. Add a test case to `CallGraphExtractor.test.ts`
5. Run `npm test` to verify

## Project Links

- **GitHub**: https://github.com/yadavvi91/tldraw-viz
- **Project Board**: https://github.com/users/yadavvi91/projects/5
- **Issues**: https://github.com/yadavvi91/tldraw-viz/issues
