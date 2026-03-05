# Add Language Support

Add Tree-sitter grammar support for a new programming language.

## Usage
`/add-language <language-name>`

Example: `/add-language python`

## Steps

1. **Download the WASM grammar** for the target language:
   - Find the tree-sitter grammar package (e.g., `tree-sitter-python`)
   - Build or download the `.wasm` file
   - Place it in `grammars/tree-sitter-<language>.wasm`

2. **Add language config** to `src/languages.ts`:
   - Map the VS Code language ID to the grammar filename
   - Define AST node types for:
     - Function declarations (e.g., `function_definition` for Python)
     - Method declarations (e.g., `function_definition` inside `class_definition`)
     - Call expressions (e.g., `call` for Python)
     - Class declarations (e.g., `class_definition`)
   - Define how to extract the callee name from a call expression

3. **Create a test fixture** in `test/fixtures/`:
   - Write a source file with 4-6 functions that call each other
   - Include at least one class with methods if the language supports it
   - Include known call relationships (document them in comments)

4. **Add test case** to `test/CallGraphExtractor.test.ts`:
   - Parse the fixture file
   - Assert correct nodes (function names, types, line numbers)
   - Assert correct edges (caller → callee relationships)

5. **Run tests**: `npm test`

6. **Update CLAUDE.md** supported languages list if needed
