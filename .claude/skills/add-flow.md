# Add Code Flow

Define a cross-file code flow and generate its diagram.

## Usage
`/add-flow <flow-name> <entrypoint>`

Example: `/add-flow authentication src/auth/login.ts:handleLogin`

## Steps

1. **Parse the entrypoint** argument:
   - Format: `<file-path>:<function-name>`
   - Validate the file exists and the function is defined in it

2. **Add to config** in `.tldraw/tldraw.config.json`:
   ```json
   {
     "flows": [
       { "name": "<flow-name>", "entrypoint": "<file>:<function>" }
     ]
   }
   ```
   - Create `tldraw.config.json` if it doesn't exist
   - Merge with existing flows (don't overwrite)

3. **Trace the flow** using `FlowTracer`:
   - Start at the entrypoint function
   - Follow intra-file calls
   - Resolve imports to find cross-file function definitions
   - Build a cross-file call graph (respect depth limit, default 5)
   - Each node annotated with its source file

4. **Generate flow diagram**:
   - Write to `.tldraw/flows/<flow-name>.tldr`
   - Boxes show `functionName() [src/path.ts]`
   - Color-code by source file
   - dagre top-to-bottom layout

5. **Report results**:
   - Number of files traversed
   - Number of functions in the flow
   - Call depth reached
   - Output file path
