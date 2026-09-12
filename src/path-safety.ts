import { join, resolve, sep } from 'node:path'

// Control characters (including NUL) — never valid in a filename on any
// supported platform, and NUL specifically truncates paths in native APIs.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control characters to strip them from untrusted path segments
const CONTROL_AND_NUL = /[\x00-\x1f]/g
// Characters that are invalid in Windows filenames. Since this fork runs on
// Windows, leaving these in would make `export-fs` fail with a confusing
// filesystem error instead of a security-relevant one.
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/g
// Path separators, both POSIX and Windows — the actual mechanism that would
// let a segment escape the directory it's being placed into.
const PATH_SEPARATORS = /[\\/]/g
// The literal ".." sequence. Neutralized independently of PATH_SEPARATORS
// as defense-in-depth: even if some future call site reintroduces separators
// after sanitizing, a lone ".." segment can't be (re)combined into a
// parent-directory reference.
const PARENT_DIR_SEQUENCE = /\.\./g
// Windows silently strips trailing dots/spaces from path components, which
// can otherwise cause a filename to mismatch the value that was intended.
const TRAILING_DOTS_OR_SPACES = /[. ]+$/

/**
 * Sanitize a single path segment derived from user-controlled database
 * fields (email, phone, tag, social handle, website, activity type, etc.)
 * so it's always safe to use as a file or directory name.
 *
 * Normal filename-safe values (emails, E.164 phone numbers, @handles,
 * domains, tags) are returned byte-for-byte unchanged — this is what keeps
 * the documented `_by-email` / `_by-phone` / etc. lookup UX working. Only
 * characters that are structurally dangerous (path separators, the literal
 * `..` sequence) or invalid on a supported OS (NUL/control characters,
 * Windows-reserved characters) are altered.
 *
 * Never returns an empty string: if sanitizing would otherwise produce one
 * (e.g. the input was only `/`, `..`, or Windows-invalid characters), falls
 * back to `'unknown'`, matching the convention `slugify()` in fuse-json.ts
 * already uses for empty/missing values.
 */
export function sanitizeFilenameSegment(
  value: string | null | undefined,
): string {
  const sanitized = (value ?? '')
    .replace(CONTROL_AND_NUL, '')
    .replace(WINDOWS_INVALID_CHARS, '')
    .replace(PATH_SEPARATORS, '_')
    .replace(PARENT_DIR_SEQUENCE, '_')
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES, '')

  return sanitized || 'unknown'
}

/**
 * Join `base` with one or more untrusted path segments, sanitizing each
 * segment first and then verifying — via `path.resolve()` — that the
 * resulting path still lives inside `base` before returning it.
 *
 * This is defense-in-depth on top of `sanitizeFilenameSegment`: sanitization
 * alone should already make escaping `base` impossible, but this guards
 * against any future regression or an edge case the sanitizer misses.
 *
 * Returns `null` (and logs a warning) instead of throwing when containment
 * fails, so callers can skip that particular write and continue the export
 * rather than aborting the whole run.
 */
export function safeJoin(base: string, ...segments: string[]): string | null {
  const sanitizedSegments = segments.map(sanitizeFilenameSegment)
  const candidate = join(base, ...sanitizedSegments)
  const resolvedBase = resolve(base)
  const resolvedCandidate = resolve(candidate)

  if (
    resolvedCandidate !== resolvedBase &&
    !resolvedCandidate.startsWith(resolvedBase + sep)
  ) {
    console.error(
      `Warning: skipping write outside export directory: ${join(...segments)}`,
    )
    return null
  }

  return candidate
}
