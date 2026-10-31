import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expandTilde } from '../src/expand-tilde.ts'

// Every temporary directory this file creates is removed in afterAll, so the
// suite leaves nothing behind in the system temp directory.
const created: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// `home` is injected, so no test here touches the real home directory or the
// real ~/.crm/crm.db.
const home = makeTempDir('crm-expand-tilde-')

describe('expandTilde: expanded forms (fail before the fix)', () => {
  test('~/x.db resolves under home', () => {
    expect(expandTilde('~/x.db', home)).toBe(join(home, 'x.db'))
  })

  test('~/nested/dir/x.db resolves under home', () => {
    expect(expandTilde('~/.crm/x.db', home)).toBe(join(home, '.crm', 'x.db'))
  })

  test('~\\x.db (Windows separator) resolves under home', () => {
    expect(expandTilde('~\\x.db', home)).toBe(join(home, 'x.db'))
  })

  test('a bare ~ resolves to home', () => {
    expect(expandTilde('~', home)).toBe(home)
  })

  test('~/ with nothing after the separator resolves to home', () => {
    // Decision: a separator with no remainder yields exactly home (no
    // trailing separator), the same as join(home, '').
    expect(expandTilde('~/', home)).toBe(home)
  })
})

// Controls: these pass before AND after the fix. A failure after the fix
// means the implementation expanded too much.
describe('expandTilde: unchanged forms (controls)', () => {
  test('absolute paths are unchanged', () => {
    const abs = join(home, 'abs', 'x.db')
    expect(expandTilde(abs, home)).toBe(abs)
  })

  test('relative paths are unchanged', () => {
    expect(expandTilde('data/x.db', home)).toBe('data/x.db')
    expect(expandTilde('./x.db', home)).toBe('./x.db')
  })

  test('a ~ that is not the first character is unchanged', () => {
    expect(expandTilde('/tmp/a~b', home)).toBe('/tmp/a~b')
    expect(expandTilde('a~/x.db', home)).toBe('a~/x.db')
    expect(expandTilde('./~/x.db', home)).toBe('./~/x.db')
  })

  // Out of scope by design (issue #34): `~user` needs a user-database lookup
  // that has no meaning on Windows, so it is left as written. This is not an
  // unimplemented case.
  test('~user form is out of scope and is not expanded', () => {
    expect(expandTilde('~other/x.db', home)).toBe('~other/x.db')
    expect(expandTilde('~other', home)).toBe('~other')
  })
})

describe('expandTilde: empty path (control)', () => {
  test('an empty path is unchanged', () => {
    expect(expandTilde('', home)).toBe('')
  })
})

// End-to-end: a `~` in the config file's database path must reach the real
// DB-opening code as a home-relative path. The unit tests above would stay
// green even if nothing ever called expandTilde, so this one runs the CLI.
describe('config database path with ~ (end to end)', () => {
  const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

  function runWithConfigPath(
    dbLine: string,
    via: { dbFlag?: string; crmDb?: string } = {},
  ) {
    const fakeHome = makeTempDir('crm-e2e-home-')
    const cwd = makeTempDir('crm-e2e-cwd-')
    const configPath = join(cwd, 'crm.toml')
    writeFileSync(configPath, `[database]\n${dbLine}\n`)
    // Never inherit CRM_DB / CRM_CONFIG from the caller, and point both home
    // variables at the throwaway directory so ~ cannot reach the real home.
    const { CRM_DB: _db, CRM_CONFIG: _cfg, ...rest } = process.env
    const env: Record<string, string | undefined> = {
      ...rest,
      NO_COLOR: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    }
    if (via.crmDb !== undefined) {
      env.CRM_DB = via.crmDb
    }
    const dbArgs = via.dbFlag === undefined ? [] : ['--db', via.dbFlag]
    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        CRM_BIN,
        '--config',
        configPath,
        ...dbArgs,
        'contact',
        'list',
      ],
      { cwd, env },
    )
    return {
      fakeHome,
      cwd,
      exitCode: proc.exitCode,
      stderr: proc.stderr.toString(),
    }
  }

  test('path = "~/x.db" opens the DB under home, not a literal ~ directory', () => {
    const r = runWithConfigPath('path = "~/x.db"')
    expect(r.exitCode).toBe(0)
    // The negative claim comes first: it is the reported bug (a literal ~
    // directory under the working directory), and it must not be hidden by
    // an earlier assertion failing.
    expect(existsSync(join(r.cwd, '~'))).toBe(false)
    expect(existsSync(join(r.fakeHome, 'x.db'))).toBe(true)
  })

  test('path = "~/.crm/x.db" creates missing directories under home', () => {
    const r = runWithConfigPath('path = "~/.crm/x.db"')
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(r.cwd, '~'))).toBe(false)
    expect(existsSync(join(r.fakeHome, '.crm', 'x.db'))).toBe(true)
  })

  // Controls (pass before and after the fix).
  test('an absolute path is used as written', () => {
    const target = join(makeTempDir('crm-e2e-abs-'), 'abs.db')
    const r = runWithConfigPath(`path = ${JSON.stringify(target)}`)
    expect(r.exitCode).toBe(0)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(r.cwd, '~'))).toBe(false)
  })

  test('no path in the config falls back to the default under home', () => {
    const r = runWithConfigPath('')
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(r.fakeHome, '.crm', 'crm.db'))).toBe(true)
    expect(existsSync(join(r.cwd, '~'))).toBe(false)
  })

  // Issue #35: --db and CRM_DB take the same ~ expansion as the config file.
  describe('--db and CRM_DB with ~ (fail before the fix)', () => {
    const BACKSLASH = String.fromCharCode(92)
    const routes = [
      { name: '--db', via: (v: string) => ({ dbFlag: v }) },
      { name: 'CRM_DB', via: (v: string) => ({ crmDb: v }) },
    ]
    for (const route of routes) {
      test(`${route.name} ~/x.db opens the DB under home`, () => {
        const r = runWithConfigPath('', route.via('~/x.db'))
        expect(r.exitCode).toBe(0)
        expect(existsSync(join(r.cwd, '~'))).toBe(false)
        expect(existsSync(join(r.fakeHome, 'x.db'))).toBe(true)
      })

      test(`${route.name} ~\\x.db (Windows separator) opens the DB under home`, () => {
        const r = runWithConfigPath('', route.via(`~${BACKSLASH}x.db`))
        expect(r.exitCode).toBe(0)
        expect(existsSync(join(r.cwd, '~'))).toBe(false)
        expect(existsSync(join(r.fakeHome, 'x.db'))).toBe(true)
      })
    }

    test('--db ~/d.db still beats an absolute CRM_DB, and is expanded', () => {
      const other = join(makeTempDir('crm-e2e-env-'), 'env.db')
      const r = runWithConfigPath('', { dbFlag: '~/d.db', crmDb: other })
      expect(r.exitCode).toBe(0)
      expect(existsSync(join(r.cwd, '~'))).toBe(false)
      expect(existsSync(join(r.fakeHome, 'd.db'))).toBe(true)
      expect(existsSync(other)).toBe(false)
    })
  })

  // Controls (pass before and after the fix): the priority order is
  // --db > CRM_DB > config file, and absolute paths are used as written.
  describe('--db / CRM_DB priority and absolute paths (controls)', () => {
    function absDb(prefix: string) {
      return join(makeTempDir(prefix), 'a.db')
    }

    test('an absolute --db is used as written', () => {
      const target = absDb('crm-e2e-flag-')
      const r = runWithConfigPath('', { dbFlag: target })
      expect(r.exitCode).toBe(0)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(r.cwd, '~'))).toBe(false)
    })

    test('an absolute CRM_DB is used as written', () => {
      const target = absDb('crm-e2e-env-')
      const r = runWithConfigPath('', { crmDb: target })
      expect(r.exitCode).toBe(0)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(r.cwd, '~'))).toBe(false)
    })

    test('--db beats CRM_DB, and CRM_DB beats the config file', () => {
      const fromFlag = absDb('crm-e2e-flag-')
      const fromEnv = absDb('crm-e2e-env-')
      const fromConfig = absDb('crm-e2e-cfg-')
      const cfgLine = `path = ${JSON.stringify(fromConfig)}`

      const all = runWithConfigPath(cfgLine, {
        dbFlag: fromFlag,
        crmDb: fromEnv,
      })
      expect(all.exitCode).toBe(0)
      expect(existsSync(fromFlag)).toBe(true)
      expect(existsSync(fromEnv)).toBe(false)
      expect(existsSync(fromConfig)).toBe(false)

      const envOverConfig = runWithConfigPath(cfgLine, { crmDb: fromEnv })
      expect(envOverConfig.exitCode).toBe(0)
      expect(existsSync(fromEnv)).toBe(true)
      expect(existsSync(fromConfig)).toBe(false)
    })
  })
})
