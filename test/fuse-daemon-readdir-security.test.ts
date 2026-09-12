import { describe, expect, test } from 'bun:test'

import * as schema from '../src/drizzle-schema.ts'
import { handleReaddir } from '../src/fuse-daemon.ts'
import {
  companyFilename,
  contactFilename,
  dealFilename,
  slugify,
} from '../src/fuse-json.ts'
import {
  EVIL_ID,
  freshDB,
  makeCompany,
  makeContact,
  makeDeal,
  STAGES,
} from './fuse-daemon-fixtures.ts'

/**
 * Regression coverage for `fuse-daemon.ts`'s `readdir` handler independently
 * reimplementing the `${id}...${slugify(name)}.json` filename pattern inline
 * at 6 call sites, using the raw, unsanitized primary-key `id` directly
 * instead of the sanitizing `contactFilename`/`companyFilename`/
 * `dealFilename` helpers from `fuse-json.ts` (fixed for `export-fs.ts` in
 * PR #8 / Issue #2). A traversal payload smuggled into a primary-key `id`
 * (via direct DB manipulation, a future API, or a compromised import format)
 * would otherwise flow verbatim into the FUSE directory listing.
 *
 * These tests drive `handleReaddir` directly against a real DB — the
 * lightest-weight way to exercise the vulnerable code path without a live
 * FUSE mount (ids are always generated internally via `makeId()` today, so
 * this isn't reachable via the CLI's own commands; this is defense-in-depth
 * against the same untrusted-input threat model as PR #8).
 */

describe('fuse-daemon: readdir filename sanitization', () => {
  test('contacts/ does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db
      .insert(schema.contacts)
      .values(makeContact({ id: EVIL_ID, name: 'Evil' }))

    const result = await handleReaddir(db, 'contacts', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries.find(
      // Match on the slug rather than excluding an underscore prefix — the
      // sanitized evil id itself now legitimately starts with "_", which
      // would otherwise be confused with the "_by-*" lookup-dir entries.
      (e) => e.endsWith('.json') && e.includes('evil'),
    )

    expect(evilEntry).toBeDefined()
    // The filename format itself always contains a literal "..." separator
    // between id and slug — that's by design, not a vulnerability. What must
    // never appear is the raw malicious id (with its real ".." traversal
    // sequences and "/" separators) embedded verbatim.
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('companies/ does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: EVIL_ID, name: 'Evil Corp' }))

    const result = await handleReaddir(db, 'companies', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries.find(
      (e) => e.endsWith('.json') && e.includes('evil'),
    )

    expect(evilEntry).toBeDefined()
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('deals/ does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const result = await handleReaddir(db, 'deals', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries.find(
      (e) => e.endsWith('.json') && e.includes('evil'),
    )

    expect(evilEntry).toBeDefined()
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('deals/_by-stage/<stage> does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db
      .insert(schema.deals)
      .values(makeDeal({ id: EVIL_ID, title: 'Evil Deal' }))

    const result = await handleReaddir(db, 'deals/_by-stage/lead', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('deals/_by-stage/<stage> produces a byte-identical filename to the shared helper for a normal id', async () => {
    const db = await freshDB()
    const deal = makeDeal({ id: 'dl_normal', title: 'Big Deal', stage: 'lead' })
    await db.insert(schema.deals).values(deal)

    const result = await handleReaddir(db, 'deals/_by-stage/lead', STAGES)
    const entries = result.entries as string[]

    expect(entries).toContain(dealFilename(deal))
  })

  test('contacts/_by-tag/<tag> does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.contacts).values(
      makeContact({
        id: EVIL_ID,
        name: 'Evil',
        tags: JSON.stringify(['vip']),
      }),
    )

    const result = await handleReaddir(db, 'contacts/_by-tag/vip', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('contacts/_by-tag/<tag> produces a byte-identical filename to the shared helper for a normal id', async () => {
    const db = await freshDB()
    const contact = makeContact({
      id: 'ct_normal',
      name: 'Jane Doe',
      tags: JSON.stringify(['vip']),
    })
    await db.insert(schema.contacts).values(contact)

    const result = await handleReaddir(db, 'contacts/_by-tag/vip', STAGES)
    const entries = result.entries as string[]

    expect(entries).toContain(contactFilename(contact))
  })

  test('contacts/_by-company/<slug> does not embed a raw traversal id in the filename', async () => {
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

    const result = await handleReaddir(
      db,
      `contacts/_by-company/${slugify('Acme Corp')}`,
      STAGES,
    )
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('contacts/_by-company/<slug> produces a byte-identical filename to the shared helper for a normal id', async () => {
    const db = await freshDB()
    await db
      .insert(schema.companies)
      .values(makeCompany({ id: 'co_normal', name: 'Acme Corp' }))
    const contact = makeContact({
      id: 'ct_normal',
      name: 'Jane Doe',
      companies: JSON.stringify(['co_normal']),
    })
    await db.insert(schema.contacts).values(contact)

    const result = await handleReaddir(
      db,
      `contacts/_by-company/${slugify('Acme Corp')}`,
      STAGES,
    )
    const entries = result.entries as string[]

    expect(entries).toContain(contactFilename(contact))
  })

  test('normal ids/names still produce byte-identical filenames to the shared helper', async () => {
    const db = await freshDB()
    const contact = makeContact({ id: 'ct_normal', name: 'Jane Doe' })
    const company = makeCompany({ id: 'co_normal', name: 'Acme Corp' })
    const deal = makeDeal({ id: 'dl_normal', title: 'Big Deal' })
    await db.insert(schema.contacts).values(contact)
    await db.insert(schema.companies).values(company)
    await db.insert(schema.deals).values(deal)

    const contactsResult = await handleReaddir(db, 'contacts', STAGES)
    expect(contactsResult.entries as string[]).toContain(
      contactFilename(contact),
    )

    const companiesResult = await handleReaddir(db, 'companies', STAGES)
    expect(companiesResult.entries as string[]).toContain(
      companyFilename(company),
    )

    const dealsResult = await handleReaddir(db, 'deals', STAGES)
    expect(dealsResult.entries as string[]).toContain(dealFilename(deal))
  })
})
