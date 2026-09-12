import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'

import type { CRMConfig } from './config.ts'
import { isTrusted, trustConfig } from './trust-store.ts'

/**
 * Prompt (via /dev/tty, mirroring `confirmOrForce` in lib/helpers.ts)
 * whether to run — and remember — hooks defined in an untrusted,
 * implicitly-discovered crm.toml.
 */
function promptTrustHooks(configPath: string): boolean {
  process.stdout.write(
    `crm.toml at ${configPath} defines hooks that have not been trusted. Run this hook now and remember this file? [y/N] `,
  )
  const buf = Buffer.alloc(64)
  const fd = openSync('/dev/tty', 'r')
  try {
    const n = readSync(fd, buf, 0, 64, null)
    const answer = buf.slice(0, n).toString().trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    closeSync(fd)
  }
}

/**
 * Trust-on-first-use gate: hooks defined in a `crm.toml` that was
 * discovered *implicitly* (cwd-or-ancestor search) must be trusted before
 * they run, regardless of how — or whether — project-root detection can be
 * spoofed. Explicitly-supplied configs (`--config` / `CRM_CONFIG`) are a
 * deliberate user action and are exempt (see `resolveConfigPath` in
 * config.ts). Returns `true` if the hook is cleared to run.
 */
function checkHookTrust(config: CRMConfig, hookName: string): boolean {
  const meta = config._meta
  if (!meta || meta.source !== 'implicit' || !meta.path) {
    return true
  }
  if (isTrusted(meta.path)) {
    return true
  }
  if (process.stdin.isTTY) {
    try {
      if (promptTrustHooks(meta.path)) {
        trustConfig(meta.path)
        return true
      }
    } catch {
      // /dev/tty unavailable despite isTTY — fail closed below
    }
    console.error(`Skipping hook '${hookName}': ${meta.path} was not trusted.`)
    return false
  }
  console.error(
    `Warning: hooks in ${meta.path} are not trusted and no TTY is available to confirm; skipping hook '${hookName}'. Run \`crm config trust ${meta.path}\` to allow it.`,
  )
  return false
}

export function runHook(
  config: CRMConfig,
  hookName: string,
  data: Record<string, unknown>,
): boolean {
  const hookCmd = config.hooks[hookName]
  if (!hookCmd) {
    return true // no hook = success
  }

  if (!checkHookTrust(config, hookName)) {
    // Untrusted hook is skipped, not treated as a pre-hook rejection — the
    // overall command still completes normally (see hooks trust gate docs).
    return true
  }

  const jsonData = JSON.stringify(data)
  const result = spawnSync(hookCmd, {
    shell: true,
    input: jsonData,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  })

  return result.status === 0
}
