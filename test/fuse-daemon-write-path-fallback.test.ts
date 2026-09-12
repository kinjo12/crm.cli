import { describe, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import * as schema from '../src/drizzle-schema.ts'
import { handleReaddir, handleWrite } from '../src/fuse-daemon.ts'
import {
  EVIL_ID,
  freshDB,
  makeCompany,
  makeContact,
  makeDeal,
  STAGES,
  testConfig,
} from './fuse-daemon-fixtures.ts'

/**
 * Regression + fix coverage for Issue #18 follow-up item 1a:
 * `writeContact`/`writeCompany`/`writeDeal` in `fuse-daemon.ts` still did a
 * plain `eq(table.id, id)` lookup (no fallback scan) in their update branch,
 * where `id` is the *sanitized* id extracted from a listed filename. For a
 * record with an adversarial primary-key id (unreachable via this CLI's own
 * validated commands — only via `crm import` or direct DB manipulation, same
 * threat model as Issue #2/#9), that meant the record listed correctly but
 * 404d on an update-by-listed-path.
 *
 * Each test below lists the adversarial-id record via `handleReaddir` (to get
 * the real, sanitized listed filename — confirming PR #17's sanitization fix
 * is unaffected: the filename must not contain the raw id), then writes to
 * that exact listed path via `handleWrite` and asserts two things:
 *
 *   1. The write reports `{ ok: true }` (fails before the fix — plain lookup
 *      404s with `{ error: 'ENOENT' }`).
 *   2. The update was actually *persisted* — re-queried directly by the real
 *      DB id (`EVIL_ID`), the field's new value must be present.
 *
 * Assertion 2 is the one that matters most: it's what would catch a
 * half-fixed version where the lookup uses the fallback-aware helper but the
 * `.update(...).where(eq(table.id, id))` clause still uses the raw sanitized
 * `id` instead of the resolved `existing.id`. That half-fix would find the
 * record, report `{ ok: true }`, but silently update zero rows — a
 * false-success data-loss bug, strictly worse than the current fail-safe
 * 404. A test that only checks assertion 1 would not catch that.
 */

const config = testConfig()

describe('fuse-daemon: write-path extractId fallback for adversarial ids', () => {
  test('handleWrite updates a listed adversarial-id contact via the fallback scan, and persists it', async () => {
    const db = await freshDB()
    await db
      .insert(schema.contacts)
      .values(makeContact({ id: EVIL_ID, name: 'Evil' }))

    const listing = await handleReaddir(db, 'contacts', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()
    expect(filename).not.toContain(EVIL_ID)

    const result = await handleWrite(
      db,
      config,
      `contacts/${filename}`,
      JSON.stringify({ name: 'Updated Evil' }),
    )
    expect(result.ok).toBe(true)

    const persisted = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, EVIL_ID))
    expect(persisted[0]?.name).toBe('Updated Evil')
  })

  test('handleWrite updates a listed adversarial-id company via the fallback scan, and persists it', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: EVIL_ID, name: 'Evil Corp' }))

    const listing = await handleReaddir(db, 'companies', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()
    expect(filename).not.toContain(EVIL_ID)

    const result = await handleWrite(
      db,
      config,
      `companies/${filename}`,
      JSON.stringify({ name: 'Updated Evil Corp' }),
    )
    expect(result.ok).toBe(true)

    const persisted = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, EVIL_ID))
    expect(persisted[0]?.name).toBe('Updated Evil Corp')
  })

  test('handleWrite updates a listed adversarial-id deal via the fallback scan, and persists it', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const listing = await handleReaddir(db, 'deals', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()
    expect(filename).not.toContain(EVIL_ID)

    const result = await handleWrite(
      db,
      config,
      `deals/${filename}`,
      JSON.stringify({ title: 'Updated Evil Deal' }),
    )
    expect(result.ok).toBe(true)

    const persisted = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, EVIL_ID))
    expect(persisted[0]?.title).toBe('Updated Evil Deal')
  })
})
