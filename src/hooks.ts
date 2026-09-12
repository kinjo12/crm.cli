import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'

import { parse as parseTOML } from 'toml'

import type { CRMConfig } from './config.ts'
import { isTrustedContent, trustConfigContent } from './trust-store.ts'

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
 * Trust-on-first-use gate for hooks defined in an implicitly-discovered
 * `crm.toml`, closing the TOCTOU window between config load and hook
 * execution: `config._meta.path` is read from disk exactly once here, the
 * trust decision is made against that exact buffer, and the hook command
 * that runs (extracted from parsing that same buffer) is returned to the
 * caller — never the value captured earlier in `config.hooks`, which may
 * reflect on-disk content from an earlier, possibly-attacker-controlled
 * moment (see hooks.ts / TOCTOU regression tests).
 *
 * Returns the hook command to execute, or `null` if the hook is not
 * cleared to run (untrusted, unreadable, unparsable, or no longer present
 * in the freshly-read config) — callers must treat `null` as "skip the
 * hook", not fall back to any previously-loaded in-memory value.
 */
function resolveTrustedHookCommand(
  configPath: string,
  hookName: string,
): string | null {
  let contents: Buffer
  try {
    contents = readFileSync(configPath)
  } catch {
    console.error(
      `Warning: could not re-read ${configPath} to run hook '${hookName}'; skipping.`,
    )
    return null
  }

  if (!isTrustedContent(configPath, contents)) {
    if (process.stdin.isTTY) {
      let approved = false
      try {
        approved = promptTrustHooks(configPath)
      } catch {
        // /dev/tty unavailable despite isTTY — fail closed below
      }
      if (!approved) {
        console.error(
          `Skipping hook '${hookName}': ${configPath} was not trusted.`,
        )
        return null
      }
      trustConfigContent(configPath, contents)
    } else {
      console.error(
        `Warning: hooks in ${configPath} are not trusted and no TTY is available to confirm; skipping hook '${hookName}'. Run \`crm config trust ${configPath}\` to allow it.`,
      )
      return null
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: TOML parse output has no static type
  let parsed: Record<string, any>
  try {
    parsed = parseTOML(contents.toString('utf-8'))
  } catch {
    console.error(
      `Warning: could not parse ${configPath} to run hook '${hookName}'; skipping.`,
    )
    return null
  }

  const freshHookCmd = parsed?.hooks?.[hookName]
  return typeof freshHookCmd === 'string' ? freshHookCmd : null
}

export function runHook(
  config: CRMConfig,
  hookName: string,
  data: Record<string, unknown>,
): boolean {
  // config.hooks[hookName] reflects whatever crm.toml looked like when
  // loadConfig() ran, at process start. For an implicitly-discovered
  // config, that in-memory value must never be the thing that actually
  // executes — only used here to short-circuit when no hook of this name
  // was configured at load time (matching prior behavior of not gating
  // hook names that were never defined at all).
  if (!config.hooks[hookName]) {
    return true // no hook = success
  }

  const meta = config._meta
  let hookCmd: string | null

  if (meta && meta.source === 'implicit' && meta.path) {
    hookCmd = resolveTrustedHookCommand(meta.path, hookName)
  } else {
    // Explicitly-supplied configs (`--config` / `CRM_CONFIG`) are a
    // deliberate user action and are exempt from the trust gate — see
    // `resolveConfigPath` in config.ts.
    hookCmd = config.hooks[hookName]
  }

  if (!hookCmd) {
    // Untrusted/unreadable/unparsable/removed hook is skipped, not treated
    // as a pre-hook rejection — the overall command still completes
    // normally (see hooks trust gate docs).
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
