import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

/**
 * Trust-on-first-use gate regression tests (see hooks.ts / trust-store.ts /
 * commands/config.ts). Each test gets its own fake $HOME/%USERPROFILE% so
 * the local trust ledger (~/.crm/trusted_configs.json) never touches the
 * real developer machine's trust store and tests can't see each other's
 * trust decisions.
 */

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'crm-trust-fakehome-'))
  // Our hook commands shell out to `node`. On this machine `node` is a
  // Volta shim that derives "LocalAppData" from %USERPROFILE% (not the
  // LOCALAPPDATA env var) and fails hard if that subdirectory doesn't
  // exist — so the fake $HOME/%USERPROFILE% used to isolate the trust
  // store (~/.crm/trusted_configs.json) needs a real AppData/Local dir
  // or every hook invocation errors out with "Volta error: Could not
  // determine LocalAppData directory" before the trust gate is even
  // reached.
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  return home
}

function envFor(
  home: string,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    ...extra,
  }
}

function runCLI(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { exitCode: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync(['bun', 'run', CRM_BIN, ...args], { cwd, env })
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  }
}

/** Escape a shell command for embedding as a TOML basic string value. */
function toTOMLString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Write a `crm.toml` in `dir` with a `[hooks]` entry for `hookName` that
 * writes a marker file (`marker`) when it runs, using `node "<script>"` as
 * the hook command — the form already proven to work reliably via
 * spawnSync+shell:true on this Windows machine (see the gitlink/bare-.git
 * regression tests in config.test.ts).
 */
function writeHookConfig(dir: string, hookName: string, marker: string): void {
  const hookScript = join(dir, 'hook.js')
  const markerFwd = marker.replace(/\\/g, '/')
  writeFileSync(
    hookScript,
    `require('node:fs').writeFileSync('${markerFwd}', 'ran')\n`,
  )
  const hookScriptFwd = hookScript.replace(/\\/g, '/')
  const hookCmd = `node "${hookScriptFwd}"`
  writeFileSync(
    join(dir, 'crm.toml'),
    `[hooks]\n${hookName} = "${toTOMLString(hookCmd)}"\n`,
  )
}

describe('hooks trust-on-first-use gate', () => {
  test('implicit config hook does not run when untrusted and no TTY is available', () => {
    const home = fakeHome()
    const projectDir = mkdtempSync(join(tmpdir(), 'crm-trust-project-'))
    const marker = join(projectDir, 'pwned.txt')
    writeHookConfig(projectDir, 'post-contact-add', marker)
    const dbPath = join(projectDir, 'test.db')

    const result = runCLI(
      projectDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )

    // The overall command still completes normally — a skipped hook must
    // not hard-fail the CLI invocation.
    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(result.stderr).toContain('not trusted')
  })

  test('hook runs after the config is trusted via `crm config trust`', () => {
    const home = fakeHome()
    const projectDir = mkdtempSync(join(tmpdir(), 'crm-trust-project-'))
    const marker = join(projectDir, 'trusted-marker.txt')
    writeHookConfig(projectDir, 'post-contact-add', marker)
    const dbPath = join(projectDir, 'test.db')
    const configPath = join(projectDir, 'crm.toml')

    // Sanity check: untrusted, hook does not run yet.
    const before = runCLI(
      projectDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )
    expect(before.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)

    const trust = runCLI(
      projectDir,
      envFor(home),
      'config',
      'trust',
      configPath,
    )
    expect(trust.exitCode).toBe(0)
    expect(trust.stdout).toContain('Trusted')

    const after = runCLI(
      projectDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane2',
    )
    expect(after.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  test('re-trust is required after the trusted config content changes', () => {
    const home = fakeHome()
    const projectDir = mkdtempSync(join(tmpdir(), 'crm-trust-project-'))
    const marker = join(projectDir, 'marker.txt')
    writeHookConfig(projectDir, 'post-contact-add', marker)
    const dbPath = join(projectDir, 'test.db')
    const configPath = join(projectDir, 'crm.toml')

    runCLI(projectDir, envFor(home), 'config', 'trust', configPath)

    const first = runCLI(
      projectDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )
    expect(first.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)

    // Mutate the trusted config's content — the hash no longer matches, so
    // it must require re-trust even though it's the same path.
    const { unlinkSync } = require('node:fs')
    unlinkSync(marker)
    writeFileSync(
      configPath,
      `${require('node:fs').readFileSync(configPath, 'utf-8')}\n# modified\n`,
    )

    const second = runCLI(
      projectDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane3',
    )
    expect(second.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(second.stderr).toContain('not trusted')
  })

  test('config supplied via --config runs hooks without any trust step', () => {
    const home = fakeHome() // fresh, empty trust store
    const projectDir = mkdtempSync(join(tmpdir(), 'crm-trust-project-'))
    const explicitDir = mkdtempSync(join(tmpdir(), 'crm-trust-explicit-'))
    const marker = join(explicitDir, 'marker.txt')
    writeHookConfig(explicitDir, 'post-contact-add', marker)
    const configPath = join(explicitDir, 'crm.toml')
    const dbPath = join(projectDir, 'test.db')

    const result = runCLI(
      projectDir,
      envFor(home),
      '--config',
      configPath,
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )

    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(result.stderr).not.toContain('not trusted')
  })

  test('config supplied via CRM_CONFIG env var runs hooks without any trust step', () => {
    const home = fakeHome()
    const projectDir = mkdtempSync(join(tmpdir(), 'crm-trust-project-'))
    const explicitDir = mkdtempSync(join(tmpdir(), 'crm-trust-explicit-'))
    const marker = join(explicitDir, 'marker.txt')
    writeHookConfig(explicitDir, 'post-contact-add', marker)
    const configPath = join(explicitDir, 'crm.toml')
    const dbPath = join(projectDir, 'test.db')

    const result = runCLI(
      projectDir,
      envFor(home, { CRM_CONFIG: configPath }),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )

    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  test('trust is keyed per-path — trusting one config does not trust an unrelated one', () => {
    const home = fakeHome()
    const projectA = mkdtempSync(join(tmpdir(), 'crm-trust-a-'))
    const projectB = mkdtempSync(join(tmpdir(), 'crm-trust-b-'))
    const markerA = join(projectA, 'marker.txt')
    const markerB = join(projectB, 'marker.txt')
    writeHookConfig(projectA, 'post-contact-add', markerA)
    writeHookConfig(projectB, 'post-contact-add', markerB)

    runCLI(
      projectA,
      envFor(home),
      'config',
      'trust',
      join(projectA, 'crm.toml'),
    )

    const resultA = runCLI(
      projectA,
      envFor(home),
      '--db',
      join(projectA, 'test.db'),
      'contact',
      'add',
      '--name',
      'Jane',
    )
    const resultB = runCLI(
      projectB,
      envFor(home),
      '--db',
      join(projectB, 'test.db'),
      'contact',
      'add',
      '--name',
      'Jane',
    )

    expect(resultA.exitCode).toBe(0)
    expect(resultB.exitCode).toBe(0)
    expect(existsSync(markerA)).toBe(true)
    expect(existsSync(markerB)).toBe(false)
  })

  test('gitlink-redirection: ancestor .git file pointing at a throwaway real repo does not establish a trust boundary that bypasses the hooks gate', () => {
    const home = fakeHome()
    const workDir = mkdtempSync(join(tmpdir(), 'crm-trust-gitlink-'))

    // A throwaway real git repository, unrelated to the attack tree.
    const realRepo = join(workDir, 'realrepo')
    mkdirSync(realRepo, { recursive: true })
    execSync('git init', { cwd: realRepo, stdio: 'ignore' })

    // Attacker-controlled ancestor directory: a `.git` FILE (not directory)
    // using git's legitimate gitlink indirection to point at the throwaway
    // repo above, making `git rev-parse --show-toplevel` report *this*
    // ancestor directory as a real repo root.
    const ancestor = join(workDir, 'ancestor')
    mkdirSync(ancestor, { recursive: true })
    const realGitDir = join(realRepo, '.git').replace(/\\/g, '/')
    writeFileSync(join(ancestor, '.git'), `gitdir: ${realGitDir}\n`)

    const marker = join(ancestor, 'pwned.txt')
    writeHookConfig(ancestor, 'post-contact-add', marker)

    // The victim runs the CLI from a subdirectory with no real git repo of
    // its own — a very common situation (ad hoc folder, extracted archive,
    // shared drive, home directory).
    const victimDir = join(ancestor, 'subproject')
    mkdirSync(victimDir, { recursive: true })
    const dbPath = join(victimDir, 'test.db')

    const result = runCLI(
      victimDir,
      envFor(home),
      '--db',
      dbPath,
      'contact',
      'add',
      '--name',
      'Jane',
    )

    // The command must still complete normally (no hang, no crash)...
    expect(result.exitCode).toBe(0)
    // ...but the malicious hook must NOT have run — trust boundary or not,
    // an implicitly-discovered config's hooks require explicit trust.
    expect(existsSync(marker)).toBe(false)
  })
})
