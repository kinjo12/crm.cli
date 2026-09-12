import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { canMount, createTestContext, type TestContext } from './helpers.ts'

/**
 * Regression coverage for the fuse-helper.c JSON injection vulnerability:
 * `crm_getattr`/`crm_readdir`/`crm_read`/`crm_write`/`crm_flush`/`crm_unlink`
 * interpolated the raw, unescaped FUSE `path` argument into a hand-rolled
 * JSON request string sent to the daemon. Since FUSE passes through any byte
 * except NUL and `/` as a path component, a path segment containing a
 * literal `"` lets an attacker break out of the `"path":"..."` string and
 * inject sibling JSON keys — e.g. turning a harmless `getattr` (triggered by
 * a mere `stat()`/`existsSync()`) into an `unlink` of a real, pre-existing
 * file, because `JSON.parse` keeps the *last* occurrence of a duplicate key.
 *
 * These tests drive the real compiled `crm-fuse` C binary + `fuse-daemon.ts`
 * through a live FUSE mount (gated by `canMount`, same as test/fuse.test.ts)
 * rather than relying on static analysis of fuse-helper.c.
 */

interface FuseTestContext extends TestContext {
  mounted: boolean
  mountPoint: string
}

let ctx: FuseTestContext | null = null

function unmount() {
  if (ctx?.mounted) {
    ctx.run('unmount', ctx.mountPoint)
    ctx.mounted = false
  }
}

beforeAll(() => {
  if (!canMount) {
    return
  }
  const c = createTestContext() as FuseTestContext
  c.mountPoint = join(c.dir, 'mnt')
  mkdirSync(c.mountPoint)
  c.runOK('contact', 'list')
  const result = c.run('mount', c.mountPoint)
  if (result.exitCode !== 0) {
    c.mounted = false
    ctx = c
    return
  }
  const deadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      if (readdirSync(c.mountPoint).includes('contacts')) {
        ready = true
        break
      }
    } catch {
      /* not mounted yet */
    }
    Bun.sleepSync(50)
  }
  c.mounted = ready
  ctx = c
})

afterAll(() => {
  unmount()
})

function skipIfNoFuse(): boolean {
  if (!ctx?.mounted) {
    console.warn('mount not available — skipping test')
    return true
  }
  return false
}

/** Helper: list only entity .json files (excludes _by-* dirs) */
function entityFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_'),
  )
}

describe('fuse: JSON/protocol injection hardening', () => {
  test('getattr on a quote-injected path must not smuggle an unlink of a real file', () => {
    if (skipIfNoFuse()) {
      return
    }
    const mp = ctx!.mountPoint

    // 1. Create a real victim contact via the CLI.
    ctx!.runOK(
      'contact',
      'add',
      '--name',
      'Injection Victim',
      '--email',
      'injection-victim@acme.com',
    )

    const victimFile = entityFiles(join(mp, 'contacts')).find((f) =>
      f.includes('injection-victim'),
    )
    expect(victimFile).toBeDefined()

    const victimPath = join(mp, 'contacts', victimFile!)
    expect(existsSync(victimPath)).toBe(true)

    // 2. Sanity-check the victim exists from the DB's point of view too.
    // The FUSE kernel attribute/dentry cache means re-stat'ing the same
    // clean victim path through the mount right after the exploit can
    // return a stale cached "it still exists" result even if the backing
    // DB row was actually deleted. Query through the CLI instead — it
    // talks to the SQLite DB directly and is unaffected by FUSE caching.
    function victimExistsInDB(): boolean {
      return (
        ctx!.run('contact', 'show', 'injection-victim@acme.com').exitCode === 0
      )
    }
    expect(victimExistsInDB()).toBe(true)

    // 3. Craft a path segment that, once naively interpolated into
    // fuse-helper.c's `{"op":"getattr","path":"%s"}` template, closes the
    // "path" string early and injects a sibling `"op":"unlink"` key —
    // while leaving the (real, correct) "path" value untouched so the
    // smuggled unlink targets the real victim file:
    //
    //   {"op":"getattr","path":"/contacts/<victimFile>","op":"unlink"}
    //
    // JSON.parse keeps the last "op" (unlink) and the only "path" (the
    // real victim), so this must not be reachable via a bare stat().
    const maliciousComponent = `${victimFile}","op":"unlink`
    const maliciousPath = join(mp, 'contacts', maliciousComponent)

    // 4. A mere stat() on the crafted path is the trigger. Its own outcome
    // (success vs. ENOENT) differs between vulnerable and fixed code, so we
    // don't assert on it directly here — the real assertion is below: the
    // untouched victim file must survive regardless.
    let statThrew = false
    let statErrorCode: string | undefined
    try {
      statSync(maliciousPath)
    } catch (err) {
      statThrew = true
      statErrorCode = (err as NodeJS.ErrnoException).code
    }

    // 5. Core regression assertion: the real victim contact must still
    // exist in the DB. On unpatched fuse-helper.c, the crafted stat() above
    // smuggles an unlink of the victim and this assertion fails (proving
    // the vulnerability). After the fix, `path` is fully escaped, the
    // crafted component can never terminate the JSON "path" string early,
    // and the victim survives untouched.
    expect(victimExistsInDB()).toBe(true)

    // 6. On fixed code, the crafted (garbage, escaped) filename doesn't
    // correspond to any real entity, so stat() should fail cleanly with
    // ENOENT rather than succeeding or crashing.
    expect(statThrew).toBe(true)
    expect(statErrorCode).toBe('ENOENT')
  })
})
