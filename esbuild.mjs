import * as esbuild from 'esbuild';
import { webviewBuildOptions } from './esbuild.webview.mjs';

const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const extensionBuildOptions = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode', 'web-tree-sitter', 'tree-sitter-wasms'],
	sourcemap: !isProd,
	minify: isProd,
	treeShaking: true,
};

if (isWatch) {
	const [extCtx, webCtx] = await Promise.all([
		esbuild.context(extensionBuildOptions),
		esbuild.context(webviewBuildOptions),
	]);
	await Promise.all([extCtx.watch(), webCtx.watch()]);
	console.log('Watching for changes...');
} else {
	await Promise.all([
		esbuild.build(extensionBuildOptions),
		esbuild.build(webviewBuildOptions),
	]);
	console.log('Build complete.');
}
