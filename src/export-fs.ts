import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import type { CRMConfig } from './config'
import type { DB } from './db'
import * as schema from './drizzle-schema'
import { safeJSON } from './format'
import {
  activityFilename,
  buildActivityJSON,
  buildCompanyJSON,
  buildContactJSON,
  buildDealJSON,
  companyFilename,
  contactFilename,
  dealFilename,
  LLM_TXT,
  slugify,
} from './fuse-json'
import { safeJoin, sanitizeFilenameSegment } from './path-safety'
import {
  computeConversion,
  computeForecast,
  computeLost,
  computeStale,
  computeVelocity,
  computeWon,
} from './reports'

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export async function generateFS(
  db: DB,
  config: CRMConfig,
  outDir: string,
): Promise<void> {
  ensureDir(outDir)
  ensureDir(join(outDir, 'contacts'))
  ensureDir(join(outDir, 'contacts', '_by-email'))
  ensureDir(join(outDir, 'contacts', '_by-phone'))
  ensureDir(join(outDir, 'contacts', '_by-linkedin'))
  ensureDir(join(outDir, 'contacts', '_by-x'))
  ensureDir(join(outDir, 'contacts', '_by-bluesky'))
  ensureDir(join(outDir, 'contacts', '_by-telegram'))
  ensureDir(join(outDir, 'contacts', '_by-company'))
  ensureDir(join(outDir, 'contacts', '_by-tag'))

  ensureDir(join(outDir, 'companies'))
  ensureDir(join(outDir, 'companies', '_by-website'))
  ensureDir(join(outDir, 'companies', '_by-phone'))
  ensureDir(join(outDir, 'companies', '_by-tag'))

  ensureDir(join(outDir, 'deals'))
  ensureDir(join(outDir, 'deals', '_by-stage'))
  for (const stage of config.pipeline.stages) {
    ensureDir(join(outDir, 'deals', '_by-stage', stage))
  }
  ensureDir(join(outDir, 'deals', '_by-company'))
  ensureDir(join(outDir, 'deals', '_by-tag'))

  ensureDir(join(outDir, 'activities'))
  ensureDir(join(outDir, 'activities', '_by-contact'))
  ensureDir(join(outDir, 'activities', '_by-company'))
  ensureDir(join(outDir, 'activities', '_by-deal'))
  ensureDir(join(outDir, 'activities', '_by-type'))

  ensureDir(join(outDir, 'reports'))
  ensureDir(join(outDir, 'search'))

  // Write llm.txt — agent instructions for navigating the CRM filesystem
  writeFileSync(join(outDir, 'llm.txt'), LLM_TXT)

  // Pre-fetch companies for ID→name resolution
  const companies = await db.select().from(schema.companies)

  // Write contacts
  const contacts = await db.select().from(schema.contacts)
  for (const c of contacts) {
    const data = await buildContactJSON(db, c, config)
    const filename = contactFilename(c)
    const filePath = join(outDir, 'contacts', filename)
    writeJSON(filePath, data)

    const emails: string[] = safeJSON(c.emails)
    for (const email of emails) {
      const target = safeJoin(outDir, 'contacts', '_by-email', `${email}.json`)
      if (target) {
        copyFileSync(filePath, target)
      }
    }

    const phones: string[] = safeJSON(c.phones)
    for (const phone of phones) {
      const target = safeJoin(outDir, 'contacts', '_by-phone', `${phone}.json`)
      if (target) {
        copyFileSync(filePath, target)
      }
    }

    if (c.linkedin) {
      const target = safeJoin(
        outDir,
        'contacts',
        '_by-linkedin',
        `${c.linkedin}.json`,
      )
      if (target) {
        copyFileSync(filePath, target)
      }
    }
    if (c.x) {
      const target = safeJoin(outDir, 'contacts', '_by-x', `${c.x}.json`)
      if (target) {
        copyFileSync(filePath, target)
      }
    }
    if (c.bluesky) {
      const target = safeJoin(
        outDir,
        'contacts',
        '_by-bluesky',
        `${c.bluesky}.json`,
      )
      if (target) {
        copyFileSync(filePath, target)
      }
    }
    if (c.telegram) {
      const target = safeJoin(
        outDir,
        'contacts',
        '_by-telegram',
        `${c.telegram}.json`,
      )
      if (target) {
        copyFileSync(filePath, target)
      }
    }

    const companyIds: string[] = safeJSON(c.companies)
    for (const compId of companyIds) {
      const compRecord = companies.find((co) => co.id === compId)
      const compSlug = slugify(compRecord?.name || compId)
      ensureDir(join(outDir, 'contacts', '_by-company', compSlug))
      copyFileSync(
        filePath,
        join(outDir, 'contacts', '_by-company', compSlug, filename),
      )
    }

    const tags: string[] = safeJSON(c.tags)
    for (const tag of tags) {
      const tagDir = safeJoin(outDir, 'contacts', '_by-tag', tag)
      if (tagDir) {
        ensureDir(tagDir)
        copyFileSync(filePath, join(tagDir, filename))
      }
    }
  }

  // Write companies
  for (const co of companies) {
    const data = await buildCompanyJSON(db, co)
    const filename = companyFilename(co)
    const filePath = join(outDir, 'companies', filename)
    writeJSON(filePath, data)

    const websites: string[] = safeJSON(co.websites)
    for (const website of websites) {
      const target = safeJoin(
        outDir,
        'companies',
        '_by-website',
        `${website}.json`,
      )
      if (target) {
        copyFileSync(filePath, target)
      }
    }

    const phones: string[] = safeJSON(co.phones)
    for (const phone of phones) {
      const target = safeJoin(outDir, 'companies', '_by-phone', `${phone}.json`)
      if (target) {
        copyFileSync(filePath, target)
      }
    }

    const tags: string[] = safeJSON(co.tags)
    for (const tag of tags) {
      const tagDir = safeJoin(outDir, 'companies', '_by-tag', tag)
      if (tagDir) {
        ensureDir(tagDir)
        copyFileSync(filePath, join(tagDir, filename))
      }
    }
  }

  // Write deals
  const deals = await db.select().from(schema.deals)
  for (const d of deals) {
    const data = await buildDealJSON(db, d)
    const filename = dealFilename(d)
    const filePath = join(outDir, 'deals', filename)
    writeJSON(filePath, data)

    if (d.stage) {
      // `d.stage` is validated against config.pipeline.stages by `deal
      // add`/`update`, but `crm import deals` accepts any trimmed string
      // (src/commands/importexport.ts) without that check, so it must be
      // treated as untrusted here too.
      const stageDir = safeJoin(outDir, 'deals', '_by-stage', d.stage)
      if (stageDir) {
        ensureDir(stageDir)
        copyFileSync(filePath, join(stageDir, filename))
      }
    }

    if (d.company) {
      const companyResults = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, d.company))
      if (companyResults[0]) {
        const compSlug = slugify(companyResults[0].name || '')
        ensureDir(join(outDir, 'deals', '_by-company', compSlug))
        copyFileSync(
          filePath,
          join(outDir, 'deals', '_by-company', compSlug, filename),
        )
      }
    }

    const tags: string[] = safeJSON(d.tags)
    for (const tag of tags) {
      const tagDir = safeJoin(outDir, 'deals', '_by-tag', tag)
      if (tagDir) {
        ensureDir(tagDir)
        copyFileSync(filePath, join(tagDir, filename))
      }
    }
  }

  // Write activities
  const activities = await db.select().from(schema.activities)
  for (const a of activities) {
    const data = buildActivityJSON(a)
    const filename = activityFilename(a)
    const filePath = join(outDir, 'activities', filename)
    writeJSON(filePath, data)

    const actContacts: string[] = safeJSON(a.contacts)
    for (const contactId of actContacts) {
      const contactResults = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId))
      if (contactResults[0]) {
        // contactId is the linked contact's raw primary key (from
        // a.contacts), not a value this loop generates — sanitize it for the
        // same reason fuse-json.ts's filename builders do.
        const contactSlug = `${sanitizeFilenameSegment(contactId)}...${slugify(contactResults[0].name || '')}`
        const contactDir = safeJoin(
          outDir,
          'activities',
          '_by-contact',
          contactSlug,
        )
        if (contactDir) {
          ensureDir(contactDir)
          copyFileSync(filePath, join(contactDir, filename))
        }
      }
    }

    if (a.company) {
      const companyResults = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, a.company))
      if (companyResults[0]) {
        const compSlug = slugify(companyResults[0].name || '')
        ensureDir(join(outDir, 'activities', '_by-company', compSlug))
        copyFileSync(
          filePath,
          join(outDir, 'activities', '_by-company', compSlug, filename),
        )
      }
    }

    if (a.deal) {
      const dealDir = safeJoin(outDir, 'activities', '_by-deal', a.deal)
      if (dealDir) {
        ensureDir(dealDir)
        copyFileSync(filePath, join(dealDir, filename))
      }
    }

    if (a.type) {
      const typeDir = safeJoin(outDir, 'activities', '_by-type', a.type)
      if (typeDir) {
        ensureDir(typeDir)
        copyFileSync(filePath, join(typeDir, filename))
      }
    }
  }

  // Write pipeline.json
  const pipelineData = config.pipeline.stages.map((stage) => ({
    stage,
    count: deals.filter((d) => d.stage === stage).length,
    value: deals
      .filter((d) => d.stage === stage)
      .reduce((s, d) => s + (d.value || 0), 0),
  }))
  writeJSON(join(outDir, 'pipeline.json'), pipelineData)

  // Write tags.json
  const tagCounts: Record<string, number> = {}
  for (const c of contacts) {
    for (const t of safeJSON(c.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  for (const co of companies) {
    for (const t of safeJSON(co.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  for (const d of deals) {
    for (const t of safeJSON(d.tags) as string[]) {
      tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }
  const tagsData = Object.entries(tagCounts).map(([tag, count]) => ({
    tag,
    count,
  }))
  writeJSON(join(outDir, 'tags.json'), tagsData)

  // Write reports
  writeJSON(join(outDir, 'reports', 'pipeline.json'), pipelineData)
  writeJSON(
    join(outDir, 'reports', 'stale.json'),
    await computeStale(db, config),
  )
  writeJSON(
    join(outDir, 'reports', 'forecast.json'),
    await computeForecast(db, config),
  )
  writeJSON(
    join(outDir, 'reports', 'conversion.json'),
    await computeConversion(db, config.pipeline.stages),
  )
  writeJSON(
    join(outDir, 'reports', 'velocity.json'),
    await computeVelocity(db, config.pipeline.stages),
  )
  writeJSON(join(outDir, 'reports', 'won.json'), await computeWon(db, config))
  writeJSON(join(outDir, 'reports', 'lost.json'), await computeLost(db, config))
}
