import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CRMConfig } from '../src/config.ts'
import { runHook } from '../src/hooks.ts'
import {
  atomicWriteFileSync,
  isTrusted,
  trustConfig,
  untrustConfig,
} from '../src/trust-store.ts'
import { initGitRepo } from './helpers.ts'

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
    initGitRepo(realRepo)

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

/**
 * TOCTOU regression tests for `runHook`/`resolveTrustedHookCommand` (issue
 * #6): the command that `spawnSync`s must come from the *same* read of
 * `crm.toml` that the trust hash was computed from — never from
 * `config.hooks` captured earlier, at `loadConfig()` time.
 *
 * A real double-swap race (attacker flips the file to malicious content
 * before the victim process's `loadConfig()` call, then flips it back to
 * the previously-trusted content before the hook actually executes) is
 * only a handful of milliseconds wide and not reliably triggerable by
 * racing a black-box CLI subprocess. Instead these tests call `runHook`
 * directly with a hand-built `CRMConfig` whose `config.hooks` value stands
 * in for "whatever was in memory when `loadConfig()` ran" while the
 * on-disk file is staged to whatever content exists at hook-execution
 * time — exactly reproducing the two ends of the race without needing to
 * win an actual timing window.
 *
 * Unlike the black-box tests above, this calls `hooks.ts`/`trust-store.ts`
 * directly in-process rather than spawning a subprocess with a fake
 * $HOME, so it cannot isolate the trust store via `fakeHome()` (the
 * module's trust-store path is resolved once, at module load, from the
 * real `homedir()`). To avoid touching unrelated entries in the real
 * `~/.crm/trusted_configs.json`, every entry this suite creates is keyed
 * on a unique `mkdtempSync` path and removed again in a `finally` block.
 */
describe('hooks TOCTOU regression (issue #6)', () => {
  function baseConfig(
    configPath: string,
    hooks: Record<string, string>,
  ): CRMConfig {
    return {
      _meta: { path: configPath, source: 'implicit' },
      database: { path: join(tmpdir(), 'unused.db') },
      defaults: { format: 'table' },
      hooks,
      mount: {
        default_path: join(tmpdir(), 'unused-mount'),
        readonly: false,
        allow_other: false,
        max_recent_activity: 10,
        search_limit: 10,
      },
      phone: { display: 'international' },
      pipeline: {
        stages: ['lead', 'closed-won', 'closed-lost'],
        won_stage: 'closed-won',
        lost_stage: 'closed-lost',
      },
    }
  }

  test('executes the freshly-read, trusted hook command — not the stale in-memory one from a swapped-then-reverted file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-toctou-'))
    const configPath = join(dir, 'crm.toml')
    const trustedMarker = join(dir, 'trusted.txt')
    const maliciousMarker = join(dir, 'malicious.txt')
    const trustedScript = join(dir, 'trusted.js')
    const maliciousScript = join(dir, 'malicious.js')

    writeFileSync(
      trustedScript,
      `require('node:fs').writeFileSync(${JSON.stringify(trustedMarker)}, 'ran')\n`,
    )
    writeFileSync(
      maliciousScript,
      `require('node:fs').writeFileSync(${JSON.stringify(maliciousMarker)}, 'ran')\n`,
    )
    const trustedCmd = `node "${trustedScript.replace(/\\/g, '/')}"`
    const maliciousCmd = `node "${maliciousScript.replace(/\\/g, '/')}"`

    // The file that exists on disk at hook-execution time (t1) is the
    // previously-trusted, benign content — as if the attacker's swap back
    // to the original already happened before the trust re-check.
    writeFileSync(
      configPath,
      `[hooks]\npost-contact-add = "${toTOMLString(trustedCmd)}"\n`,
    )

    try {
      trustConfig(configPath)

      // Stand in for "what loadConfig() captured into memory at t0", when
      // the attacker had (hypothetically) swapped the file to malicious
      // content. `config.hooks` here deliberately disagrees with what's
      // now on disk.
      const staleConfig = baseConfig(configPath, {
        'post-contact-add': maliciousCmd,
      })

      const ok = runHook(staleConfig, 'post-contact-add', { name: 'Jane' })

      expect(ok).toBe(true)
      expect(existsSync(maliciousMarker)).toBe(false)
      expect(existsSync(trustedMarker)).toBe(true)
    } finally {
      untrustConfig(configPath)
    }
  })

  test('fails safe (skips) when the freshly-read, trusted config no longer defines the hook at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-toctou-'))
    const configPath = join(dir, 'crm.toml')
    const maliciousMarker = join(dir, 'malicious.txt')
    const maliciousScript = join(dir, 'malicious.js')

    writeFileSync(
      maliciousScript,
      `require('node:fs').writeFileSync(${JSON.stringify(maliciousMarker)}, 'ran')\n`,
    )
    const maliciousCmd = `node "${maliciousScript.replace(/\\/g, '/')}"`

    // Trusted, on-disk content defines no hooks whatsoever.
    writeFileSync(configPath, '[hooks]\n')

    try {
      trustConfig(configPath)

      const staleConfig = baseConfig(configPath, {
        'post-contact-add': maliciousCmd,
      })

      const ok = runHook(staleConfig, 'post-contact-add', { name: 'Jane' })

      expect(ok).toBe(true)
      expect(existsSync(maliciousMarker)).toBe(false)
    } finally {
      untrustConfig(configPath)
    }
  })

  test('load-time short-circuit: config.hooks[hookName] absent in memory skips the hook without ever reaching the trust gate, even if the on-disk config now defines it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-toctou-'))
    const configPath = join(dir, 'crm.toml')
    const marker = join(dir, 'should-not-run.txt')
    const script = join(dir, 'hook.js')

    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    )
    const cmd = `node "${script.replace(/\\/g, '/')}"`

    // The on-disk config, staged separately from the in-memory config below
    // (same pattern as the TOCTOU tests above), DOES define the hook.
    writeFileSync(
      configPath,
      `[hooks]\npost-contact-add = "${toTOMLString(cmd)}"\n`,
    )

    // Deliberately left untrusted: if `runHook` reached the trust gate at
    // all here, it would have to either prompt or print an "untrusted"
    // warning — neither of which must happen for this scenario.
    expect(isTrusted(configPath)).toBe(false)

    // `config.hooks` — standing in for whatever `loadConfig()` captured
    // into memory at process start — has no entry for this hook name at
    // all, even though a fresh read of the file would find one. Per the
    // inline comment in `runHook`, this must short-circuit to "no hook
    // configured" and skip entirely, without consulting the trust store.
    const staleConfig = baseConfig(configPath, {})

    const originalConsoleError = console.error
    const errorCalls: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    try {
      const ok = runHook(staleConfig, 'post-contact-add', { name: 'Jane' })

      expect(ok).toBe(true)
      expect(existsSync(marker)).toBe(false)
      // No trust-gate warning or prompt was ever emitted — proof the
      // short-circuit happened before `resolveTrustedHookCommand` (the
      // only code path that logs via `console.error` or prompts) was
      // ever called.
      expect(errorCalls).toEqual([])
      // The trust store itself was never consulted or mutated either.
      expect(isTrusted(configPath)).toBe(false)
    } finally {
      console.error = originalConsoleError
      untrustConfig(configPath)
    }
  })
})

/**
 * Trust-store write durability (issue #7 item 2): `saveTrustStore` writes
 * via `atomicWriteFileSync` (write-temp-then-rename) rather than a direct
 * `writeFileSync`, so two racing `crm` invocations can't interleave into a
 * corrupt file and a process killed mid-write can't leave a truncated one.
 */
describe('trust-store durability (issue #7 item 2)', () => {
  test('normal trust/untrust round-trip still works correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-trust-roundtrip-'))
    const configPath = join(dir, 'crm.toml')
    writeFileSync(configPath, '[hooks]\n')

    try {
      expect(isTrusted(configPath)).toBe(false)

      trustConfig(configPath)
      expect(isTrusted(configPath)).toBe(true)

      const removed = untrustConfig(configPath)
      expect(removed).toBe(true)
      expect(isTrusted(configPath)).toBe(false)
    } finally {
      untrustConfig(configPath)
    }
  })

  test('atomicWriteFileSync: the real file is always its old complete content or its new complete content, never a partial write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-atomic-write-'))
    const targetPath = join(dir, 'trusted_configs.json')

    atomicWriteFileSync(targetPath, 'OLD-COMPLETE-CONTENT')
    expect(readFileSync(targetPath, 'utf-8')).toBe('OLD-COMPLETE-CONTENT')

    // Simulate a process that crashed after finishing the temp-file write
    // but before the rename that commits it — by writing directly to a
    // sibling temp path in the same directory (the same co-location
    // `atomicWriteFileSync` relies on for its rename to be atomic) and
    // deliberately never renaming it over `targetPath`.
    const abandonedTmpPath = join(
      dir,
      '.trusted_configs.json.crash-simulation.tmp',
    )
    writeFileSync(abandonedTmpPath, 'NEW-CONTENT-NEVER-COMMITTED')

    // The real file must be completely untouched by the abandoned write —
    // still its old complete content, never truncated or partially
    // overwritten.
    expect(readFileSync(targetPath, 'utf-8')).toBe('OLD-COMPLETE-CONTENT')
    expect(existsSync(abandonedTmpPath)).toBe(true)

    // A subsequent real write must still succeed normally afterwards,
    // proving an orphaned leftover temp file (as a crash would leave
    // behind) doesn't interfere with future writes.
    atomicWriteFileSync(targetPath, 'NEW-COMPLETE-CONTENT')
    expect(readFileSync(targetPath, 'utf-8')).toBe('NEW-COMPLETE-CONTENT')
  })
})
