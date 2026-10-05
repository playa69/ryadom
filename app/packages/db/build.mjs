// Bundles the migration runner for the migrate image: one file with no node_modules, postgres and
// drizzle included.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli/migrate.ts'],
  outfile: 'dist/migrate.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'info',
  // CommonJS dependencies inside an ESM bundle call require, so give them a real one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})
