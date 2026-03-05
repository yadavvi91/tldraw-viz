# Generate tldraw Diagram

Run the full code-to-diagram pipeline on a specific source file and output the resulting `.tldr` file.

## Usage
`/generate-tldr <file-path>`

Example: `/generate-tldr src/auth/login.ts`

## Steps

1. **Read the source file** at the given path

2. **Determine language** from file extension:
   - `.ts` → typescript, `.tsx` → typescriptreact
   - `.js`/`.jsx` → javascript
   - `.py` → python, `.go` → go, `.rs` → rust, `.java` → java

3. **Run the pipeline**:
   - Parse with Tree-sitter using the appropriate WASM grammar
   - Extract function/method declarations via `CodeAnalyzer`
   - Extract intra-file call graph via `CallGraphExtractor`
   - Check granularity filter (skip if too trivial)
   - Compute layout via dagre (`DiagramGenerator`)
   - Generate `.tldr` JSON via `TldrWriter`

4. **Write output** to `.tldraw/<relative-path>.tldr`
   - Create parent directories as needed
   - Include source hash in metadata for staleness detection

5. **Report results**:
   - Number of function nodes extracted
   - Number of call edges found
   - Output file path
   - Whether the file was skipped (and why) if granularity filter rejected it
