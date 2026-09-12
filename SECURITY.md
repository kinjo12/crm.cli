# Security

This is a personal, security-hardened fork of
[dzhng/crm.cli](https://github.com/dzhng/crm.cli). It is not affiliated with
the upstream project or its maintainers.

## Reporting a vulnerability

Open an issue in [this fork's issue tracker](https://github.com/kinjo12/crm.cli/issues).
This is a small, single-maintainer fork with no dedicated security contact or
bug bounty — please report in good faith and allow reasonable time for a fix
before public disclosure of exploit details.

If the same issue also affects upstream `dzhng/crm.cli`, please report it
there as well; fixes in this fork are not automatically upstreamed.

## Fixed vulnerabilities

The write-ups below are intentionally high-level. They describe the class of
vulnerability, its impact, and the fix — not a working exploit — since
upstream `dzhng/crm.cli` may still be affected. See the linked PR for the
full diff and test coverage of each fix.

### 1. Unscoped `crm.toml` resolution and unconditional hook execution

- **Severity:** Critical
- **Affected versions:** All versions prior to this fix.
- **Fixed in:** [PR #5](https://github.com/kinjo12/crm.cli/pull/5) ([Issue #1](https://github.com/kinjo12/crm.cli/issues/1))

**Summary:** The CLI located its `crm.toml` configuration file by walking up
parent directories from the current working directory, with no check that
the discovered file actually belonged to a project the user had opened
intentionally. A `crm.toml` can define `hooks` that run arbitrary shell
commands on certain CLI actions. A config file placed anywhere between a
victim's working directory and the filesystem root — for example in a
shared temporary directory, an extracted archive, or a cloned repository —
could therefore get its hooks executed the next time the victim ran `crm`
from within or below that location, without any prompt or confirmation.

**Fix:** Config discovery is now scoped to an actual git repository
(verified via `git rev-parse --show-toplevel`) rather than an arbitrary
directory walk. Any config that was not explicitly selected via
`--config`/`CRM_CONFIG` is now subject to a trust-on-first-use gate before
its hooks may run: the first time a given config's content is seen, the
user is prompted for confirmation (or, when no interactive terminal is
available, hooks are skipped with a warning rather than silently executed).
The decision is remembered by content hash, so a config can't silently swap
in different hook commands after being trusted once.

### 2. Path traversal in `crm export-fs`

- **Severity:** High
- **Affected versions:** All versions prior to this fix.
- **Fixed in:** [PR #8](https://github.com/kinjo12/crm.cli/pull/8) ([Issue #2](https://github.com/kinjo12/crm.cli/issues/2))

**Summary:** `crm export-fs` builds output file and directory names directly
from stored data — email, phone, tags, social handles, deal stage, activity
type, and, in some code paths, a record's own database ID — without
neutralizing path-traversal sequences in those values. Values that reach
the database through a less-strictly-validated path than the primary CLI
commands (for example `crm import`, or direct programmatic writes) could
contain a value designed to escape the intended export directory, causing
`export-fs` to write a file elsewhere on the filesystem.

**Fix:** Every such value is now sanitized before being used as a filename
or directory-name segment, and every path assembled from user-controlled
values is additionally verified to resolve to a location inside the target
export directory before any file is written; a value that would escape is
skipped with a warning instead of being written outside the directory.

### 3. JSON-protocol injection in the FUSE client

- **Severity:** Critical
- **Affected versions:** All versions prior to this fix.
- **Fixed in:** [PR #10](https://github.com/kinjo12/crm.cli/pull/10) ([Issue #3](https://github.com/kinjo12/crm.cli/issues/3))

**Summary:** `crm mount` is backed by a small C FUSE client
(`fuse-helper.c`) that forwards every filesystem operation to a companion
daemon process over a local socket, using a simple JSON-per-line protocol.
The path being accessed was embedded into each JSON request without being
escaped, even though the same file already escaped file *contents* the same
way. Because FUSE passes through almost any byte sequence a caller uses as a
path, a specially-crafted path accessed under an active mount — including
via an ordinary, read-only filesystem call — could alter the meaning of the
request the daemon received, causing it to carry out a different, more
consequential operation than the one actually requested.

**Fix:** The path value is now always escaped using the same routine
already used for file contents before being embedded in a request to the
daemon, and the buffers used to build these requests are sized dynamically
so that escaping a long or unusual path can never overflow or silently
truncate the request.
