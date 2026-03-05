# Validate .tldr Files Agent

Validate that generated `.tldr` files have the correct format and can be opened by the official tldraw VS Code extension.

## What This Agent Does

1. **Find all `.tldr` files** in `.tldraw/` directory (both per-file and flows)
2. **For each file**, validate:
   - Valid JSON (parseable)
   - Has `tldrawFileFormatVersion` field (number)
   - Has `schema` field (object with `schemaVersion` and `sequences`)
   - Has `records` field (array)
   - Required system records present: document record, page record
   - Shape records have required fields: `id`, `typeName`, `type`, `x`, `y`, `props`
   - Arrow shapes have valid binding references
   - Binding records reference existing shape IDs
   - `meta` fields present on shapes (sourceLine, sourceFile)
3. **Check staleness**:
   - Read `_tldrawVizMeta.sourceHash` if present
   - Compare with current source file hash
   - Report stale diagrams
4. **Report**:
   - Per-file validation status (valid/invalid/stale)
   - Specific errors for invalid files
   - Summary: total files, valid count, invalid count, stale count

## When to Use

- After running `tldraw-viz.generateAll` to verify all output
- After modifying `TldrWriter.ts` or `DiagramGenerator.ts`
- Before committing `.tldraw/` changes
- To debug "file won't open in tldraw" issues

## Expected Output

```
Validating .tldraw/ files...

  .tldraw/src/auth/login.ts.tldr        VALID  (12 shapes, 8 bindings, fresh)
  .tldraw/src/services/api.ts.tldr      VALID  (15 shapes, 11 bindings, fresh)
  .tldraw/src/auth/session.ts.tldr      STALE  (source changed since generation)
  .tldraw/flows/authentication.tldr     VALID  (8 shapes, 6 bindings, fresh)

Summary: 4 files — 3 valid, 0 invalid, 1 stale
```
