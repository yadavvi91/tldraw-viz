# Test All Languages Agent

Run call graph extraction tests against fixture files for all supported languages and report results.

## What This Agent Does

1. **Find all test fixtures** in `test/fixtures/`
2. **For each fixture**:
   - Determine language from file extension
   - Load the appropriate Tree-sitter WASM grammar
   - Parse the file and extract the AST
   - Run `CodeAnalyzer` to extract function/method declarations
   - Run `CallGraphExtractor` to extract call edges
   - Compare results against expected nodes/edges (from test assertions or fixture comments)
3. **Run the full test suite**: `npm test`
4. **Report**:
   - Per-language pass/fail status
   - Any languages with missing fixtures or grammars
   - Total nodes and edges extracted per fixture
   - Any unexpected failures or parsing errors

## When to Use

- After adding a new language (to verify it works alongside existing ones)
- After modifying `CodeAnalyzer.ts` or `CallGraphExtractor.ts`
- Before releasing a new version
- As a sanity check during development

## Expected Output

```
Language Results:
  TypeScript:      PASS (fixture: simple.ts — 5 nodes, 4 edges)
  TSX:             PASS (fixture: component.tsx — 3 nodes, 2 edges)
  JavaScript:      PASS (fixture: simple.js — 4 nodes, 3 edges)
  Python:          PASS (fixture: simple.py — 4 nodes, 3 edges)
  Go:              PASS (fixture: simple.go — 3 nodes, 2 edges)
  Rust:            PASS (fixture: simple.rs — 4 nodes, 3 edges)
  Java:            PASS (fixture: Simple.java — 3 nodes, 2 edges)

All 7 languages passing.
```
