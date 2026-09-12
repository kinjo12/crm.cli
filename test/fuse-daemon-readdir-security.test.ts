import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDB } from '../src/db.ts'
import type { Company, Contact, Deal } from '../src/drizzle-schema.ts'
import * as schema from '../src/drizzle-schema.ts'
import { handleReaddir } from '../src/fuse-daemon.ts'
import {
  companyFilename,
  contactFilename,
  dealFilename,
  slugify,
} from '../src/fuse-json.ts'

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

const STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed-won',
  'closed-lost',
]

function freshDB() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-readdir-'))
  return openDB(join(dir, 'test.db'))
}

const EVIL_ID = '../../../pwned-id'
const now = new Date().toISOString()

describe('fuse-daemon: readdir filename sanitization', () => {
  test('contacts/ does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.contacts).values({
      id: EVIL_ID,
      name: 'Evil',
      emails: '[]',
      phones: '[]',
      companies: '[]',
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

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
    await db.insert(schema.companies).values({
      id: EVIL_ID,
      name: 'Evil Corp',
      websites: '[]',
      phones: '[]',
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

    const result = await handleReaddir(db, 'companies', STAGES)
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

  test('deals/ does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.deals).values({
      id: EVIL_ID,
      title: 'Evil Deal',
      stage: 'lead',
      contacts: '[]',
      company: null,
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

    const result = await handleReaddir(db, 'deals', STAGES)
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

  test('deals/_by-stage/<stage> does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.deals).values({
      id: EVIL_ID,
      title: 'Evil Deal',
      stage: 'lead',
      contacts: '[]',
      company: null,
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

    const result = await handleReaddir(db, 'deals/_by-stage/lead', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    // The filename format itself always contains a literal "..." separator
    // between id and slug — that's by design, not a vulnerability. What must
    // never appear is the raw malicious id (with its real ".." traversal
    // sequences and "/" separators) embedded verbatim.
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('contacts/_by-tag/<tag> does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.contacts).values({
      id: EVIL_ID,
      name: 'Evil',
      emails: '[]',
      phones: '[]',
      companies: '[]',
      tags: JSON.stringify(['vip']),
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

    const result = await handleReaddir(db, 'contacts/_by-tag/vip', STAGES)
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    // The filename format itself always contains a literal "..." separator
    // between id and slug — that's by design, not a vulnerability. What must
    // never appear is the raw malicious id (with its real ".." traversal
    // sequences and "/" separators) embedded verbatim.
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('contacts/_by-company/<slug> does not embed a raw traversal id in the filename', async () => {
    const db = await freshDB()
    await db.insert(schema.companies).values({
      id: 'co_normal',
      name: 'Acme Corp',
      websites: '[]',
      phones: '[]',
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.contacts).values({
      id: EVIL_ID,
      name: 'Evil',
      emails: '[]',
      phones: '[]',
      companies: JSON.stringify(['co_normal']),
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    })

    const result = await handleReaddir(
      db,
      `contacts/_by-company/${slugify('Acme Corp')}`,
      STAGES,
    )
    const entries = result.entries as string[]
    const evilEntry = entries[0]

    expect(evilEntry).toBeDefined()
    // The filename format itself always contains a literal "..." separator
    // between id and slug — that's by design, not a vulnerability. What must
    // never appear is the raw malicious id (with its real ".." traversal
    // sequences and "/" separators) embedded verbatim.
    expect(evilEntry).not.toContain(EVIL_ID)
    expect(evilEntry).not.toContain('/')
  })

  test('normal ids/names still produce byte-identical filenames to the shared helper', async () => {
    const db = await freshDB()
    const contact = {
      id: 'ct_normal',
      name: 'Jane Doe',
      emails: '[]',
      phones: '[]',
      companies: '[]',
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    }
    const company = {
      id: 'co_normal',
      name: 'Acme Corp',
      websites: '[]',
      phones: '[]',
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    }
    const deal = {
      id: 'dl_normal',
      title: 'Big Deal',
      stage: 'lead',
      contacts: '[]',
      company: null,
      tags: '[]',
      custom_fields: '{}',
      created_at: now,
      updated_at: now,
    }
    await db.insert(schema.contacts).values(contact)
    await db.insert(schema.companies).values(company)
    await db.insert(schema.deals).values(deal)

    const contactsResult = await handleReaddir(db, 'contacts', STAGES)
    expect(contactsResult.entries as string[]).toContain(
      contactFilename(contact as unknown as Contact),
    )

    const companiesResult = await handleReaddir(db, 'companies', STAGES)
    expect(companiesResult.entries as string[]).toContain(
      companyFilename(company as unknown as Company),
    )

    const dealsResult = await handleReaddir(db, 'deals', STAGES)
    expect(dealsResult.entries as string[]).toContain(
      dealFilename(deal as unknown as Deal),
    )
  })
})
