# Changelog: v2.0.20 to v2.0.35

All changes between v2.0.19 (commit e2dde21) and v2.0.35 (commit bdc5973).
Intermediate versions were not committed individually — this document
reconstructs the change history from the conversation transcript.

---

## v2.0.20 – v2.0.26: resolveSourceLines integration
**Files:** `src/extension.ts`

Added `resolveSourceLines()` function to `extension.ts` with 3 passes:
1. Direct AST name match (node name/id against extracted function names)
2. Prefix inheritance (e.g., `formatTime_calc` → `formatTime`)
3. Group/frame sibling inheritance + group label matching

Integrated `resolveSourceLines()` into two call sites:
- `convertMermaid()` (~line 531): called after `mermaidToCallGraph()`
- `setupMermaidWatcher()` (~line 1148): called in the .mmd file watcher

Added `sourceFile` derivation from .mmd path:
```typescript
const sourceFile = fileName
  .replace(new RegExp(`^${sd.getMermaidDir()}/`), '')
  .replace(/\.(overview|detail)(-\d+)?\.mmd$/, '');
```

Fixed regex escaping for `getMermaidDir()` (`.mermaid` → escaped `.` in regex).

**Problem:** Version bumps happened in package.json but `npm run build` was
never called — only `tsc --noEmit` (type-check) and `vsce package` (zip).
All VSIXes from v2.0.20–v2.0.29 shipped STALE dist/extension.js from v2.0.19.

---

## v2.0.27: Output channel logging
**Files:** `src/extension.ts`

Added output channel for diagnostics:
```typescript
const log = vscode.window.createOutputChannel('tldraw-viz', { log: true });
```

Added logging throughout `resolveSourceLines()`:
- Source file and URI being resolved
- AST functions found
- Resolution counts after each pass
- Final unresolved nodes warning

---

## v2.0.28: Enhanced findCurrentLine
**Files:** `src/extension.ts`

Rewrote `findCurrentLine()` from simple exact match to 4-level resolution:
1. Exact AST match
2. Cleaned label match (strip quotes, unescape `\n`)
3. Keyword search (AST function names in label text, longest first)
4. Fallback (file stem match or first function)

**Root cause identified:** `findCurrentLine` was doing
`nodes.find(n => n.name === functionName)` — an exact string match.
When the shape name was "Render header section\nwith title 'Building Comparison'",
it never matched anything, returning fallbackLine=0.

---

## v2.0.29: Navigation logging
**Files:** `src/TldrawEditorProvider.ts`

Added `tldraw-viz-nav` output channel:
```typescript
const navLog = vscode.window.createOutputChannel('tldraw-viz-nav', { log: true });
```

Added logging to `navigateToSource()`:
- Input file, line, name
- Resolution result from findCurrentLine

---

## v2.0.30: First actually working build
**Files:** (no source changes, build process fix)

**Critical discovery:** `npm run build` (esbuild) was never being run.
`dist/extension.js` was stale from v2.0.19. All previous VSIXes (v2.0.20–v2.0.29)
shipped the old code.

From this version onward: `npm run build && npx vsce package`.

---

## v2.0.31: Source text search in findCurrentLine
**Files:** `src/extension.ts`

Added source text search phase to `findCurrentLine()`:
- Direct identifier search (e.g., "onRemove" → find in source)
- Extracted identifier search from label words
- Keyword source search as last resort
- Skip list of common English words to avoid false matches

**Problem:** "onRemove" shape was navigating to `BuildingComparison` (line 75)
instead of line 9 where `onRemove` is defined. Source text search fixed this.

---

## v2.0.32: Prompt node ID naming rules
**Files:** `src/StructuralSummary.ts`

Added "Node ID naming rules" section to `getMermaidStyleInstructions()`:
- Use exact function/variable names from source code
- Never use single letters (A, B, C) or abbreviation prefixes (PC_, BC_)
- Descriptive camelCase IDs for steps

---

## v2.0.33: Source text search in resolveSourceLines + expanded prompt
**Files:** `src/extension.ts`, `src/StructuralSummary.ts`

Added pass 1.5 (keyword matching) and pass 3.5 (source text search) to
`resolveSourceLines()`. Added skip-word set for common English words.
Strengthened prompt to require exact source code identifiers as node IDs.

---

## v2.0.34: Comment line filtering
**Files:** `src/extension.ts`

Added `isCommentLine()` helper to skip comment lines in source text search.
Expanded skip-word list with more generic terms.

**Problem:** "conditional extraction complete" node was matching line 38
(a JSDoc comment containing "conditional logic"). Comment filtering fixed this.

**Realization:** This approach (skip lists, comment detection) is fundamentally
wrong — it's like `if (number == 2) return true; if (number == 4) return true;`
for finding even numbers.

---

## v2.0.35: NODE_MAP (correct approach)
**Files:** `src/MermaidParser.ts`, `src/MermaidConverter.ts`, `src/StructuralSummary.ts`, `src/extension.ts`

Complete architectural change — replaced all heuristic resolution with NODE_MAP.

### MermaidParser.ts
- Added `nodeLineMap: Record<string, number>` to `MermaidGraph` interface
- `parseMermaid()` extracts `%% NODE_MAP: nodeId -> lineNumber` from comments
- Returns `nodeLineMap` in parsed graph

### MermaidConverter.ts
- `mermaidToCallGraph()` uses `graph.nodeLineMap?.[mNode.id]` for line numbers
- Priority: explicit nodeMapping > NODE_MAP > 0

### StructuralSummary.ts
- Replaced node ID naming rules with NODE_MAP requirement in prompt
- Format: `%% NODE_MAP: nodeId -> lineNumber`
- Every node must have a NODE_MAP entry
- Line number must be the actual source line

### extension.ts
- Removed `isCommentLine()`, skip-word lists, source text search
- Simplified `resolveSourceLines()` to slim 3-pass AST fallback
- Simplified `findCurrentLine()` to AST match only (trusts NODE_MAP line)
- Kept output channel logging
