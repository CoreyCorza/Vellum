/**
 * Parse every script in this directory before any of them is handed to Electron.
 *
 * Why this exists: a syntax error in a script fails at MODULE LOAD, which is
 * before the script's own `dialog.showErrorBox` override and `uncaughtException`
 * handler are installed. Electron then puts up a native modal and waits forever.
 * From the outside that is indistinguishable from an infinite loop, and it has
 * eaten time twice on this project — once on verify-flow-opacity, once on
 * looks.cjs.
 *
 * A parse error should be one line in the terminal. Run this first and it is.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dir = __dirname
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(dir, f))

let bad = 0
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    bad++
    process.stderr.write(`\nSYNTAX ERROR in ${path.relative(process.cwd(), f)}\n`)
    process.stderr.write(String(e.stderr || e.message).trim() + '\n')
  }
}

if (bad > 0) {
  process.stderr.write(`\n${bad} of ${files.length} scripts failed to parse.\n`)
  process.exit(1)
}
process.stdout.write(`${files.length} scripts parse cleanly\n`)
