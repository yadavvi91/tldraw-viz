# tldraw Code Visualizer

Auto-generate interactive call graph diagrams from source code, rendered in [tldraw](https://www.tldraw.com/).

## Prerequisites

- VS Code 1.85+
- [tldraw VS Code extension](https://marketplace.visualstudio.com/items?itemName=tldraw-org.tldraw-vscode) (`tldraw-org.tldraw-vscode`)

## Installation

Install from VSIX:

```
code --install-extension tldraw-viz-0.4.1.vsix
```

Or in VS Code: **Extensions** > **...** > **Install from VSIX...**

## Quick Start

1. Open a source file (TypeScript, Python, Go, Rust, or Java)
2. Run **Cmd+Shift+P** > **tldraw: Show Code Diagram**
3. A `.tldr` diagram opens beside your code showing function call relationships

For Claude-powered diagrams with richer layout:

1. Run **Cmd+Shift+P** > **tldraw: Set Anthropic API Key** and enter your key
2. Open a source file
3. Run **tldraw: Generate Overview Diagram with Claude**

## Commands

All commands are in the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) under the **tldraw** category.

### Diagram Generation

| Command | Description |
|---|---|
| **Show Code Diagram** | Generate a call graph from the active file using AST analysis. Opens as a tldraw diagram. Keyboard shortcut: `Cmd+Shift+D` / `Ctrl+Shift+D` |
| **Generate All Diagrams** | Batch-generate diagrams for every supported file in the workspace. Skips files matching skip patterns and files with too few functions. |
| **Generate Flow Diagrams** | Generate cross-file flow diagrams from entrypoints defined in `.tldraw/tldraw.config.json`. |
| **Convert Mermaid to tldraw** | Convert the active `.mmd` or `.mermaid` file to a `.tldr` diagram. |

### Claude API (requires API key)

| Command | Description |
|---|---|
| **Generate Overview Diagram with Claude** | Send the active file's call graph to Claude, get a high-level behavioral mermaid flowchart back, and open as tldraw. Uses ~$0.01-0.02 per diagram. |
| **Generate Detail Diagram with Claude** | Same pipeline but generates a detailed function-level flowchart with every call chain and branch. |
| **Generate Project Architecture with Claude** | Scan the entire workspace, discover modules, analyze cross-module imports, and generate a high-level architecture diagram showing module dependencies. |
| **Set Anthropic API Key** | Store your Anthropic API key securely (encrypted via VS Code secrets). |
| **Clear Anthropic API Key** | Remove the stored API key. |

### Clipboard Fallback (no API key needed)

| Command | Description |
|---|---|
| **Copy Overview Summary for Claude** | Copy a high-level prompt to clipboard. Paste into Claude manually, then paste the mermaid output into the opened `.mmd` file. |
| **Copy Detail Summary for Claude** | Same as above but for a detailed function-level prompt. |

## How It Works

### AST Pipeline (Show Code Diagram)

```
Source file (.ts, .py, .go, .rs, .java)
    -> Tree-sitter AST parsing
    -> Function/method extraction
    -> Call graph edge detection
    -> Semantic analysis (roles, shapes, colors)
    -> dagre layout
    -> .tldr file generation
    -> Opens in tldraw
```

### Claude Pipeline (Generate Overview/Detail)

```
Source file
    -> Tree-sitter AST parsing
    -> Call graph extraction + semantic analysis
    -> Prompt generation (overview or detail)
    -> Claude Sonnet 4.6 API call
    -> Mermaid output extraction
    -> Mermaid -> CallGraph conversion
    -> dagre layout -> .tldr
    -> Opens in tldraw
    -> Status bar shows token count + cost
```

The Claude pipeline produces richer, more readable diagrams because Claude understands the behavioral intent of the code, not just the syntactic structure.

## Configuration

### VS Code Settings

| Setting | Default | Description |
|---|---|---|
| `tldraw-viz.shadowDir` | `.tldraw` | Directory for generated `.tldr` files |
| `tldraw-viz.mermaidDir` | `.mermaid` | Directory for generated `.mmd` files |
| `tldraw-viz.minFunctions` | `3` | Minimum functions required to generate a diagram |
| `tldraw-viz.skipPatterns` | `["**/config.*", "**/*.d.ts", "**/types.*", "**/constants.*"]` | Glob patterns for files to skip |

### Flow Configuration

Create `.tldraw/tldraw.config.json` in your workspace root to define cross-file flows:

```json
{
  "skip": ["**/config.*", "**/*.d.ts"],
  "minFunctions": 3,
  "flows": [
    {
      "name": "authentication",
      "entrypoint": "src/auth/login.ts:handleLogin"
    },
    {
      "name": "checkout",
      "entrypoint": "src/checkout/index.ts:processOrder"
    }
  ]
}
```

Each flow traces function calls starting from `entrypoint` across imported files (up to 5 levels deep). The entrypoint format is `filePath:functionName`.

Run **tldraw: Generate Flow Diagrams** to generate all configured flows.

### Module Configuration (Project Architecture)

Define modules for the project architecture diagram. If omitted, modules are auto-detected from top-level directories under `src/`.

```json
{
  "modules": [
    {
      "name": "Backend API",
      "include": ["src/api/**", "src/services/**"],
      "description": "REST API and service layer"
    },
    {
      "name": "Frontend UI",
      "include": ["src/components/**", "src/pages/**"],
      "description": "React components and pages"
    },
    {
      "name": "Data Layer",
      "include": ["src/data/**", "src/store/**"],
      "description": "State management and data fetching"
    }
  ]
}
```

Run **tldraw: Generate Project Architecture with Claude** to generate the architecture diagram.

## Shadow Directories

Generated files are stored in shadow directories that mirror your project structure:

```
project/
  src/
    components/
      Button.tsx
  .tldraw/               # AST-generated diagrams
    src/
      components/
        Button.tsx.tldr
    flows/
      authentication.tldr
  .mermaid/              # Claude-generated mermaid + diagrams
    src/
      components/
        Button.tsx.overview.mmd
        Button.tsx.overview.tldr
        Button.tsx.detail.mmd
        Button.tsx.detail.tldr
```

Add `.tldraw/` and `.mermaid/` to your `.gitignore`.

## Supported Languages

| Language | Extensions | Features |
|---|---|---|
| TypeScript | `.ts`, `.tsx` | Full support + React component analysis |
| JavaScript | `.js`, `.jsx` | Full support + React component analysis |
| Python | `.py` | Functions, classes, methods |
| Go | `.go` | Functions, methods |
| Rust | `.rs` | Functions, impl methods |
| Java | `.java` | Classes, methods |

## File Watchers

The extension automatically regenerates diagrams when you save:

- **Source files** — If a `.tldr` already exists for a file, it auto-regenerates on save (500ms debounce)
- **Mermaid files** — `.mmd` and `.mermaid` files auto-convert to `.tldr` on save

## API Key Security

Your Anthropic API key is stored using VS Code's [SecretStorage API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), which encrypts the key using your OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service). The key is never written to settings.json or any file on disk.

## Version History

- **v0.5.0** — Project architecture diagrams: auto-detect modules, cross-module import analysis, Claude-powered architecture generation
- **v0.4.1** — README documentation
- **v0.4.0** — Claude API integration: one-click diagram generation, API key management, status bar token/cost display
- **v0.3.1** — Two-level prompts (overview + detail), `.mermaid` shadow directory, classDef styles
- **v0.3.0** — Mermaid bridge: parser, converter, `convertMermaid` command, `.mmd` file watcher
- **v0.2.0** — Rich diagrams: semantic analysis, role-based shapes/colors, frames, edge labels
- **v0.1.0** — Initial release: AST parsing, call graph extraction, dagre layout, `.tldr` generation

## License

MIT
