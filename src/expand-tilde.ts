import { homedir } from 'node:os'
import { join } from 'node:path'

// Built at runtime so no backslash escape has to survive in the source text.
const BACKSLASH = String.fromCharCode(92)

/**
 * Expand a leading `~` in a filesystem path to the user's home directory.
 *
 * Only `~` alone, `~/...` and `~\...` are expanded. `~user` forms and any `~`
 * that is not the first character are left untouched: `~user` needs a user
 * database lookup that has no meaning on Windows, and is out of scope.
 */
export function expandTilde(path: string, home: string = homedir()): string {
  if (path === '~') {
    return home
  }
  if (path.startsWith('~/') || path.startsWith(`~${BACKSLASH}`)) {
    return join(home, path.slice(2))
  }
  return path
}
