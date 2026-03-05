import { describe, it, expect } from 'vitest';
import { detectEntrypoints, entrypointsToFlowConfigs } from '../src/EntrypointDetector';
import type { FileReader } from '../src/FlowTracer';

function createMemoryReader(files: Record<string, string>): FileReader {
	return {
		async readFile(absolutePath: string): Promise<string> {
			const content = files[absolutePath];
			if (content === undefined) throw new Error(`File not found: ${absolutePath}`);
			return content;
		},
		async listFiles(): Promise<string[]> {
			return Object.keys(files);
		},
	};
}

describe('EntrypointDetector', () => {
	const root = '/workspace';

	describe('Express routes', () => {
		it('detects app.get/post/put/delete routes', async () => {
			const reader = createMemoryReader({
				'/workspace/src/routes.ts': `
import express from 'express';
const app = express();
app.get('/api/users', getUsers);
app.post('/api/login', handleLogin);
app.delete('/api/users/:id', deleteUser);
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(3);
			expect(results[0]).toMatchObject({
				functionName: 'getUsers',
				pattern: 'express-route',
				description: 'GET /api/users',
			});
			expect(results[1]).toMatchObject({
				functionName: 'handleLogin',
				pattern: 'express-route',
				description: 'POST /api/login',
			});
			expect(results[2]).toMatchObject({
				functionName: 'deleteUser',
				pattern: 'express-route',
				description: 'DELETE /api/users/:id',
			});
		});

		it('detects router.get/post routes', async () => {
			const reader = createMemoryReader({
				'/workspace/src/api/users.ts': `
const router = express.Router();
router.get('/users', listUsers);
router.post('/users', createUser);
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(2);
			expect(results[0].functionName).toBe('listUsers');
			expect(results[1].functionName).toBe('createUser');
		});
	});

	describe('Flask routes', () => {
		it('detects @app.route decorator', async () => {
			const reader = createMemoryReader({
				'/workspace/app.py': `
from flask import Flask
app = Flask(__name__)

@app.route('/login', methods=['POST'])
def handle_login():
    validate_credentials()
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				functionName: 'handle_login',
				pattern: 'flask-route',
				description: 'POST /login',
			});
		});

		it('detects @app.get/@app.post decorators (Flask 2.x)', async () => {
			const reader = createMemoryReader({
				'/workspace/routes.py': `
@app.get('/users')
def list_users():
    return get_all_users()

@app.post('/users')
def create_user():
    return save_user()
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(2);
			expect(results[0].description).toBe('GET /users');
			expect(results[1].description).toBe('POST /users');
		});
	});

	describe('FastAPI routes', () => {
		it('detects @router.get decorator', async () => {
			const reader = createMemoryReader({
				'/workspace/api/items.py': `
from fastapi import APIRouter
router = APIRouter()

@router.get('/items')
async def list_items():
    return await get_items()
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				functionName: 'list_items',
				pattern: 'fastapi-route',
				description: 'GET /items',
			});
		});

		it('detects async def handlers', async () => {
			const reader = createMemoryReader({
				'/workspace/main.py': `
@app.post('/submit')
async def handle_submit():
    await process()
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results.some(r => r.functionName === 'handle_submit')).toBe(true);
		});
	});

	describe('Main functions', () => {
		it('detects TypeScript/JS main()', async () => {
			const reader = createMemoryReader({
				'/workspace/src/cli.ts': `
export async function main() {
	await init();
	startServer();
}
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				functionName: 'main',
				pattern: 'main-function',
				description: 'main() entry',
			});
		});

		it('detects Python if __name__ == "__main__"', async () => {
			const reader = createMemoryReader({
				'/workspace/run.py': `
def run_server():
    setup()

if __name__ == '__main__':
    run_server()
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0].functionName).toBe('run_server');
			expect(results[0].pattern).toBe('main-function');
		});

		it('detects Go func main()', async () => {
			const reader = createMemoryReader({
				'/workspace/cmd/server/main.go': `
package main

import "fmt"

func main() {
	fmt.Println("Starting server")
	run()
}
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0].functionName).toBe('main');
			expect(results[0].pattern).toBe('main-function');
		});

		it('detects Rust fn main()', async () => {
			const reader = createMemoryReader({
				'/workspace/src/main.rs': `
fn main() {
    let config = load_config();
    run(config);
}
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0].functionName).toBe('main');
		});

		it('detects Java public static void main', async () => {
			const reader = createMemoryReader({
				'/workspace/src/Main.java': `
public class Main {
    public static void main(String[] args) {
        Application.run(args);
    }
}
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(1);
			expect(results[0].functionName).toBe('main');
		});

		it('skips Go files without package main', async () => {
			const reader = createMemoryReader({
				'/workspace/pkg/utils/helper.go': `
package utils

func main() {
	// This isn't a real entrypoint
}
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(0);
		});
	});

	describe('Exported handlers', () => {
		it('detects handler-named exports from entry-point files', async () => {
			const reader = createMemoryReader({
				'/workspace/src/server.ts': `
export function handleRequest(req: Request) { return process(req); }
export async function startServer() { listen(3000); }
export function processQueue() { drain(); }
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(3);
			expect(results.map(r => r.functionName)).toEqual([
				'handleRequest', 'startServer', 'processQueue',
			]);
			expect(results[0].pattern).toBe('exported-handler');
		});

		it('ignores non-handler exports', async () => {
			const reader = createMemoryReader({
				'/workspace/src/index.ts': `
export function getConfig() { return {}; }
export function calculateTotal() { return 0; }
export function handleAuth() { return true; }
`,
			});

			const results = await detectEntrypoints(reader, root);

			// Only handleAuth should match (handle* pattern)
			expect(results).toHaveLength(1);
			expect(results[0].functionName).toBe('handleAuth');
		});

		it('only applies to entry-point filenames', async () => {
			const reader = createMemoryReader({
				'/workspace/src/utils/helpers.ts': `
export function handleError(err: Error) { log(err); }
`,
			});

			const results = await detectEntrypoints(reader, root);

			// helpers.ts is not an entry-point filename
			expect(results).toHaveLength(0);
		});
	});

	describe('entrypointsToFlowConfigs', () => {
		it('converts detected entrypoints to FlowConfig format', () => {
			const entrypoints = [
				{
					file: 'src/routes.ts',
					functionName: 'handleLogin',
					pattern: 'express-route' as const,
					description: 'POST /api/login',
				},
				{
					file: 'src/main.ts',
					functionName: 'main',
					pattern: 'main-function' as const,
					description: 'main() entry',
				},
			];

			const configs = entrypointsToFlowConfigs(entrypoints);

			expect(configs).toHaveLength(2);
			expect(configs[0]).toEqual({
				name: 'post-api-login',
				entrypoint: 'src/routes.ts:handleLogin',
			});
			expect(configs[1]).toEqual({
				name: 'main-main',
				entrypoint: 'src/main.ts:main',
			});
		});

		it('generates filesystem-safe flow names', () => {
			const configs = entrypointsToFlowConfigs([{
				file: 'app.py',
				functionName: 'handle_submit',
				pattern: 'flask-route',
				description: 'POST /api/v2/submit',
			}]);

			expect(configs[0].name).toBe('post-api-v2-submit');
			// No special characters that would break file paths
			expect(configs[0].name).toMatch(/^[a-z0-9-]+$/);
		});
	});

	describe('Edge cases', () => {
		it('skips test files', async () => {
			const reader = createMemoryReader({
				'/workspace/src/auth.test.ts': `
export function main() { runTests(); }
app.get('/test', testHandler);
`,
			});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(0);
		});

		it('handles empty workspace', async () => {
			const reader = createMemoryReader({});

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(0);
		});

		it('handles unreadable files gracefully', async () => {
			const reader: FileReader = {
				async readFile(): Promise<string> {
					throw new Error('Permission denied');
				},
				async listFiles(): Promise<string[]> {
					return ['/workspace/src/server.ts'];
				},
			};

			const results = await detectEntrypoints(reader, root);

			expect(results).toHaveLength(0);
		});
	});
});
