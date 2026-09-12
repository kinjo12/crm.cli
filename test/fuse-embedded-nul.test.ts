import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  canMount,
  cleanupStaleFuseMounts,
  createTestContext,
  type TestContext,
} from './helpers.ts'

/**
 * Regression coverage for Issue #21: `json_escape()` in fuse-helper.c used
 * to walk its input with `for (size_t i = 0; s[i]; i++)` -- i.e. it stopped
 * at the first NUL byte rather than at an explicit length. `crm_write`'s
 * kernel-supplied write buffer (`wb->data`) is arbitrary binary content that
 * can legitimately contain embedded NUL bytes anywhere before its logical
 * end at `wb->len` (only `wb->data[wb->len] = '\0'` is guaranteed, which
 * terminates *after* the logical end, not within it). So a write payload
 * containing an embedded NUL got silently truncated at that NUL when
 * escaped via `json_escape()` and forwarded to the daemon in
 * `build_write_request()` -- bytes after the first embedded NUL were
 * silently dropped rather than escaped and transmitted.
 *
 * This is a data-fidelity bug, not a memory-safety one, so it can't be
 * demonstrated with a crash or a literal round-trip through a successful
 * write: file writes through the mount are validated as JSON documents
 * against an entity schema, and per RFC 8259 a raw NUL byte can never
 * legally sit inside a valid JSON string in the first place (any conforming
 * parser -- including V8's `JSON.parse`, which the daemon uses -- rejects a
 * literal, unescaped control character inside a string). So instead we
 * exploit the bug's own truncation to build a payload that:
 *
 *   - as a whole (the bytes actually passed to `writeFileSync`) is a
 *     complete, valid contact JSON document, followed by a raw 0x00 byte,
 *     followed by non-whitespace "trailing garbage" -- which makes the
 *     entire payload invalid JSON (a JSON document may not have
 *     non-whitespace content after its closing brace), so the write must
 *     be rejected outright and must never create a contact.
 *   - but whose bytes preceding the embedded NUL happen to form a
 *     complete, valid document all on their own.
 *
 * On unpatched fuse-helper.c, `json_escape()`'s bare NUL-terminated loop
 * stops dead at the embedded NUL, so only the valid prefix -- which reads
 * as a legitimate, complete write -- ever reaches the daemon; the NUL and
 * the trailing garbage after it are silently dropped and the daemon never
 * learns they existed. The malformed write incorrectly *succeeds* and
 * silently creates a contact from data that should never have been
 * accepted. On fixed code, the full byte sequence -- NUL escaped as the
 * standard six-character backslash-u-0000 form, trailing garbage intact --
 * reaches the daemon, whose own `JSON.parse` of the (now provably
 * untruncated) content fails on the trailing garbage, and the write is
 * correctly rejected end-to-end with no contact ever created.
 *
 * These tests drive the real compiled `crm-fuse` C binary + `fuse-daemon.ts`
 * through a live FUSE mount (gated by `canMount`, same as test/fuse.test.ts
 * and test/fuse-json-injection.test.ts) rather than relying on static
 * analysis of fuse-helper.c.
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
  // Clean up stale FUSE mounts/processes left behind by a previously
  // interrupted test run — this file can't rely on any other test file's
  // module-level cleanup having already run, since Bun does not guarantee
  // cross-file test execution order.
  cleanupStaleFuseMounts()
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

describe('fuse: embedded-NUL write fidelity hardening', () => {
  test('a write payload containing an embedded NUL byte must not be silently truncated before the daemon sees it', () => {
    if (skipIfNoFuse()) {
      return
    }
    const mp = ctx!.mountPoint

    // Bytes actually passed to writeFileSync: a complete, valid contact
    // document, then a raw embedded NUL, then non-whitespace garbage. As a
    // whole this is invalid JSON and must be rejected end-to-end.
    const validPrefix = Buffer.from(
      JSON.stringify({ name: 'Trunc Test', emails: ['trunc@acme.com'] }),
    )
    const payload = Buffer.concat([
      validPrefix,
      Buffer.from([0x00]),
      Buffer.from('TRAILING-GARBAGE-AFTER-EMBEDDED-NUL'),
    ])

    let writeThrew = false
    try {
      writeFileSync(join(mp, 'contacts', 'trunc-nul-test.json'), payload)
    } catch {
      writeThrew = true
    }

    // Query through the CLI rather than re-stat'ing the mount: it talks to
    // the SQLite DB directly and isn't affected by FUSE attribute/dentry
    // caching (see the analogous note in fuse-json-injection.test.ts).
    const created = ctx!.run('contact', 'show', 'trunc@acme.com').exitCode === 0

    // Core regression assertions. On unpatched fuse-helper.c, json_escape()
    // silently truncates the outgoing "data" at the embedded NUL, so the
    // daemon only ever sees the valid prefix, accepts it, and a "Trunc
    // Test" contact gets created from a write that should have been
    // rejected in full — writeThrew is false and created is true. On fixed
    // code, the full payload (including the trailing garbage that proves
    // the NUL didn't truncate anything) reaches the daemon intact, its own
    // JSON.parse fails on the trailing garbage, and the write is rejected
    // outright with no contact ever created.
    expect(writeThrew).toBe(true)
    expect(created).toBe(false)
  })
})
