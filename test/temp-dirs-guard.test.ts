import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Keeps the temp-dir rules from #36 from eroding. It only reads source files;
 * it creates nothing and runs no other test.
 *
 * Scope: every `.ts` file under `test/` (including `test/scenarios/` and
 * `test/fuse-smoke/`) and `scripts/`. `smoke.ts` at the repo root also calls
 * the native temp-dir function, but it is a manual script outside these
 * folders and is deliberately not covered.
 *
 * Rules:
 *  1. Only `test/temp-dirs.ts` creates temp dirs natively (`mkdtemp`);
 *     everything else goes through `makeTempDir`.
 *  2. `icacls` is used only by the files in ICACLS_ALLOWED.
 *  3. A test file that calls the helpers has `useTempDirs()` at the start of a
 *     line (top level) or `await cleanupAll(`.
 *
 * It is a text match over a small tokenizer (comments are removed; for rule 3
 * string contents are blanked too), not a parse of the language. It catches a
 * forgotten call. Known gaps, on purpose: a helper imported under another
 * name, a wrapper that calls `makeTempDir` for you, a temp dir built from
 * `tmpdir()` by hand, tools other than `icacls`, regex literals containing
 * quotes, and `${}` expressions inside template literals.
 */

const ROOT = join(import.meta.dir, '..')
const SCAN_DIRS = ['test', 'scripts']

const NATIVE_TEMP = /\bmkdtemp(Sync)?\b/
const ICACLS = /\bicacls\b/i
const USES_HELPERS = /\b(createTestContext|makeTempDir|trackDb|freshDB)\s*\(/
const HAS_CLEANUP = /^useTempDirs\(\)|\bawait\s+cleanupAll\(/m
// File names Bun runs as tests.
const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$/

// Files that may create temp dirs natively.
const NATIVE_TEMP_ALLOWED = new Set(['test/temp-dirs.ts'])
// Files that may call `icacls` (a Windows deny-ACL fixture, or its removal).
const ICACLS_ALLOWED = new Set([
  'test/temp-dirs.ts',
  'test/temp-dirs.test.ts',
  'test/config.test.ts',
])
// This file talks about the rules, so it is not scanned for them.
const SELF = 'test/temp-dirs-guard.test.ts'

interface SourceFile {
  path: string
  text: string
}

interface Scanned {
  /** Comments removed and string/template contents blanked. */
  bare: string
  /** Comments removed, string contents kept. */
  code: string
}

const blank = (ch: string) => (ch === '\n' || ch === '\r' ? ch : ' ')

/** Walks the text once, tracking comments, strings and templates. */
function scan(text: string): Scanned {
  let code = ''
  let bare = ''
  let i = 0
  const keep = (s: string, inString: boolean) => {
    code += s
    bare += inString ? [...s].map(blank).join('') : s
  }
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++
      }
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (const c of text.slice(i, stop)) {
        code += blank(c)
        bare += blank(c)
      }
      i = stop
    } else if (ch === "'" || ch === '"' || ch === '`') {
      keep(ch, false)
      i++
      while (i < text.length && text[i] !== ch) {
        // A quote ends a '...' or "..." string at the end of the line.
        if (text[i] === '\n' && ch !== '`') {
          break
        }
        if (text[i] === '\\') {
          keep(text.slice(i, i + 2), true)
          i += 2
        } else {
          keep(text[i], true)
          i++
        }
      }
      if (i < text.length && text[i] === ch) {
        keep(ch, false)
        i++
      }
    } else {
      keep(ch, false)
      i++
    }
  }
  return { code, bare }
}

/** One entry per offence, shaped `path: what is wrong`. */
function findViolations(files: SourceFile[]): string[] {
  const found: string[] = []
  for (const { path, text } of files) {
    if (path === SELF) {
      continue
    }
    const { code, bare } = scan(text)
    if (NATIVE_TEMP.test(code) && !NATIVE_TEMP_ALLOWED.has(path)) {
      found.push(`${path}: creates a temp dir natively; use makeTempDir`)
    }
    if (ICACLS.test(code) && !ICACLS_ALLOWED.has(path)) {
      found.push(`${path}: calls icacls but is not in ICACLS_ALLOWED`)
    }
    if (
      TEST_FILE.test(path) &&
      USES_HELPERS.test(bare) &&
      !HAS_CLEANUP.test(bare)
    ) {
      found.push(
        `${path}: uses temp-dir helpers without useTempDirs()/await cleanupAll(`,
      )
    }
  }
  return found.sort()
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      return walk(full)
    }
    return full.endsWith('.ts') ? [full] : []
  })
}

function loadRepoFiles(): SourceFile[] {
  return SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))).map((full) => ({
    path: relative(ROOT, full).split('\\').join('/'),
    text: readFileSync(full, 'utf-8'),
  }))
}

describe('temp-dir rules (#36)', () => {
  test('the repo follows them', () => {
    const files = loadRepoFiles()
    // A scan that found nothing would pass vacuously.
    expect(files.some((f) => f.path === 'test/temp-dirs.ts')).toBe(true)
    expect(files.some((f) => f.path.startsWith('test/scenarios/'))).toBe(true)
    expect(files.some((f) => f.path.startsWith('scripts/'))).toBe(true)
    expect(findViolations(files)).toEqual([])
  })
})

describe('the scan itself', () => {
  const guarded = (path: string, text: string) =>
    findViolations([{ path, text }])
  const NO_CLEANUP =
    'test/scenarios/a.test.ts: uses temp-dir helpers without useTempDirs()/await cleanupAll('

  test('flags a native temp dir outside the helper', () => {
    const text = "import { mkdtempSync } from 'node:fs'\nmkdtempSync('x')\n"
    expect(guarded('test/a.test.ts', text)).toEqual([
      'test/a.test.ts: creates a temp dir natively; use makeTempDir',
    ])
    expect(guarded('test/temp-dirs.ts', text)).toEqual([])
  })

  test('flags icacls outside the allow-list, in any letter case', () => {
    const text = "execFileSync('icacls', [])\n"
    expect(guarded('test/a.test.ts', text)).toEqual([
      'test/a.test.ts: calls icacls but is not in ICACLS_ALLOWED',
    ])
    expect(guarded('test/a.test.ts', "run('ICACLS.EXE')\n")).toHaveLength(1)
    expect(guarded('test/config.test.ts', text)).toEqual([])
  })

  test('flags helper use without a cleanup call, in any folder', () => {
    const text = 'const ctx = createTestContext()\n'
    expect(guarded('test/scenarios/a.test.ts', text)).toEqual([NO_CLEANUP])
    expect(guarded('test/a.test.ts', `${text}useTempDirs()\n`)).toEqual([])
    expect(guarded('test/a.test.ts', `${text}await cleanupAll()\n`)).toEqual([])
    // Not a test file (a fixture module): exempt. Other test file names count.
    expect(guarded('test/fixtures.ts', text)).toEqual([])
    expect(guarded('test/a.spec.ts', text)).toHaveLength(1)
    expect(guarded('test/a_test.ts', text)).toHaveLength(1)
  })

  test('a call that is not at the top level does not count', () => {
    const text =
      "createTestContext()\ndescribe('x', () => {\n  useTempDirs()\n})\n"
    expect(guarded('test/scenarios/a.test.ts', text)).toEqual([NO_CLEANUP])
  })

  test('a comment neither triggers nor satisfies a rule', () => {
    const comments =
      '// mkdtempSync and icacls\n/* mkdtemp */\nfoo() // mkdtemp, icacls\n'
    expect(guarded('test/a.test.ts', comments)).toEqual([])
    const fake =
      'createTestContext() // await cleanupAll(\n// useTempDirs()\n/* await cleanupAll( */\n'
    expect(guarded('test/scenarios/a.test.ts', fake)).toEqual([NO_CLEANUP])
  })

  test('a string neither satisfies rule 3 nor hides code after it', () => {
    const inString = "createTestContext()\nconst s = 'await cleanupAll('\n"
    expect(guarded('test/scenarios/a.test.ts', inString)).toEqual([NO_CLEANUP])
    const inTemplate = 'createTestContext()\nconst s = `\nuseTempDirs()\n`\n'
    expect(guarded('test/scenarios/a.test.ts', inTemplate)).toEqual([
      NO_CLEANUP,
    ])
    // A `/*` inside a line comment or a string must not start a comment that
    // swallows the code up to some later `*/`.
    const tail = "mkdtempSync('x')\n/** doc */\n"
    expect(guarded('test/a.test.ts', `// see src/*.ts\n${tail}`)).toHaveLength(
      1,
    )
    expect(
      guarded('test/a.test.ts', `const g = 'src/*'\n${tail}`),
    ).toHaveLength(1)
  })

  test('lists each offender on its own line, sorted', () => {
    const v = findViolations([
      { path: 'test/b.test.ts', text: 'mkdtemp()\n' },
      { path: 'scripts/a.ts', text: 'mkdtempSync()\n' },
    ])
    expect(v).toEqual([
      'scripts/a.ts: creates a temp dir natively; use makeTempDir',
      'test/b.test.ts: creates a temp dir natively; use makeTempDir',
    ])
  })
})
