import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  database: { path: string }
  defaults: { format: string }
  hooks: Record<string, string>
  mount: {
    default_path: string
    readonly: boolean
    /**
     * Mount with `-o allow_other` so processes running as a different uid
     * (e.g. root, container orchestrators) can read/write the FUSE filesystem.
     * Requires `user_allow_other` in /etc/fuse.conf when the mount is invoked
     * by a non-root user. Linux-only; ignored by the macOS NFS path.
     */
    allow_other: boolean
    max_recent_activity: number
    search_limit: number
  }
  phone: { default_country?: string; display: string }
  pipeline: { stages: string[]; won_stage: string; lost_stage: string }
}

export const SEARCH_MODEL = 'mxbai-embed-xsmall-v1'

const DEFAULT_STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed-won',
  'closed-lost',
]

function defaultConfig(): CRMConfig {
  return {
    database: { path: join(homedir(), '.crm', 'crm.db') },
    pipeline: {
      stages: [...DEFAULT_STAGES],
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
    defaults: { format: 'table' },
    phone: { display: 'international' },
    hooks: {},
    mount: {
      default_path: join(homedir(), 'crm'),
      readonly: false,
      allow_other: false,
      max_recent_activity: 10,
      search_limit: 20,
    },
  }
}

/**
 * Find the project root: the nearest ancestor of `startDir` (inclusive) that
 * contains a `.git` directory. If no ancestor has `.git` (even at the
 * filesystem root), the project root is `startDir` itself — the narrowest
 * possible interpretation when project boundaries are unknown.
 */
function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, '.git'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return resolve(startDir)
    }
    dir = parent
  }
}

/**
 * Search for `crm.toml` starting at `startDir` and walking up parent
 * directories, but never past the project root (see `findProjectRoot`).
 * This prevents an unrelated ancestor directory's `crm.toml` — whose
 * `hooks` are executed without confirmation — from being loaded.
 *
 * There is no implicit fallback to a global `~/.crm/config.toml`: if no
 * `crm.toml` is found within the project, callers fall back to the
 * built-in default config.
 */
function findConfigFile(startDir: string): string | null {
  const root = findProjectRoot(startDir)
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, 'crm.toml')
    if (existsSync(candidate)) {
      return candidate
    }
    if (dir === root) {
      return null
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

function mergeConfig(
  base: CRMConfig,
  // biome-ignore lint/suspicious/noExplicitAny: TOML parse output has no static type
  override: Record<string, any>,
): CRMConfig {
  const result = { ...base }
  if (override.database?.path) {
    result.database = { ...result.database, path: override.database.path }
  }
  if (override.pipeline) {
    result.pipeline = { ...result.pipeline }
    if (override.pipeline.stages) {
      result.pipeline.stages = override.pipeline.stages
    }
    if (override.pipeline.won_stage) {
      result.pipeline.won_stage = override.pipeline.won_stage
    }
    if (override.pipeline.lost_stage) {
      result.pipeline.lost_stage = override.pipeline.lost_stage
    }
  }
  if (override.defaults?.format) {
    result.defaults = { ...result.defaults, format: override.defaults.format }
  }
  if (override.phone) {
    result.phone = { ...result.phone }
    if (override.phone.default_country) {
      result.phone.default_country = override.phone.default_country
    }
    if (override.phone.display) {
      result.phone.display = override.phone.display
    }
  }
  if (override.hooks) {
    result.hooks = { ...result.hooks, ...override.hooks }
  }
  if (override.mount) {
    result.mount = { ...result.mount, ...override.mount }
  }
  return result
}

/** Detect the user's country code from system locale (e.g. "en_US" → "US") */
function detectCountry(): string | undefined {
  try {
    // macOS: AppleLocale gives e.g. "en_US"
    if (process.platform === 'darwin') {
      const locale = execSync('defaults read NSGlobalDomain AppleLocale', {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim()
      const match = locale.match(/_([A-Z]{2})/)
      if (match) {
        return match[1]
      }
    }
    // Linux/other: LANG or LC_ALL (e.g. "en_US.UTF-8" → "US")
    const lang = process.env.LC_ALL || process.env.LANG || ''
    const match = lang.match(/_([A-Z]{2})/)
    if (match) {
      return match[1]
    }
  } catch {
    // detection failed
  }
  return undefined
}

function createDefaultConfig(configPath: string): void {
  const country = detectCountry() || 'US'
  const content = `# CRM CLI configuration
# Docs: https://github.com/dzhng/crm.cli#configuration

[phone]
default_country = "${country}"
display = "national"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"
`
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, content)
  console.log(`Created default config at ${configPath}`)
  console.log(
    `  phone.default_country = "${country}" (detected from system locale)`,
  )
  console.log('  Edit this file to customize.\n')
}

export function loadConfig(opts: {
  configPath?: string
  dbPath?: string
  format?: string
}): CRMConfig {
  let config = defaultConfig()

  // Resolve config file — auto-create with sensible defaults on first run
  const configPath =
    opts.configPath ||
    process.env.CRM_CONFIG ||
    findConfigFile(process.cwd()) ||
    (() => {
      const root = findProjectRoot(process.cwd())
      const p = join(root, 'crm.toml')
      createDefaultConfig(p)
      return p
    })()

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = parseTOML(raw)
    config = mergeConfig(config, parsed)
  } catch (_e) {
    console.error(`Warning: could not parse config file ${configPath}`)
  }

  // Env var overrides (take priority over config file)
  if (process.env.CRM_PHONE_DEFAULT_COUNTRY) {
    config.phone.default_country = process.env.CRM_PHONE_DEFAULT_COUNTRY
  }
  if (process.env.CRM_PHONE_DISPLAY) {
    config.phone.display = process.env.CRM_PHONE_DISPLAY
  }

  // DB path resolution: --db flag > CRM_DB env > config file > default (~/.crm/crm.db)
  if (opts.dbPath) {
    config.database.path = opts.dbPath
  } else if (process.env.CRM_DB) {
    config.database.path = process.env.CRM_DB
  }

  // Format: --format flag > CRM_FORMAT env > config > default
  if (opts.format) {
    config.defaults.format = opts.format
  } else if (process.env.CRM_FORMAT) {
    config.defaults.format = process.env.CRM_FORMAT
  }

  return config
}
