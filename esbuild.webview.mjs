import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
export const webviewBuildOptions = {
	entryPoints: ['src/webview/app.tsx'],
	bundle: true,
	outfile: 'dist/webview.js',
	platform: 'browser',
	format: 'esm',
	target: 'es2022',
	sourcemap: !isProd,
	minify: isProd,
	treeShaking: true,
	jsx: 'automatic',
	loader: {
		'.woff2': 'file',
		'.woff': 'file',
		'.svg': 'file',
		'.png': 'file',
	},
};

// Run standalone if invoked directly
if (process.argv[1]?.endsWith('esbuild.webview.mjs')) {
	if (isWatch) {
		const ctx = await esbuild.context(webviewBuildOptions);
		await ctx.watch();
		console.log('Watching webview for changes...');
	} else {
		await esbuild.build(webviewBuildOptions);
		console.log('Webview build complete.');
	}
}
