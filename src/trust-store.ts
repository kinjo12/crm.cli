import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Local trust-on-first-use (TOFU) ledger for implicitly-discovered
 * `crm.toml` files, keyed on the config's canonical absolute path plus a
 * content hash. This is what direnv/mise call "trusting" a config: hooks
 * defined in an implicitly-discovered config only run after the user has
 * explicitly approved that exact file content.
 *
 * This file stores only paths and sha256 hashes — never config content —
 * and is never read as a source of CRM configuration. It does not
 * reintroduce the removed `~/.crm/config.toml` global-config fallback.
 */

export const TRUST_STORE_PATH = join(homedir(), '.crm', 'trusted_configs.json')

type TrustStoreData = Record<string, string>

/**
 * Resolve to an absolute, symlink-resolved path so trust-store keys are
 * stable regardless of how the config path was spelled on the command line.
 * Falls back to a plain absolute path if the file doesn't exist (e.g. it
 * was deleted after being trusted).
 */
function canonicalPath(configPath: string): string {
  try {
    return realpathSync(configPath)
  } catch {
    return resolve(configPath)
  }
}

/** Hash already-read file bytes. See `hashFile` for the read+hash variant. */
export function hashBuffer(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function hashFile(configPath: string): string {
  return hashBuffer(readFileSync(configPath))
}

function loadTrustStore(): TrustStoreData {
  try {
    const raw = readFileSync(TRUST_STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TrustStoreData
    }
  } catch {
    // missing, unreadable, or invalid JSON — treat as an empty store
  }
  return {}
}

function saveTrustStore(store: TrustStoreData): void {
  mkdirSync(dirname(TRUST_STORE_PATH), { recursive: true })
  writeFileSync(TRUST_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`)
}

/**
 * Whether `configPath`'s current on-disk content matches a previously
 * recorded trust entry. Returns `false` if the file was never trusted, no
 * longer exists, or its content has changed since it was trusted (hash
 * mismatch = untrusted, forcing re-trust).
 */
export function isTrusted(configPath: string): boolean {
  if (!existsSync(configPath)) {
    return false
  }
  const store = loadTrustStore()
  const trustedHash = store[canonicalPath(configPath)]
  if (!trustedHash) {
    return false
  }
  try {
    return hashFile(configPath) === trustedHash
  } catch {
    return false
  }
}

/** Record `configPath`'s current content hash as trusted. */
export function trustConfig(configPath: string): void {
  trustConfigContent(configPath, readFileSync(configPath))
}

/**
 * Whether `contents` (bytes already read by the caller) matches a
 * previously recorded trust entry for `configPath`. Unlike `isTrusted`,
 * this performs no file I/O of its own — callers that need the trust
 * decision and the executed content to come from the exact same read
 * (e.g. the hooks TOCTOU gate in hooks.ts) should read the file once and
 * pass those bytes here rather than calling `isTrusted`, which re-reads
 * the file independently.
 */
export function isTrustedContent(
  configPath: string,
  contents: Buffer,
): boolean {
  const store = loadTrustStore()
  const trustedHash = store[canonicalPath(configPath)]
  if (!trustedHash) {
    return false
  }
  return hashBuffer(contents) === trustedHash
}

/**
 * Record already-read `contents` as the trusted content for `configPath`.
 * See `isTrustedContent` for why callers may want this over `trustConfig`.
 */
export function trustConfigContent(configPath: string, contents: Buffer): void {
  const store = loadTrustStore()
  store[canonicalPath(configPath)] = hashBuffer(contents)
  saveTrustStore(store)
}

/** Remove `configPath` from the trust store. Returns whether it was present. */
export function untrustConfig(configPath: string): boolean {
  const key = canonicalPath(configPath)
  const store = loadTrustStore()
  if (!(key in store)) {
    return false
  }
  delete store[key]
  saveTrustStore(store)
  return true
}
