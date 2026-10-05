#!/usr/bin/env node
/**
 * Bundle of the API: src/index.ts becomes dist/index.js.
 *
 * Everything goes into the bundle, including @ryadom/core and @ryadom/db, because the internal
 * packages are not built themselves and their `exports` point at src. Only native modules stay
 * outside: their platform binary is installed in the runtime image from the versions in
 * dist/package.json, which this script writes.
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist')

/** Native dependencies: not bundled, installed in the runtime image (see the Dockerfile). */
const EXTERNAL = ['@node-rs/argon2']

/** The installed version of a package: resolved from the core, whose dependency it is, then from here. */
async function installedVersion(name) {
  const origins = [join(root, '..', '..', 'packages', 'core', 'package.json'), join(root, 'package.json')]
  for (const origin of origins) {
    try {
      const require = createRequire(origin)
      let dir = dirname(require.resolve(name))
      // Walk up from the entry file to the package's own package.json.
      while (!existsSync(join(dir, 'package.json')) || JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name !== name) {
        const parent = dirname(dir)
        if (parent === dir) throw new Error('not found')
        dir = parent
      }
      return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version
    } catch {
      // try the next origin
    }
  }
  throw new Error(`Cannot resolve the installed version of ${name}`)
}

await rm(outDir, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  external: EXTERNAL,
  // One set of TypeScript options for the whole bundle, core files included:
  // - experimentalDecorators, because the core is written with legacy decorators (mediatr) and
  //   esbuild must compile them the same way tsc does;
  // - jsx, because the core's email templates are React.
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      jsx: 'react-jsx',
    },
  },
  // CommonJS dependencies inside an ESM bundle call require, so give them a real one.
  banner: {
    js: "import { createRequire as __ryadomCreateRequire } from 'node:module';\nconst require = __ryadomCreateRequire(import.meta.url);",
  },
})

const dependencies = {}
for (const name of EXTERNAL) dependencies[name] = await installedVersion(name)

await writeFile(
  join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'ryadom-api', private: true, type: 'module', dependencies }, null, 2)}\n`,
)

console.log(`api: dist/index.js, external: ${JSON.stringify(dependencies)}`)
