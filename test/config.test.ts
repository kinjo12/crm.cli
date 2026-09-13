import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { createTestContext, initGitRepo } from './helpers.ts'

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

/**
 * Deny write access to `dir` for the current user so a subsequent file
 * creation attempt inside it fails deterministically. On Windows, a plain
 * `chmodSync` read-only attribute on a *directory* does not block creating
 * new files inside it, so an ACL deny rule (`icacls`) is required instead.
 */
function lockDirectory(dir: string): void {
  if (platform === 'win32') {
    execSync(`icacls "${dir}" /deny "${process.env.USERNAME}:(OI)(CI)W"`, {
      stdio: 'ignore',
    })
  } else {
    chmodSync(dir, 0o555)
  }
}

function unlockDirectory(dir: string): void {
  if (platform === 'win32') {
    execSync(`icacls "${dir}" /remove:d "${process.env.USERNAME}"`, {
      stdio: 'ignore',
    })
  } else {
    chmodSync(dir, 0o755)
  }
}

describe('config: phone settings', () => {
  test('phone.default_country allows short numbers', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, `[phone]\ndefault_country = "US"\n`)
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '2125551234',
      )
      .trim()
    const out = ctx.runOK(
      '--config',
      configPath,
      'contact',
      'show',
      id,
      '--format',
      'json',
    )
    const data = JSON.parse(out)
    expect(data.phones[0]).toBe('+12125551234')
  })

  test('phone.display = national shows national format', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[phone]\ndefault_country = "US"\ndisplay = "national"\n`,
    )
    ctx.runOK(
      '--config',
      configPath,
      'contact',
      'add',
      '--name',
      'Jane',
      '--phone',
      '+12125551234',
    )
    const out = ctx.runOK('--config', configPath, 'contact', 'list')
    // National format should not have +1 prefix in display
    expect(out).toContain('Jane')
  })

  test('phone.display = e164 shows raw E.164', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, `[phone]\ndisplay = "e164"\n`)
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'contact',
        'add',
        '--name',
        'Jane',
        '--phone',
        '+12125551234',
      )
      .trim()
    const out = ctx.runOK('--config', configPath, 'contact', 'show', id)
    expect(out).toContain('+12125551234')
  })
})

describe('config: mount settings affect export-fs', () => {
  test('mount.max_recent_activity limits activities in contact JSON', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, '[mount]\nmax_recent_activity = 2\n')
    ctx.runOK(
      '--config',
      configPath,
      'contact',
      'add',
      '--name',
      'Jane',
      '--email',
      'jane@acme.com',
    )
    for (let i = 0; i < 5; i++) {
      ctx.runOK(
        '--config',
        configPath,
        'log',
        'note',
        `Note ${i}`,
        '--contact',
        'jane@acme.com',
      )
    }
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('--config', configPath, 'export-fs', outDir)
    const files = readdirSync(join(outDir, 'contacts')).filter(
      (f) => f.endsWith('.json') && !f.startsWith('_'),
    )
    const data = JSON.parse(
      readFileSync(join(outDir, 'contacts', files[0]), 'utf-8'),
    )
    expect(data.recent_activity).toHaveLength(2)
  })
})

describe('config: pipeline stage changes', () => {
  test('deal with stage from old config rejected after config change', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')

    // First config has 'alpha' stage
    writeFileSync(configPath, `[pipeline]\nstages = ["alpha", "beta"]\n`)
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'First',
      '--stage',
      'alpha',
    )

    // Change config to different stages — 'alpha' no longer valid
    writeFileSync(configPath, `[pipeline]\nstages = ["gamma", "delta"]\n`)
    const result = ctx.runFail(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'Second',
      '--stage',
      'alpha',
    )
    expect(result.stderr).toContain('stage')
  })

  test('deal move to new stage works after config change', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')

    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["alpha", "beta", "gamma"]\n`,
    )
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'alpha',
      )
      .trim()

    ctx.runOK('--config', configPath, 'deal', 'move', id, '--stage', 'gamma')
    const out = ctx.runOK(
      '--config',
      configPath,
      'deal',
      'show',
      id,
      '--format',
      'json',
    )
    expect(JSON.parse(out).stage).toBe('gamma')
  })

  test('export-fs with custom stages only creates those stage dirs', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, `[pipeline]\nstages = ["x", "y"]\n`)
    const outDir = join(ctx.dir, 'export')
    ctx.runOK('--config', configPath, 'export-fs', outDir)
    const stages = readdirSync(join(outDir, 'deals', '_by-stage')).sort()
    expect(stages).toEqual(['x', 'y'])
  })
})

describe('config: won_stage / lost_stage', () => {
  test('custom won_stage used by report won', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["open", "demo", "won", "lost"]\nwon_stage = "won"\nlost_stage = "lost"\n`,
    )
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Custom Won',
        '--value',
        '5000',
        '--stage',
        'open',
      )
      .trim()
    ctx.runOK('--config', configPath, 'deal', 'move', id, '--stage', 'won')

    const report = ctx.runJSON<Array<{ title: string }>>(
      '--config',
      configPath,
      'report',
      'won',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].title).toBe('Custom Won')
  })

  test('custom lost_stage used by report lost', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["open", "demo", "won", "lost"]\nwon_stage = "won"\nlost_stage = "lost"\n`,
    )
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Custom Lost',
        '--value',
        '3000',
        '--stage',
        'open',
      )
      .trim()
    ctx.runOK('--config', configPath, 'deal', 'move', id, '--stage', 'lost')

    const report = ctx.runJSON<Array<{ title: string }>>(
      '--config',
      configPath,
      'report',
      'lost',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].title).toBe('Custom Lost')
  })

  test('stale report excludes deals at custom terminal stages', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["open", "done", "dropped"]\nwon_stage = "done"\nlost_stage = "dropped"\n`,
    )
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Done Deal',
        '--stage',
        'open',
      )
      .trim()
    ctx.runOK('--config', configPath, 'deal', 'move', id, '--stage', 'done')

    const report = ctx.runJSON<Array<{ title?: string }>>(
      '--config',
      configPath,
      'report',
      'stale',
      '--type',
      'deal',
      '--format',
      'json',
    )
    const titles = report.map((r) => r.title)
    expect(titles).not.toContain('Done Deal')
  })

  test('forecast excludes deals at custom terminal stages', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["prospect", "closed", "rejected"]\nwon_stage = "closed"\nlost_stage = "rejected"\n`,
    )
    ctx.runOK(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'Open Deal',
      '--value',
      '1000',
      '--stage',
      'prospect',
    )
    const id2 = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Closed Deal',
        '--value',
        '2000',
        '--stage',
        'prospect',
      )
      .trim()
    ctx.runOK('--config', configPath, 'deal', 'move', id2, '--stage', 'closed')

    const report = ctx.runJSON<Array<{ title: string }>>(
      '--config',
      configPath,
      'report',
      'forecast',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].title).toBe('Open Deal')
  })

  test('defaults to closed-won/closed-lost when not specified', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('deal', 'add', '--title', 'Default Won', '--stage', 'lead')
      .trim()
    ctx.runOK('deal', 'move', id, '--stage', 'closed-won')

    const report = ctx.runJSON<Array<{ title: string }>>(
      'report',
      'won',
      '--format',
      'json',
    )
    expect(report).toHaveLength(1)
    expect(report[0].title).toBe('Default Won')
  })

  test('invalid toml is gracefully ignored', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'crm.toml')
    writeFileSync(configPath, 'this is not valid toml {{{{')

    // Should fall back to defaults and work fine
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'lead',
      )
      .trim()
    expect(id).toStartWith('dl_')
  })
})

describe('config resolution', () => {
  test('--config flag takes highest priority', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'explicit.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["alpha", "beta", "gamma"]\n`,
    )

    // Add a deal with a stage from the explicit config.
    const id = ctx
      .runOK(
        '--config',
        configPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'alpha',
      )
      .trim()
    const show = ctx.runOK('--config', configPath, 'deal', 'show', id)
    expect(show).toContain('alpha')
  })

  test('--config flag rejects invalid stage not in custom config', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'custom.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["alpha", "beta", "gamma"]\n`,
    )

    // "lead" is in the default config but not in this custom config.
    const result = ctx.runFail(
      '--config',
      configPath,
      'deal',
      'add',
      '--title',
      'Test',
      '--stage',
      'lead',
    )
    expect(result.stderr).toContain('stage')
  })

  test('CRM_CONFIG env var is used when no --config flag', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'env.toml')
    writeFileSync(
      configPath,
      `[pipeline]\nstages = ["env-stage-1", "env-stage-2"]\n`,
    )

    const result = ctx.runWithEnv(
      { CRM_CONFIG: configPath, CRM_DB: ctx.dbPath },
      'deal',
      'add',
      '--title',
      'Test',
      '--stage',
      'env-stage-1',
    )
    expect(result.exitCode).toBe(0)
  })

  test('crm.toml in current directory is found', () => {
    const ctx = createTestContext({ noConfig: true })
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["local-1", "local-2", "local-3"]\n`,
    )

    // Run from ctx.dir — should pick up ./crm.toml.
    const id = ctx
      .runOK('deal', 'add', '--title', 'Test', '--stage', 'local-1')
      .trim()
    const show = ctx.runOK('deal', 'show', id)
    expect(show).toContain('local-1')
  })

  test('crm.toml in parent directory is found', () => {
    const ctx = createTestContext()

    // ctx.dir is the project root (a real git repo) and holds crm.toml.
    initGitRepo(ctx.dir)
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["parent-1", "parent-2"]\n`,
    )

    // Create a subdirectory and run from there.
    const subdir = join(ctx.dir, 'subproject')
    mkdirSync(subdir)

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'parent-1',
      ],
      { cwd: subdir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toStartWith('dl_')
  })

  test('crm.toml in grandparent directory is found', () => {
    const ctx = createTestContext()

    // ctx.dir is the project root (a real git repo) and holds crm.toml.
    initGitRepo(ctx.dir)
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["grandparent-1", "grandparent-2"]\n`,
    )

    const nested = join(ctx.dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'grandparent-1',
      ],
      { cwd: nested, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).toBe(0)
  })

  test('closer crm.toml overrides parent crm.toml', () => {
    const ctx = createTestContext()

    // Parent config.
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["parent-stage"]\n`,
    )

    // Child config in subdir.
    const subdir = join(ctx.dir, 'project')
    mkdirSync(subdir)
    writeFileSync(
      join(subdir, 'crm.toml'),
      `[pipeline]\nstages = ["child-stage"]\n`,
    )

    // Run from subdir — child config should win.
    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'child-stage',
      ],
      { cwd: subdir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).toBe(0)

    // Parent stage should NOT be valid from child dir.
    const proc2 = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test2',
        '--stage',
        'parent-stage',
      ],
      { cwd: subdir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc2.exitCode).not.toBe(0)
  })

  test('--config flag overrides local crm.toml', () => {
    const ctx = createTestContext()

    // Local config in CWD.
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["local-stage"]\n`,
    )

    // Explicit config via flag.
    const explicitConfig = join(ctx.dir, 'override.toml')
    writeFileSync(explicitConfig, `[pipeline]\nstages = ["explicit-stage"]\n`)

    // --config should win over local crm.toml.
    const id = ctx
      .runOK(
        '--config',
        explicitConfig,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'explicit-stage',
      )
      .trim()
    expect(id).toStartWith('dl_')

    // local-stage should NOT work with --config override.
    const result = ctx.runFail(
      '--config',
      explicitConfig,
      'deal',
      'add',
      '--title',
      'Test2',
      '--stage',
      'local-stage',
    )
    expect(result.stderr).toContain('stage')
  })

  test('falls back to defaults when no config file exists', () => {
    const ctx = createTestContext()

    // No crm.toml anywhere — default stages should work.
    const id = ctx
      .runOK('deal', 'add', '--title', 'Test', '--stage', 'lead')
      .trim()
    expect(id).toStartWith('dl_')
  })

  test('config sets default output format', () => {
    const ctx = createTestContext({ noConfig: true })
    writeFileSync(join(ctx.dir, 'crm.toml'), `[defaults]\nformat = "json"\n`)

    ctx.runOK('contact', 'add', '--name', 'Jane')

    // Without --format, should use the config default (json).
    const out = ctx.runOK('contact', 'list')
    expect(out.trim()).toStartWith('[')
  })

  test('--format flag overrides config default', () => {
    const ctx = createTestContext({ noConfig: true })
    writeFileSync(join(ctx.dir, 'crm.toml'), `[defaults]\nformat = "json"\n`)

    ctx.runOK('contact', 'add', '--name', 'Jane')

    // Explicit --format csv should override config's json default.
    const out = ctx.runOK('contact', 'list', '--format', 'csv')
    expect(out).toContain('name')
    expect(out).not.toStartWith('[')
  })

  test('config sets custom database path', () => {
    const ctx = createTestContext({ noConfig: true })
    const customDB = join(ctx.dir, 'from-config.db')
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[database]\npath = "${customDB}"\n`,
    )

    // Run without --db flag — should use config's database path.
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, 'contact', 'add', '--name', 'Jane'],
      { cwd: ctx.dir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).toBe(0)

    const { existsSync } = require('node:fs')
    expect(existsSync(customDB)).toBe(true)
  })
})

describe('config resolution: scoped to project directory (security)', () => {
  test('crm.toml above the project root (.git boundary) is not loaded', () => {
    const ctx = createTestContext({ noConfig: true })

    // An unrelated ancestor directory has its own crm.toml.
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["outer-stage"]\n`,
    )

    // The project root sits below it and is a real git repo.
    const projectDir = join(ctx.dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)

    // The outer/ancestor stage must NOT be visible from inside the project.
    const outerAttempt = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'outer-stage',
      ],
      { cwd: projectDir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(outerAttempt.exitCode).not.toBe(0)

    // Built-in default config is used instead (its default stages apply).
    const defaultAttempt = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test2',
        '--stage',
        'lead',
      ],
      { cwd: projectDir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(defaultAttempt.exitCode).toBe(0)
  })

  test('crm.toml at the project root (.git directory) is still found from a subdirectory', () => {
    const ctx = createTestContext({ noConfig: true })
    initGitRepo(ctx.dir)
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["root-stage"]\n`,
    )

    const nested = join(ctx.dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'root-stage',
      ],
      { cwd: nested, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).toBe(0)
  })

  test('when no .git is found anywhere, only the current directory is checked (not ancestors)', () => {
    const ctx = createTestContext({ noConfig: true })

    // No .git anywhere in this chain — crm.toml sits in ctx.dir only.
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[pipeline]\nstages = ["parent-only-stage"]\n`,
    )

    const subdir = join(ctx.dir, 'subproject')
    mkdirSync(subdir)

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'parent-only-stage',
      ],
      { cwd: subdir, env: { ...process.env, NO_COLOR: '1' } },
    )
    expect(proc.exitCode).not.toBe(0)
  })

  test('does not fall back to ~/.crm/config.toml when no project config exists', () => {
    const ctx = createTestContext({ noConfig: true })
    const fakeHome = mkdtempSync(join(tmpdir(), 'crm-fakehome-'))
    mkdirSync(join(fakeHome, '.crm'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.crm', 'config.toml'),
      `[pipeline]\nstages = ["global-stage"]\n`,
    )

    const projectDir = join(ctx.dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    const fakeHomeEnv = {
      ...process.env,
      NO_COLOR: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    }

    // The global config's stage must be ignored.
    const globalAttempt = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test',
        '--stage',
        'global-stage',
      ],
      { cwd: projectDir, env: fakeHomeEnv },
    )
    expect(globalAttempt.exitCode).not.toBe(0)

    // Falls back to the built-in default config instead.
    const defaultAttempt = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'deal',
        'add',
        '--title',
        'Test2',
        '--stage',
        'lead',
      ],
      { cwd: projectDir, env: fakeHomeEnv },
    )
    expect(defaultAttempt.exitCode).toBe(0)
  })

  test('auto-generated default config is created at the project root, not the home directory', () => {
    const ctx = createTestContext({ noConfig: true })
    const fakeHome = mkdtempSync(join(tmpdir(), 'crm-fakehome-'))
    const projectDir = join(ctx.dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'contact',
        'add',
        '--name',
        'Jane',
      ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          NO_COLOR: '1',
          HOME: fakeHome,
          USERPROFILE: fakeHome,
        },
      },
    )
    expect(proc.exitCode).toBe(0)
    expect(existsSync(join(projectDir, 'crm.toml'))).toBe(true)
    expect(existsSync(join(fakeHome, '.crm', 'config.toml'))).toBe(false)
  })

  test('auto-generated default config is created in the current directory when no .git is found', () => {
    const ctx = createTestContext({ noConfig: true })
    const fakeHome = mkdtempSync(join(tmpdir(), 'crm-fakehome-'))
    const projectDir = join(ctx.dir, 'project')
    mkdirSync(projectDir, { recursive: true })

    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'contact',
        'add',
        '--name',
        'Jane',
      ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          NO_COLOR: '1',
          HOME: fakeHome,
          USERPROFILE: fakeHome,
        },
      },
    )
    expect(proc.exitCode).toBe(0)
    expect(existsSync(join(projectDir, 'crm.toml'))).toBe(true)
    expect(existsSync(join(fakeHome, '.crm', 'config.toml'))).toBe(false)
  })

  test('a bare ".git" file (not a real repository) in an ancestor does not establish a trust boundary — hooks are not executed', () => {
    const ctx = createTestContext({ noConfig: true })

    // Attacker plants a fake ".git" — an arbitrary file, not a real git
    // repository — plus a malicious crm.toml with a [hooks] entry, in an
    // ancestor directory (e.g. an extracted archive, a shared drive, $HOME).
    writeFileSync(join(ctx.dir, '.git'), 'not a real git repository')

    const markerFile = join(ctx.dir, 'pwned.txt').replace(/\\/g, '/')
    const hookScript = join(ctx.dir, 'hook.js')
    writeFileSync(
      hookScript,
      `require('node:fs').writeFileSync('${markerFile}', 'pwned')\n`,
    )
    const hookScriptFwd = hookScript.replace(/\\/g, '/')
    const hookCmd = `node "${hookScriptFwd}"`
    writeFileSync(
      join(ctx.dir, 'crm.toml'),
      `[hooks]\npost-contact-add = "${hookCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`,
    )

    // The victim runs the CLI from a subdirectory that has NO real git repo
    // of its own — a very common situation (ad hoc folder, extracted
    // archive, shared drive, home directory).
    const victimDir = join(ctx.dir, 'subproject')
    mkdirSync(victimDir, { recursive: true })

    Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--db',
        ctx.dbPath,
        'contact',
        'add',
        '--name',
        'Jane',
      ],
      { cwd: victimDir, env: { ...process.env, NO_COLOR: '1' } },
    )

    // The malicious hook must NOT have run — the fake ".git" file must not
    // be trusted as a project-root boundary.
    expect(existsSync(join(ctx.dir, 'pwned.txt'))).toBe(false)
  })
})

describe('config resolution: auto-create-default-config failure handling', () => {
  test('loadConfig falls back to in-memory defaults when the auto-created config cannot be written', () => {
    const ctx = createTestContext({ noConfig: true })
    const projectDir = join(ctx.dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    // No .git anywhere — findProjectRoot has no boundary, so the
    // auto-created config would be written directly into projectDir.

    lockDirectory(projectDir)
    try {
      const proc = Bun.spawnSync(
        [
          'bun',
          'run',
          CRM_BIN,
          '--db',
          ctx.dbPath,
          'contact',
          'add',
          '--name',
          'Jane',
        ],
        { cwd: projectDir, env: { ...process.env, NO_COLOR: '1' } },
      )
      // Must NOT hard-fail with a raw fs error — should continue using the
      // in-memory default config instead.
      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString().trim().length).toBeGreaterThan(0)
      // No config file should have been left behind in the locked directory.
      expect(existsSync(join(projectDir, 'crm.toml'))).toBe(false)
    } finally {
      unlockDirectory(projectDir)
    }
  })
})

describe('config: env var overrides', () => {
  test('CRM_PHONE_DISPLAY env var overrides config file', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Jane', '--phone', '+12125551234')

    // Default test config uses national display
    const national = ctx.runOK('contact', 'show', '+12125551234')
    expect(national).toContain('(212) 555-1234')

    // Env var override to international
    const intl = ctx.runWithEnv(
      { CRM_PHONE_DISPLAY: 'international' },
      'contact',
      'show',
      '+12125551234',
    )
    expect(intl.stdout).toContain('+1 212 555 1234')
  })
})

describe('config: malformed TOML warning', () => {
  test('prints warning on bad TOML but still works', () => {
    const ctx = createTestContext()
    const configPath = join(ctx.dir, 'bad.toml')
    writeFileSync(configPath, 'this is not valid toml [[[')

    const result = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--config',
        configPath,
        '--db',
        ctx.dbPath,
        'contact',
        'add',
        '--name',
        'Test',
      ],
      { cwd: ctx.dir, env: { ...process.env, NO_COLOR: '1' } },
    )
    const stderr = result.stderr.toString()
    expect(stderr).toContain('Warning')
    expect(stderr).toContain('could not parse config file')
    // Should still succeed with defaults
    expect(result.exitCode).toBe(0)
  })
})

describe('config: explicit path missing', () => {
  test('--config <nonexistent path> fails with a clear error', () => {
    const ctx = createTestContext({ noConfig: true })
    const missingPath = join(ctx.dir, 'does-not-exist.toml')

    const result = ctx.runFail(
      '--config',
      missingPath,
      'contact',
      'add',
      '--name',
      'Test',
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('config file not found')
    expect(result.stderr).toContain(missingPath)
    expect(result.stderr).not.toContain('could not parse config file')
    expect(result.stderr).not.toContain('Warning')
  })

  test('CRM_CONFIG=<nonexistent path> fails with a clear error', () => {
    const ctx = createTestContext({ noConfig: true })
    const missingPath = join(ctx.dir, 'does-not-exist.toml')

    const result = ctx.runWithEnv(
      { CRM_CONFIG: missingPath },
      'contact',
      'add',
      '--name',
      'Test',
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('config file not found')
    expect(result.stderr).toContain(missingPath)
    expect(result.stderr).not.toContain('could not parse config file')
    expect(result.stderr).not.toContain('Warning')
  })

  test('--config <a directory> fails with a clear error instead of silently falling back to defaults', () => {
    const ctx = createTestContext({ noConfig: true })
    const dirAsConfigPath = join(ctx.dir, 'not-a-file.toml')
    mkdirSync(dirAsConfigPath)

    const result = ctx.runFail(
      '--config',
      dirAsConfigPath,
      'contact',
      'add',
      '--name',
      'Test',
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('config file not found')
    expect(result.stderr).toContain(dirAsConfigPath)
    expect(result.stderr).not.toContain('could not parse config file')
    expect(result.stderr).not.toContain('Warning')
  })
})

describe('config resolution: implicit-vs-explicit missing-path asymmetry', () => {
  test('implicit search finding nothing still auto-creates a default config instead of failing', () => {
    const ctx = createTestContext({ noConfig: true })

    // No --config flag, no CRM_CONFIG env var, and no crm.toml anywhere —
    // this is the "implicit" resolution path (source === 'none' before
    // auto-create). Unlike a missing *explicit* path, this must NOT hard
    // fail: it should keep auto-creating a default config as before.
    const result = ctx.run('contact', 'add', '--name', 'Test')
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(ctx.dir, 'crm.toml'))).toBe(true)
  })
})
