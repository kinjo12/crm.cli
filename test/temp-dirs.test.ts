import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { openDB } from '../src/db.ts'
import {
  cleanupAll,
  liveTempDirs,
  makeTempDir,
  removeTree,
  trackDb,
  useTempDirs,
} from './temp-dirs.ts'

// Safety net: anything a failing test leaves behind (including a deny ACL) is
// removed here, and the file fails if it cannot be.
useTempDirs()

const CHECK_SCRIPT = join(
  import.meta.dir,
  '..',
  'scripts',
  'check-test-temp.ts',
)
const onWindows = process.platform === 'win32'

describe('removeTree', () => {
  test('removes a directory tree', async () => {
    const dir = makeTempDir('crm-test-helper-plain-')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x')

    expect(await removeTree(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  test('a path that is already gone counts as removed', async () => {
    const dir = makeTempDir('crm-test-helper-gone-')
    expect(await removeTree(dir)).toBe(true)
    expect(await removeTree(dir)).toBe(true)
  })

  // Windows only: a deny ACE on a subdirectory, as left behind by the
  // read-only-directory test in config.test.ts when a run is cut short.
  test.skipIf(!onWindows)(
    'removes a tree that has a deny ACE on a subdirectory (Windows only)',
    async () => {
      const dir = makeTempDir('crm-test-helper-acl-')
      const project = join(dir, 'project')
      mkdirSync(project)
      execFileSync(
        'icacls',
        [project, '/deny', `${process.env.USERNAME}:(OI)(CI)W`],
        { stdio: 'ignore' },
      )
      // Precondition: the deny is really in force, otherwise this proves
      // nothing.
      expect(() => writeFileSync(join(project, 'x.txt'), 'x')).toThrow()

      expect(await removeTree(dir)).toBe(true)
      expect(existsSync(dir)).toBe(false)
    },
  )

  // POSIX only: a directory made read-only with chmod. Not run on Windows.
  // Skipped for root: root ignores 0o555, so the test could not fail there.
  test.skipIf(onWindows || process.getuid?.() === 0)(
    'removes a tree that contains a read-only directory (POSIX only, not root)',
    async () => {
      const dir = makeTempDir('crm-test-helper-ro-')
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      writeFileSync(join(locked, 'f.txt'), 'x')
      chmodSync(locked, 0o555)
      // Precondition: the directory really is locked.
      expect(() => writeFileSync(join(locked, 'y.txt'), 'y')).toThrow()

      expect(await removeTree(dir)).toBe(true)
      expect(existsSync(dir)).toBe(false)
    },
  )
})

describe('trackDb + cleanupAll', () => {
  test('a directory holding an open DB is removed after the DB is closed', async () => {
    const dir = makeTempDir('crm-test-helper-db-')
    // `db` stays referenced until the end of the test on purpose: a DB nobody
    // refers to any more is freed by the garbage collector within about a
    // second (measured), which would hide whether cleanupAll does its job.
    const db = trackDb(await openDB(join(dir, 'test.db')))

    await cleanupAll()

    expect(existsSync(dir)).toBe(false)
    expect(liveTempDirs()).not.toContain(dir)
    expect(typeof db).toBe('object')
  })
})

describe('cleanupAll failure reporting', () => {
  test('names every path it could not remove, and keeps only those', async () => {
    const stuck = makeTempDir('crm-test-helper-stuck-')
    const fine = makeTempDir('crm-test-helper-fine-')

    // A remover that cannot remove `stuck`, so the failure path is tested the
    // same way on every platform.
    const remove = async (path: string) => {
      if (path === stuck) {
        return false
      }
      return await removeTree(path)
    }
    let message = ''
    try {
      await cleanupAll({ remove })
    } catch (e) {
      message = (e as Error).message
    }

    expect(message).toContain(`${stuck} (still exists)`)
    expect(message).not.toContain(fine)
    expect(existsSync(fine)).toBe(false)
    expect(liveTempDirs()).toContain(stuck)
    expect(liveTempDirs()).not.toContain(fine)

    // Release it with the real remover so this test leaves nothing behind.
    await cleanupAll()
    expect(existsSync(stuck)).toBe(false)
  })
})

describe('ledger file', () => {
  test('CRM_TEST_LEDGER records every created path', () => {
    const holder = makeTempDir('crm-test-helper-ledgerdir-')
    const ledger = join(holder, 'ledger.txt')
    writeFileSync(ledger, '')
    const previous = process.env.CRM_TEST_LEDGER
    process.env.CRM_TEST_LEDGER = ledger
    let a = ''
    let b = ''
    try {
      a = makeTempDir('crm-test-helper-la-')
      b = makeTempDir('crm-test-helper-lb-')
      expect(readFileSync(ledger, 'utf-8').split('\n')).toEqual([a, b, ''])
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, 'CRM_TEST_LEDGER')
      } else {
        process.env.CRM_TEST_LEDGER = previous
        // Keep the real ledger complete: these two went to the temporary one.
        appendFileSync(previous, `${a}\n${b}\n`)
      }
    }
  })
})

describe('scripts/check-test-temp.ts', () => {
  function check(ledgerFile: string) {
    const proc = Bun.spawnSync([
      process.execPath,
      'run',
      CHECK_SCRIPT,
      ledgerFile,
    ])
    return {
      exitCode: proc.exitCode,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    }
  }

  test('exit 1 and the path is named when a ledger path still exists', () => {
    const dir = makeTempDir('crm-test-helper-check-')
    const gone = join(dir, 'does-not-exist')
    const ledger = join(dir, 'ledger.txt')
    writeFileSync(ledger, `${dir}\n${gone}\n`)

    const r = check(ledger)

    expect(r.exitCode).toBe(1)
    expect(r.out).toContain(`STILL EXISTS: ${dir}`)
    expect(r.out).not.toContain(`STILL EXISTS: ${gone}`)
    expect(r.out).toContain('ledger entries: 2, remaining: 1')
  })

  test('exit 0 when every ledger path is gone', () => {
    const dir = makeTempDir('crm-test-helper-check0-')
    const ledger = join(dir, 'ledger.txt')
    writeFileSync(ledger, `${join(dir, 'gone-1')}\n${join(dir, 'gone-2')}\n`)

    const r = check(ledger)

    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('ledger entries: 2, remaining: 0')
  })

  test('exit 2 (nothing checked) when the ledger cannot be read', () => {
    const dir = makeTempDir('crm-test-helper-check2-')
    const r = check(join(dir, 'no-such-ledger.txt'))

    expect(r.exitCode).toBe(2)
    expect(r.err).toContain('cannot read ledger')
  })
})
