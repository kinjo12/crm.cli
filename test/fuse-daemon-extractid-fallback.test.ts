import { describe, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import * as schema from '../src/drizzle-schema.ts'
import {
  handleGetattr,
  handleRead,
  handleReaddir,
  handleUnlink,
} from '../src/fuse-daemon.ts'
import { sanitizeFilenameSegment } from '../src/path-safety.ts'
import {
  EVIL_ID,
  freshDB,
  makeActivity,
  makeCompany,
  makeContact,
  makeDeal,
  STAGES,
  testConfig,
} from './fuse-daemon-fixtures.ts'

/**
 * Regression + fix coverage for Issue #18: `extractId()`-based lookups in
 * `fuse-daemon.ts` (`handleGetattr`, the `read*Path` helpers called from
 * `handleRead`, and `handleUnlink`) only tried an exact `eq(table.id, id)`
 * match against the *sanitized* id extracted from a listed filename. For a
 * record with an adversarial primary-key id (unreachable via this CLI's own
 * validated commands — only via `crm import` or direct DB manipulation, same
 * threat model as Issue #2/#9), that sanitized id never equals the raw id
 * stored in the DB, so the record listed correctly but 404d on
 * `stat`/`cat`/`rm` of that exact listed path.
 *
 * Each test below first lists the adversarial-id record via `handleReaddir`
 * (confirming the existing #9 sanitization fix is unaffected — the listed
 * filename must not contain the raw id), then feeds that exact listed
 * filename back into `handleGetattr`/`handleRead`/`handleUnlink` to confirm
 * the fallback full-table scan (added by this fix) resolves it. Before the
 * fix, every one of these assertions failed with `{ error: 'ENOENT' }`
 * (getattr/read) or found nothing to delete (unlink).
 *
 * `activities/` has no top-level `readdir` listing today (only its `_by-*`
 * sub-directories), so its tests build the listed filename the same way
 * `activityFilename()` does rather than reading it back from `handleReaddir`.
 */

const config = testConfig()

function sanitizedEvilId(): string {
  return sanitizeFilenameSegment(EVIL_ID)
}

const EVIL_ID_DATE = new Date().toISOString().slice(0, 10)

describe('fuse-daemon: extractId fallback for adversarial ids', () => {
  test('handleGetattr resolves a listed adversarial-id contact via the fallback scan', async () => {
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

    const result = await handleGetattr(
      db,
      config,
      `contacts/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    expect(result.type).toBe('file')
  })

  test('handleRead resolves a listed adversarial-id contact (direct file) via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.contacts)
      .values(makeContact({ id: EVIL_ID, name: 'Evil' }))

    const listing = await handleReaddir(db, 'contacts', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleRead(db, config, `contacts/${filename}`, STAGES)
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleRead resolves a listed adversarial-id contact via _by-tag/<tag>/<file> via the fallback scan', async () => {
    const db = await freshDB()
    await db.insert(schema.contacts).values(
      makeContact({
        id: EVIL_ID,
        name: 'Evil',
        tags: JSON.stringify(['vip']),
      }),
    )

    const listing = await handleReaddir(db, 'contacts/_by-tag/vip', STAGES)
    const filename = (listing.entries as string[])[0]
    expect(filename).toBeDefined()
    expect(filename).not.toContain(EVIL_ID)

    const result = await handleRead(
      db,
      config,
      `contacts/_by-tag/vip/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleRead resolves a listed adversarial-id contact via _by-company/<slug>/<file> via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: 'co_normal', name: 'Acme Corp' }))
    await db.insert(schema.contacts).values(
      makeContact({
        id: EVIL_ID,
        name: 'Evil',
        companies: JSON.stringify(['co_normal']),
      }),
    )

    const listing = await handleReaddir(
      db,
      'contacts/_by-company/acme-corp',
      STAGES,
    )
    const filename = (listing.entries as string[])[0]
    expect(filename).toBeDefined()

    const result = await handleRead(
      db,
      config,
      `contacts/_by-company/acme-corp/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleUnlink deletes a listed adversarial-id contact via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.contacts)
      .values(makeContact({ id: EVIL_ID, name: 'Evil' }))

    const listing = await handleReaddir(db, 'contacts', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleUnlink(db, `contacts/${filename}`)
    expect(result.ok).toBe(true)

    const remaining = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, EVIL_ID))
    expect(remaining.length).toBe(0)
  })

  test('handleGetattr resolves a listed adversarial-id company via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: EVIL_ID, name: 'Evil Corp' }))

    const listing = await handleReaddir(db, 'companies', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleGetattr(
      db,
      config,
      `companies/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    expect(result.type).toBe('file')
  })

  test('handleRead resolves a listed adversarial-id company via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: EVIL_ID, name: 'Evil Corp' }))

    const listing = await handleReaddir(db, 'companies', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleRead(db, config, `companies/${filename}`, STAGES)
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleUnlink deletes a listed adversarial-id company via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: EVIL_ID, name: 'Evil Corp' }))

    const listing = await handleReaddir(db, 'companies', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleUnlink(db, `companies/${filename}`)
    expect(result.ok).toBe(true)

    const remaining = await db.select().from(schema.companies)
    expect(remaining.find((c) => c.id === EVIL_ID)).toBeUndefined()
  })

  test('handleGetattr resolves a listed adversarial-id deal via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const listing = await handleReaddir(db, 'deals', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleGetattr(db, config, `deals/${filename}`, STAGES)
    expect(result.error).toBeUndefined()
    expect(result.type).toBe('file')
  })

  test('handleRead resolves a listed adversarial-id deal (direct file) via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const listing = await handleReaddir(db, 'deals', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleRead(db, config, `deals/${filename}`, STAGES)
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleRead resolves a listed adversarial-id deal via _by-stage/<stage>/<file> via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal', stage: 'lead' }))

    const listing = await handleReaddir(db, 'deals/_by-stage/lead', STAGES)
    const filename = (listing.entries as string[])[0]
    expect(filename).toBeDefined()

    const result = await handleRead(
      db,
      config,
      `deals/_by-stage/lead/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleUnlink deletes a listed adversarial-id deal via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const listing = await handleReaddir(db, 'deals', STAGES)
    const filename = (listing.entries as string[]).find((e) =>
      e.includes('evil'),
    )
    expect(filename).toBeDefined()

    const result = await handleUnlink(db, `deals/${filename}`)
    expect(result.ok).toBe(true)

    const remaining = await db.select().from(schema.deals)
    expect(remaining.find((d) => d.id === EVIL_ID)).toBeUndefined()
  })

  test('handleGetattr resolves a listed adversarial-id activity via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.activities)
      .values(makeActivity({ id: EVIL_ID, type: 'note', body: 'evil note' }))
    const filename = `${sanitizedEvilId()}...note-${EVIL_ID_DATE}.json`

    const result = await handleGetattr(
      db,
      config,
      `activities/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    expect(result.type).toBe('file')
  })

  test('handleRead resolves a listed adversarial-id activity via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.activities)
      .values(makeActivity({ id: EVIL_ID, type: 'note', body: 'evil note' }))
    const filename = `${sanitizedEvilId()}...note-${EVIL_ID_DATE}.json`

    const result = await handleRead(
      db,
      config,
      `activities/${filename}`,
      STAGES,
    )
    expect(result.error).toBeUndefined()
    const data = JSON.parse(result.data as string)
    expect(data.id).toBe(EVIL_ID)
  })

  test('handleUnlink deletes a listed adversarial-id activity via the fallback scan', async () => {
    const db = await freshDB()
    await db
      .insert(schema.activities)
      .values(makeActivity({ id: EVIL_ID, type: 'note', body: 'evil note' }))
    const filename = `${sanitizedEvilId()}...note-${EVIL_ID_DATE}.json`

    const result = await handleUnlink(db, `activities/${filename}`)
    expect(result.ok).toBe(true)

    const remaining = await db.select().from(schema.activities)
    expect(remaining.find((a) => a.id === EVIL_ID)).toBeUndefined()
  })
})
