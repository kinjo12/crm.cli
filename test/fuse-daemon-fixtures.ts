import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CRMConfig } from '../src/config.ts'
import { openDB } from '../src/db.ts'
import type { Activity, Company, Contact, Deal } from '../src/drizzle-schema.ts'

/**
 * Shared fixtures for the `fuse-daemon.ts` test suite (readdir-security and
 * extractId-fallback tests), so entity-construction boilerplate isn't
 * repeated across every test.
 */

export const STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed-won',
  'closed-lost',
]

// A traversal payload used as a primary-key id. Never reachable via this
// CLI's own validated commands (ids are always generated internally via
// `makeId()`) — only via `crm import` or direct DB manipulation, same threat
// model as Issue #2/#9.
export const EVIL_ID = '../../../pwned-id'

export const NOW = new Date().toISOString()

export function freshDB() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-fuse-daemon-'))
  return openDB(join(dir, 'test.db'))
}

export function testConfig(): CRMConfig {
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
      stages: STAGES,
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
  }
}

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct_test',
    name: 'Test Contact',
    emails: '[]',
    phones: '[]',
    companies: '[]',
    linkedin: null,
    x: null,
    bluesky: null,
    telegram: null,
    tags: '[]',
    custom_fields: '{}',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co_test',
    name: 'Test Company',
    websites: '[]',
    phones: '[]',
    tags: '[]',
    custom_fields: '{}',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'dl_test',
    title: 'Test Deal',
    value: null,
    stage: 'lead',
    contacts: '[]',
    company: null,
    expected_close: null,
    probability: null,
    tags: '[]',
    custom_fields: '{}',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'ac_test',
    type: 'note',
    body: '',
    contacts: '[]',
    company: null,
    deal: null,
    custom_fields: '{}',
    created_at: NOW,
    ...overrides,
  }
}
