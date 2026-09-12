import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CRMConfig } from '../src/config.ts'
import { openDB } from '../src/db.ts'
import * as schema from '../src/drizzle-schema.ts'
import { generateFS } from '../src/export-fs.ts'
import { safeJoin, sanitizeFilenameSegment } from '../src/path-safety.ts'
import { createTestContext } from './helpers.ts'

function testConfig(): CRMConfig {
  return {
    database: { path: '' },
    defaults: { format: 'table' },
    hooks: {},
    mount: {
      default_path: '',
      readonly: false,
      allow_other: false,
      max_recent_activity: 10,
      search_limit: 20,
    },
    phone: { display: 'international' },
    pipeline: {
      stages: [
        'lead',
        'qualified',
        'proposal',
        'negotiation',
        'closed-won',
        'closed-lost',
      ],
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
  }
}

/** Recursively collect every file path under `dir`. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(p))
    } else {
      out.push(p)
    }
  }
  return out
}

describe('path-safety: sanitizeFilenameSegment', () => {
  test('passes through normal filename-safe values unchanged', () => {
    expect(sanitizeFilenameSegment('jane@acme.com')).toBe('jane@acme.com')
    expect(sanitizeFilenameSegment('+12125551234')).toBe('+12125551234')
    expect(sanitizeFilenameSegment('acme.com')).toBe('acme.com')
    expect(sanitizeFilenameSegment('vip')).toBe('vip')
    expect(sanitizeFilenameSegment('jane-doe_99')).toBe('jane-doe_99')
  })

  test('neutralizes path separators', () => {
    expect(sanitizeFilenameSegment('a/b')).not.toContain('/')
    expect(sanitizeFilenameSegment('a\\b')).not.toContain('\\')
  })

  test('neutralizes the literal ".." sequence', () => {
    const result = sanitizeFilenameSegment('../../../etc/passwd')
    expect(result).not.toContain('..')
    expect(result).not.toContain('/')
  })

  test('strips NUL bytes and control characters', () => {
    const withNul = `evil${String.fromCharCode(0)}name`
    expect(sanitizeFilenameSegment(withNul)).not.toContain(
      String.fromCharCode(0),
    )
  })

  test('strips characters invalid in Windows filenames', () => {
    const result = sanitizeFilenameSegment('a<b>c:d"e|f?g*h')
    for (const ch of ['<', '>', ':', '"', '|', '?', '*']) {
      expect(result).not.toContain(ch)
    }
  })

  test('falls back to a safe placeholder when sanitization empties the value', () => {
    expect(sanitizeFilenameSegment('???')).toBe('unknown')
    expect(sanitizeFilenameSegment('')).toBe('unknown')
  })
})

describe('path-safety: safeJoin', () => {
  test('returns a path inside base for a well-formed segment', () => {
    const base = join('tmp-base', 'out')
    const result = safeJoin(base, 'contacts', '_by-email', 'jane@acme.com.json')
    expect(result).not.toBeNull()
    expect(result).toContain('jane@acme.com.json')
  })

  test('never escapes base even for a raw traversal segment', () => {
    const base = join('tmp-base', 'out')
    const result = safeJoin(base, '../../../etc/passwd')
    expect(result).not.toBeNull()
    expect((result as string).startsWith(join(base))).toBe(true)
  })
})

describe('export-fs: path traversal hardening', () => {
  test('contact with traversal payloads in email/tag/linkedin does not escape outDir', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Evil',
      '--email',
      '../../../pwned-email@evil.com',
      '--tag',
      '../../../pwned-tag',
      '--linkedin',
      '../../../pwned-linkedin',
    )
    ctx.runOK('export-fs', outDir)

    // Nothing escaped one level above outDir (into the test's own tmp dir).
    expect(existsSync(join(ctx.dir, 'pwned-email@evil.com.json'))).toBe(false)
    expect(existsSync(join(ctx.dir, 'pwned-tag'))).toBe(false)
    expect(existsSync(join(ctx.dir, 'pwned-linkedin.json'))).toBe(false)

    // Every file actually written stays confined under outDir.
    for (const f of walk(outDir)) {
      expect(f.startsWith(outDir)).toBe(true)
    }
  })

  test('normal email/tag/linkedin values still produce the documented lookup filenames', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Jane',
      '--email',
      'jane@acme.com',
      '--tag',
      'vip',
      '--linkedin',
      'janedoe',
    )
    ctx.runOK('export-fs', outDir)

    expect(
      existsSync(join(outDir, 'contacts', '_by-email', 'jane@acme.com.json')),
    ).toBe(true)
    expect(existsSync(join(outDir, 'contacts', '_by-tag', 'vip'))).toBe(true)
    expect(
      existsSync(join(outDir, 'contacts', '_by-linkedin', 'janedoe.json')),
    ).toBe(true)
  })

  test('company phone traversal payload (via import, bypassing strict CLI phone parsing) does not escape outDir', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    const jsonPath = join(ctx.dir, 'companies.json')
    writeFileSync(
      jsonPath,
      JSON.stringify([{ name: 'Evil Corp', phone: '../../../pwned-phone' }]),
    )
    ctx.runOK('import', 'companies', jsonPath)
    ctx.runOK('export-fs', outDir)

    expect(existsSync(join(ctx.dir, 'pwned-phone.json'))).toBe(false)
    for (const f of walk(outDir)) {
      expect(f.startsWith(outDir)).toBe(true)
    }
  })

  test('normal company phone value still produces the documented lookup filename', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    const jsonPath = join(ctx.dir, 'companies.json')
    writeFileSync(
      jsonPath,
      JSON.stringify([{ name: 'Acme Corp', phone: '+12125551234' }]),
    )
    ctx.runOK('import', 'companies', jsonPath)
    ctx.runOK('export-fs', outDir)

    expect(
      existsSync(join(outDir, 'companies', '_by-phone', '+12125551234.json')),
    ).toBe(true)
  })

  test('company tag traversal payload does not escape outDir', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'company',
      'add',
      '--name',
      'Evil Co',
      '--tag',
      '../../../pwned-co-tag',
    )
    ctx.runOK('export-fs', outDir)
    expect(existsSync(join(ctx.dir, 'pwned-co-tag'))).toBe(false)
  })

  test('deal tag traversal payload does not escape outDir', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Evil Deal',
      '--tag',
      '../../../pwned-deal-tag',
    )
    ctx.runOK('export-fs', outDir)
    expect(existsSync(join(ctx.dir, 'pwned-deal-tag'))).toBe(false)
  })

  test('activity with traversal payloads in type/deal (bypassing CLI validation) does not escape outDir', async () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    const dbPath = join(ctx.dir, 'direct.db')
    const db = await openDB(dbPath)
    const now = new Date().toISOString()
    await db.insert(schema.activities).values({
      id: 'act_evil',
      type: '../../../pwned-type',
      body: 'evil',
      contacts: '[]',
      company: null,
      deal: '../../../pwned-deal',
      custom_fields: '{}',
      created_at: now,
    })

    await generateFS(db, testConfig(), outDir)

    expect(existsSync(join(ctx.dir, 'pwned-type'))).toBe(false)
    expect(existsSync(join(ctx.dir, 'pwned-deal'))).toBe(false)
    for (const f of walk(outDir)) {
      expect(f.startsWith(outDir)).toBe(true)
    }
  })

  test('tag that sanitizes to empty falls back to a safe name instead of crashing', () => {
    const ctx = createTestContext()
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('contact', 'add', '--name', 'Weird', '--tag', '???')
    const result = ctx.run('export-fs', outDir)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(outDir, 'contacts', '_by-tag', 'unknown'))).toBe(
      true,
    )
  })
})
