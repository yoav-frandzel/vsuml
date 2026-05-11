import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: {
    'class-diagram': 'src/webview/class-diagram/main.tsx',
    'sequence-diagram': 'src/webview/sequence-diagram/main.tsx',
    'state-diagram': 'src/webview/state-diagram/main.tsx'
  },
  bundle: true,
  outdir: 'media',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"'
  }
};

if (watch) {
  const extCtx = await esbuild.context(extensionConfig);
  const webCtx = await esbuild.context(webviewConfig);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('esbuild watching extension + webviews...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig)
  ]);
}
