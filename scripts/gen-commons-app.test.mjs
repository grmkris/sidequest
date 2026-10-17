import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

await test('the checked-in Commons App matches its renderer, styles and dependencies', () => {
  execFileSync('bun', [fileURLToPath(new URL('./gen-commons-app.mjs', import.meta.url)), '--check'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'pipe',
  })
})
