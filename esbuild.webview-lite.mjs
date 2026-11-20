// PROTOTYPE (lite request page): builds the small form bundle on its own, separate from the classic
// webview app, into dist/webview-lite/main.js and main.css.
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/webview-lite/main.tsx'],
  outdir: 'dist/webview-lite',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: !isWatch,
  sourcemap: isWatch,
  define: { 'process.env.NODE_ENV': JSON.stringify(isWatch ? 'development' : 'production') },
  logLevel: 'info'
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
