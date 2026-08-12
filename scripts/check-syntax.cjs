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


/**
 * A stray backtick inside a GLSL template literal silently truncates the shader
 * and turns into a confusing build error somewhere else in the file. It has cost
 * time twice on this project — once in a comment saying `soft`. Every shader
 * literal must contain a complete main(), so check for that directly.
 */
function checkShaderLiterals() {
  const srcDir = path.join(dir, '..', 'src')
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(d, e.name)
    return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
  let broken = 0
  for (const f of walk(srcDir)) {
    const text = fs.readFileSync(f, 'utf8')
    let at = 0
    for (;;) {
      const start = text.indexOf('#version 300 es', at)
      if (start < 0) break
      const end = text.indexOf('`', start)
      const body = end < 0 ? text.slice(start) : text.slice(start, end)
      if (!body.includes('void main()') || !body.includes('}')) {
        broken++
        process.stderr.write(
          `\nTRUNCATED SHADER in ${path.relative(process.cwd(), f)} near offset ${start}\n` +
            '  A backtick inside the template literal ended it early.\n'
        )
      }
      at = start + 1
    }
  }
  return broken
}

const dir = __dirname
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(dir, f))

const root = path.join(__dirname, '..')

/**
 * The verification scripts load the built app out of out/, not the sources. Editing a
 * component and running them without building tests the previous version and reports it
 * as passing — which has happened twice, both times producing a confident green result
 * for a fix that was not in the build. Comparing timestamps makes that impossible.
 */
function checkBuildIsCurrent() {
  const built = ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html']
    .map((f) => path.join(root, f))
  for (const f of built) {
    if (!fs.existsSync(f)) {
      process.stderr.write(`
No build at ${path.relative(root, f)} — run: npm run build
`)
      return 1
    }
  }
  const builtAt = Math.min(...built.map((f) => fs.statSync(f).mtimeMs))

  let newest = 0
  let newestFile = ''
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (/\.(ts|tsx|css|html|glsl)$/.test(e.name)) {
        const m = fs.statSync(f).mtimeMs
        if (m > newest) { newest = m; newestFile = f }
      }
    }
  }
  walk(path.join(root, 'src'))

  if (newest > builtAt) {
    const age = Math.round((newest - builtAt) / 1000)
    process.stderr.write(
      `
STALE BUILD — ${path.relative(root, newestFile)} is ${age}s newer than out/.
` +
      `Anything loading out/ is testing the previous version. Run: npm run build
`
    )
    return 1
  }
  return 0
}

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

bad += checkShaderLiterals()
bad += checkBuildIsCurrent()

if (bad > 0) {
  process.stderr.write(`\n${bad} problem(s) found across ${files.length} scripts and the shaders.\n`)
  process.exit(1)
}
process.stdout.write(`${files.length} scripts parse cleanly, shader literals intact\n`)
