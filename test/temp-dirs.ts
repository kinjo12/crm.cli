import { afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every temporary directory a test creates goes through `makeTempDir`, which
 * records it in a ledger. `useTempDirs()` (called once at the top of each test
 * file) registers an `afterAll` that removes everything in the ledger, and
 * throws, naming each path and why, if anything could not be removed.
 *
 * Do not register the `afterAll` at module scope here: Bun evaluates this
 * module once per run, so it would only fire for the first file that imports
 * it (measured, bun 1.4.0).
 *
 * If `CRM_TEST_LEDGER` is set, each created path is also appended to that
 * file, so a separate process (`scripts/check-test-temp.ts`) can check after
 * the run that nothing is left.
 */

const live = new Set<string>()
const closers: Array<() => void> = []
const lastError = new Map<string, string>()
const closeErrors: string[] = []

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  live.add(dir)
  const ledgerFile = process.env.CRM_TEST_LEDGER
  if (ledgerFile) {
    appendFileSync(ledgerFile, `${dir}\n`)
  }
  return dir
}

/** Paths created through `makeTempDir` and not yet removed. */
export function liveTempDirs(): string[] {
  return [...live]
}

/**
 * Register a database whose client must be closed before its directory can be
 * removed. On Windows an open libsql DB makes `rmSync` fail with EBUSY (bun
 * 1.4.0, one sample each): a DB that is still referenced stayed locked with no
 * action, and was released by `close()` plus a forced GC. A DB nobody refers to
 * was released by the GC on its own after about a second, so this is about
 * being quick and certain, not about the only way. The reference kept here is
 * dropped in `cleanupAll` before the GC runs.
 */
export function trackDb<T>(db: T): T {
  const client = (db as { $client?: { close?: () => void } }).$client
  // Fail here, not silently at cleanup, if the DB handle no longer exposes a
  // client to close (for example after a drizzle upgrade).
  if (typeof client?.close !== 'function') {
    throw new Error('trackDb: the DB handle has no $client.close()')
  }
  closers.push(() => client.close?.())
  return db
}

/** True only when the path is definitely absent (ENOENT), not on any error. */
function isGone(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function unlock(path: string): void {
  // Undo a deny ACL (Windows) or a read-only directory (POSIX) so the tree can
  // be deleted. Best effort: the caller retries the delete and reports failure.
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME
      if (user) {
        execFileSync('icacls', [path, '/remove:d', user, '/T', '/C'], {
          stdio: 'ignore',
        })
      }
    } else {
      execFileSync('chmod', ['-R', 'u+rwx', path], { stdio: 'ignore' })
    }
  } catch {
    // ignored on purpose; see above
  }
}

export interface RemoveOptions {
  /** Retries after the first try; the last one is not followed by a wait. */
  attempts?: number
  waitMs?: number
}

/** Remove `path`. Returns true when it no longer exists. Never throws. */
export async function removeTree(
  path: string,
  { attempts = 6, waitMs = 250 }: RemoveOptions = {},
): Promise<boolean> {
  for (let i = 0; i <= attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? String(e)
      lastError.set(path, code)
      if (code === 'EBUSY') {
        Bun.gc(true)
      } else {
        unlock(path)
      }
      if (i < attempts) {
        await Bun.sleep(waitMs)
      }
    }
    if (isGone(path)) {
      lastError.delete(path)
      return true
    }
  }
  return false
}

export interface CleanupOptions extends RemoveOptions {
  /** Replaceable so the failure path can be tested on every platform. */
  remove?: (path: string, options: RemoveOptions) => Promise<boolean>
}

/**
 * Close tracked DBs, then remove every ledger path. Paths that could not be
 * removed stay in the ledger and are all named, with the last error code, in
 * the thrown error.
 */
export async function cleanupAll({
  remove = removeTree,
  ...options
}: CleanupOptions = {}): Promise<void> {
  if (closers.length > 0) {
    for (const close of closers.splice(0)) {
      try {
        close()
      } catch (e) {
        // Often harmless (already closed); kept so a failure can be explained.
        closeErrors.push((e as Error).message)
      }
    }
    Bun.gc(true)
    await Bun.sleep(300)
    Bun.gc(true)
  }
  const failed: string[] = []
  for (const dir of [...live]) {
    if (await remove(dir, options)) {
      live.delete(dir)
    } else {
      failed.push(`${dir} (${lastError.get(dir) ?? 'still exists'})`)
    }
  }
  if (failed.length > 0) {
    const closeNote =
      closeErrors.length > 0
        ? `\nDB close errors: ${closeErrors.splice(0).join('; ')}`
        : ''
    throw new Error(
      `could not remove ${failed.length} temporary director${failed.length === 1 ? 'y' : 'ies'}:\n${failed.join('\n')}${closeNote}`,
    )
  }
  closeErrors.length = 0
}

/** Call once at the top of every test file that creates temporary dirs. */
export function useTempDirs(): void {
  afterAll(async () => {
    await cleanupAll()
  })
}
