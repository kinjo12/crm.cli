// Read-only check: after a test run, none of the temporary directories listed
// in the ledger may still exist. Deletes nothing.
//
//   CRM_TEST_LEDGER=<file> bun test --timeout 30000 test/<one file>.test.ts
//   bun scripts/check-test-temp.ts <file>
//
// Exit 0: every ledger path is gone. Exit 1: some remain (each is printed).
// Exit 2: the ledger file could not be read (nothing was checked).
import { lstatSync, readFileSync } from 'node:fs'

const ledgerFile = process.argv[2]
if (!ledgerFile) {
  console.error('usage: bun scripts/check-test-temp.ts <ledger-file>')
  process.exit(2)
}

let text: string
try {
  text = readFileSync(ledgerFile, 'utf-8')
} catch (e) {
  console.error(`cannot read ledger ${ledgerFile}: ${(e as Error).message}`)
  process.exit(2)
}

// Only ENOENT counts as gone; a path that cannot be examined is reported.
function isGone(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

const paths = [...new Set(text.split(/\r?\n/).filter((l) => l.length > 0))]
const remaining = paths.filter((p) => !isGone(p))
for (const p of remaining) {
  console.log(`STILL EXISTS: ${p}`)
}
console.log(`ledger entries: ${paths.length}, remaining: ${remaining.length}`)
process.exit(remaining.length > 0 ? 1 : 0)
