# Changelog

All notable changes to this fork are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This fork
tracks security and correctness fixes on top of
[dzhng/crm.cli](https://github.com/dzhng/crm.cli); it does not attempt to
mirror upstream's own release history.

## [Unreleased]

### Security

- **Escaped FUSE client request paths, closing a JSON/protocol injection.**
  The FUSE C client (`fuse-helper.c`) embedded the accessed path directly
  into JSON requests sent to its companion daemon without escaping it. A
  path containing a double quote could inject additional fields into the
  same request, letting a read-only operation (e.g. reading file attributes)
  be reinterpreted by the daemon as a different, destructive operation. The
  path is now always escaped before being sent, matching the escaping
  already applied to written file contents. See
  [SECURITY.md](SECURITY.md#3-json-protocol-injection-in-the-fuse-client) for
  details. (#3)

- **Sanitized user-controlled values used as filesystem paths in
  `crm export-fs`.** Several database fields (email, phone, tags, social
  handles, deal stage, activity type, and in some code paths a record's own
  ID) were used to build output file and directory names without
  neutralizing path-traversal sequences, allowing a crafted value to write a
  file outside the intended export directory. All such values are now
  sanitized, and every generated path is verified to stay contained within
  the export directory before use. See
  [SECURITY.md](SECURITY.md#2-path-traversal-in-crm-export-fs) for details.
  (#2)

- **Scoped `crm.toml` config resolution to the current project and added a
  trust-on-first-use gate before running config-defined hooks.** Config
  discovery previously walked up parent directories with no verification
  that the discovered file belonged to a project the user actually trusted,
  and a config's `hooks` section can run arbitrary shell commands. Config
  discovery now requires a real git repository, and any config that wasn't
  explicitly pointed to via `--config`/`CRM_CONFIG` must be explicitly
  trusted (by content hash) before its hooks are allowed to run. See
  [SECURITY.md](SECURITY.md#1-unscoped-crmtoml-resolution-and-unconditional-hook-execution)
  for details. (#1)

### Fixed

- **A missing or non-file `--config`/`CRM_CONFIG` path now fails clearly
  instead of silently falling back to defaults.** Previously, an explicitly
  specified config path that didn't exist — or that existed but wasn't a
  regular file (e.g. a directory) — was silently ignored: it fell through to
  the same error handling used for genuine TOML syntax errors, printing a
  misleading `Warning: could not parse config file <path>` while quietly
  continuing with default config values. `crm` now exits immediately with
  `Error: config file not found: <path>` when an explicit `--config`/
  `CRM_CONFIG` path doesn't exist or isn't a regular file. Implicit config
  discovery (no flag/env var given) is unaffected and still auto-creates a
  default config on first run. (#30)
