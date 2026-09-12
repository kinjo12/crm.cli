import { existsSync } from 'node:fs'

import type { Command } from 'commander'

import { resolveConfigPath } from '../config'
import { die, gConfig } from '../lib/helpers'
import { trustConfig, untrustConfig } from '../trust-store'

/** Resolve the target config path for `config trust`/`config untrust` when
 * no explicit path argument is given: respect the same precedence
 * (--config > CRM_CONFIG > implicit discovery) the rest of the CLI uses. */
function resolveTarget(path: string | undefined): string {
  const target = path || resolveConfigPath(gConfig).path
  if (!target) {
    die(
      'Error: no crm.toml found to trust — pass a path explicitly, e.g. `crm config trust ./crm.toml`',
    )
  }
  if (!existsSync(target)) {
    die(`Error: config file not found: ${target}`)
  }
  return target
}

export function registerConfigCommands(program: Command) {
  const cmd = program.command('config').description('Manage crm.toml trust')

  cmd
    .command('trust [path]')
    .description(
      'Trust a crm.toml so its [hooks] run without a confirmation prompt',
    )
    .action((path?: string) => {
      const target = resolveTarget(path)
      trustConfig(target)
      console.log(
        `Trusted ${target} — hooks defined in it will now run without prompting.`,
      )
    })

  cmd
    .command('untrust [path]')
    .description('Revoke trust for a crm.toml')
    .action((path?: string) => {
      const target = resolveTarget(path)
      const removed = untrustConfig(target)
      console.log(
        removed ? `Untrusted ${target}.` : `${target} was not trusted.`,
      )
    })
}
