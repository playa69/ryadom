import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The app code imports through the `@/` alias the tsconfig declares; the tests need it too. The
// tsconfig keeps JSX `preserve` for Next; the tests must compile it instead.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
})
