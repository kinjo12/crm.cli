import { homedir } from 'node:os'

/**
 * Expand a leading `~` in a filesystem path to the user's home directory.
 *
 * Only `~` alone, `~/...` and `~\...` are expanded. `~user` forms and any `~`
 * that is not the first character are left untouched.
 *
 * NOTE: placeholder with the current (unexpanded) behaviour so the tests for
 * issue #34 can be committed and observed failing first.
 */
export function expandTilde(path: string, _home: string = homedir()): string {
  return path
}
