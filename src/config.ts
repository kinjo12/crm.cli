import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  /**
   * Resolution metadata — not part of the TOML schema. Populated by
   * `loadConfig` so callers (notably the hooks trust gate in `hooks.ts`)
   * can tell whether this config came from an explicit source (`--config`
   * / `CRM_CONFIG`) or was discovered implicitly, since only implicitly
   * discovered configs are subject to the hooks trust-on-first-use gate.
   */
  _meta?: ConfigResolution
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

export type ConfigSource = 'explicit' | 'implicit' | 'none'

export interface ConfigResolution {
  path: string | null
  source: ConfigSource
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
 * Find the real git repository root containing `startDir`, by shelling out
 * to `git rev-parse --show-toplevel`. This is the only trustworthy way to
 * establish a project-root boundary: unlike checking for a `.git` path with
 * `existsSync`, it can't be spoofed by planting an arbitrary file or
 * directory named `.git` in an ancestor directory, and it correctly handles
 * worktrees, submodules, and `.git` files (vs. directories).
 *
 * Returns `null` if `startDir` is not inside a git repository at all (or
 * `git` isn't installed) — in that case there is no project-root boundary
 * to find, and callers must not search upward toward the filesystem root.
 */
function findProjectRoot(startDir: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim()
    return out ? resolve(out) : null
  } catch {
    return null
  }
}

/**
 * Search for `crm.toml` starting at `startDir` and walking up parent
 * directories, but never past the project root (see `findProjectRoot`).
 * This prevents an unrelated ancestor directory's `crm.toml` — whose
 * `hooks` are executed without confirmation — from being loaded.
 *
 * If `startDir` isn't inside a real git repository, there is no known
 * project boundary, so only `startDir` itself is checked — never walking
 * upward toward the filesystem root.
 *
 * There is no implicit fallback to a global `~/.crm/config.toml`: if no
 * `crm.toml` is found within the project, callers fall back to the
 * built-in default config.
 */
function findConfigFile(startDir: string): string | null {
  const root = findProjectRoot(startDir)
  const start = resolve(startDir)

  if (root === null) {
    const candidate = join(start, 'crm.toml')
    return existsSync(candidate) ? candidate : null
  }

  let dir = start
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

/**
 * Resolve which `crm.toml` (if any) `loadConfig` would load, without
 * reading or parsing it, and report whether that resolution was explicit
 * (deliberate user action: `--config` flag or `CRM_CONFIG` env var) or
 * implicit (discovered by searching cwd-or-upward). Only implicit
 * resolution is subject to the hooks trust gate — see `hooks.ts`.
 */
export function resolveConfigPath(explicitPath?: string): ConfigResolution {
  const explicit = explicitPath || process.env.CRM_CONFIG || null
  if (explicit) {
    return { path: resolve(explicit), source: 'explicit' }
  }
  const found = findConfigFile(process.cwd())
  if (found) {
    return { path: found, source: 'implicit' }
  }
  return { path: null, source: 'none' }
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
  const resolved = resolveConfigPath(opts.configPath)
  let configPath: string | null = resolved.path
  let source: ConfigSource = resolved.source

  if (!configPath) {
    const root = findProjectRoot(process.cwd())
    const p = join(root ?? process.cwd(), 'crm.toml')
    try {
      createDefaultConfig(p)
      configPath = p
      // Auto-created configs are found the same way an implicit crm.toml
      // would be on the next run — treat them as implicit for the hooks
      // trust gate rather than exempting them.
      source = 'implicit'
    } catch (_e) {
      console.error(`Warning: could not create default config at ${p}`)
      configPath = null
    }
  }

  if (configPath) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = parseTOML(raw)
      config = mergeConfig(config, parsed)
    } catch (_e) {
      console.error(`Warning: could not parse config file ${configPath}`)
    }
  }

  config._meta = { path: configPath, source }

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
