/**
 * Headless-ish smoke test: boots the real Electron shell, waits for the
 * renderer, and asserts the things that break silently — preload bridge
 * present, React mounted, engine wired, no console errors.
 *
 *   node scripts/smoke.cjs
 *
 * Run after `npm run build`. Exits non-zero on failure so it can gate a commit.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const root = path.join(__dirname, '..')

const child = spawn(electron, [path.join(root, 'scripts', 'smoke-main.cjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
})

let out = ''
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => (out += d.toString()))

const timer = setTimeout(() => {
  console.error('TIMEOUT — app did not report within 30s\n' + out)
  child.kill()
  process.exit(1)
}, 30000)

child.on('exit', (code) => {
  clearTimeout(timer)
  process.stdout.write(out)
  const ok = out.includes('SMOKE_RESULT') && !out.includes('"failed":true')
  process.exit(ok && code === 0 ? 0 : 1)
})
