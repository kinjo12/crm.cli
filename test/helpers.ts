import { execSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Whether the current platform supports FUSE/NFS mount tests */
export const canMount = existsSync('/dev/fuse') // Linux FUSE only — macOS NFS mount causes kernel panics, skip for now

/**
 * Initialize a real git repository at `dir`. Used by tests that need a
 * genuine project-root boundary — config resolution trusts `git
 * rev-parse --show-toplevel`, not the mere presence of a `.git` path, so
 * tests must create real repos rather than a bare `.git` file/directory.
 */
export function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' })
}

/**
 * Clean up stale FUSE mounts/processes left behind by a previously
 * interrupted test run (Ctrl+C, crash, OOM kill). When a run is killed like
 * that, `afterAll` never fires and the detached crm-fuse/fuse-daemon
 * processes — along with their kernel-level FUSE mounts — survive. Without
 * this cleanup, they accumulate across runs, exhaust kernel FUSE
 * connections, and a fresh `mount` call to the same path in a later run
 * fails outright.
 *
 * Every test file that performs a real FUSE mount must call this itself
 * (typically at module scope or as the first step of its own `beforeAll`)
 * rather than assuming some other file's module-level code already ran it —
 * Bun's test runner does not guarantee any particular test file executes
 * before another.
 */
export function cleanupStaleFuseMounts(): void {
  if (!canMount || process.platform !== 'linux') {
    return
  }
  const pidFiles = readdirSync(tmpdir()).filter(
    (f) => f.startsWith('crm-mount-') && f.endsWith('.pid'),
  )
  for (const f of pidFiles) {
    const pidPath = join(tmpdir(), f)
    try {
      const pids = readFileSync(pidPath, 'utf-8').trim().split('\n')
      for (const pid of pids) {
        try {
          process.kill(Number(pid))
        } catch {
          // already dead
        }
      }
      unlinkSync(pidPath)
    } catch {
      // ignore
    }
  }
  // Also clean up any stale test FUSE mounts still in the kernel
  const mounts = spawnSync('bash', [
    '-c',
    "mount | grep 'fuse\\.crm-fuse' | grep '/tmp/crm-test-' | awk '{print $3}'",
  ])
  if (mounts.stdout) {
    for (const mp of mounts.stdout.toString().trim().split('\n')) {
      if (mp) {
        spawnSync('fusermount', ['-u', mp], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      }
    }
  }
}

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

const TEST_CONFIG = `[phone]
default_country = "US"
display = "national"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"
`

export interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

export function createTestContext(opts?: { noConfig?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-'))
  const dbPath = join(dir, 'test.db')
  const configPath = join(dir, 'config.toml')
  if (!opts?.noConfig) {
    writeFileSync(configPath, TEST_CONFIG)
  }
  const baseEnv = opts?.noConfig
    ? { ...process.env, NO_COLOR: '1' }
    : { ...process.env, NO_COLOR: '1', CRM_CONFIG: configPath }

  function run(...args: string[]): RunResult {
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, '--db', dbPath, ...args],
      {
        cwd: dir,
        env: baseEnv,
      },
    )
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  function runOK(...args: string[]): string {
    const result = run(...args)
    if (result.exitCode !== 0) {
      throw new Error(
        `crm ${args.join(' ')} failed (exit ${result.exitCode}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      )
    }
    return result.stdout
  }

  function runFail(...args: string[]): RunResult {
    const result = run(...args)
    if (result.exitCode === 0) {
      throw new Error(
        `expected crm ${args.join(' ')} to fail, but it succeeded:\nstdout: ${result.stdout}`,
      )
    }
    return result
  }

  function runJSON<T = unknown>(...args: string[]): T {
    const out = runOK(...args)
    return JSON.parse(out) as T
  }

  function runWithEnv(
    env: Record<string, string>,
    ...args: string[]
  ): RunResult {
    const proc = Bun.spawnSync(
      ['bun', 'run', CRM_BIN, '--db', dbPath, ...args],
      {
        cwd: dir,
        env: { ...baseEnv, ...env },
      },
    )
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  return { dir, dbPath, configPath, run, runOK, runFail, runJSON, runWithEnv }
}

export type TestContext = ReturnType<typeof createTestContext>
