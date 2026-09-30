# Troubleshoot a WordPress pull

Read the command's final error and the tool output directly above it. The final
state message tells you whether file replacement or database import had started.

## SSH or remote-root failure

Test the configured alias outside the wizard:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 example-host true
```

For `Permission denied (publickey)`, check the alias, agent, and public key installed
for the remote account. For host-key errors, verify the server identity through your
normal trusted SSH setup. Remote commands use key authentication.

Verify the WordPress root through a normal SSH session and `pwd`. It must contain
`wp-config.php`, `wp-admin`, `wp-content`, and `wp-includes`. Inspection/setup/pull
accept a safe `~/public_html` path as well as an absolute path.

For **Production preflight failed**, look for the named missing tool or path in the
preceding output. Pull requires remote PHP, `mysqldump`, `gzip`, and `tar`; environment
inspection also needs `mysql`.

## Remote WP-CLI or database configuration

Remote WP-CLI is optional. The PHP fallback reads literal configuration values.
If fallback parsing fails, inspect how the site's database constants and table prefix
are defined, or make working WP-CLI available on the host. `DB_HOST` must use `host`
or `host:port`; the current parser does not support socket paths.

## Missing or stopped DDEV

Run from the directory containing `.ddev/config.yaml`. If it is absent, use:

```sh
with-scripts setup-wordpress
```

For startup or snapshot failures, resolve the DDEV/Docker error above the message.
Those stages precede replacement of local WordPress files/database. During setup,
a macOS password prompt is for the local administrator account; invisible input is
normal. If setup stopped after writing configuration, inspect that configuration
before rerunning or starting DDEV.

## Local Git changes

```sh
git status
git diff
```

Commit or stash the work you intend to preserve. Untracked files also make the
project-root repository dirty. Ignore only files that genuinely belong outside
version control. A Git repository in an ancestor or only inside a theme does not
provide whole-project pull protection.

## Unexpected local hostname

Compare `.ddev/config.yaml` (`name`, `project_tld`) with the saved
`wordpressPull.localUrl`. A saved custom domain stays the default; a matching old
`.ddev.site` URL is regenerated with the current project TLD. Override the URL at
the prompt if necessary and keep DDEV routing consistent with it.

## Download failure

| Error stage | Next action | Local WordPress state |
| --- | --- | --- |
| Production files changed during download | Retry after the changing process settles | Files/database replacement has not started |
| Database or file download failed | Inspect SSH, remote permissions, and database access | Replacement has not started |
| Download stalled | Check the connection; streams stop after 90 seconds without new bytes | Replacement has not started |
| Archive incomplete or invalid | Check disk space and retry the download | Replacement has not started |
| Secure temporary storage or tracked-file backup failed | Check local space and permissions | Replacement has not started |

Settings may already have been saved and a local snapshot created. Failed download
files are removed during normal error cleanup.

## File cleanup, extraction, or configuration failure

The command distinguishes partially replaced files from completed copying. When
extraction fails, its normal error path still attempts to restore the saved
Git-tracked archive. If that restoration also fails, restore the tracked state
through Git before continuing. Untracked files need your separate backup.

The configuration backup is made **after production extraction and tracked-file
restoration**, immediately before patching `wp-config.php`. A failed PHP syntax
check restores that pre-patch copy when possible. It is not a backup of every
pre-pull local file. The error states whether this restoration succeeded.

The later preparation steps may add `.gitignore` lines and move `.maintenance` to
`.maintenance.production-copy`. Review these files alongside the reported state.

## Import, URL replacement, or final-check failure

Once database import starts, the error prints the exact snapshot restore command.
Use that command, or list the available snapshots:

```sh
ddev snapshot --list
```

Restore the chosen `before-pull-...` snapshot using its complete name:

```text
ddev snapshot restore <exact-snapshot-name>
```

Restoration replaces the current local database with the snapshot. Review file state
separately because files are copied before import. A snapshot contains database
state; Git or another backup supplies file recovery.

## Interrupted process

Normal success/error handling removes temporary downloads. A forced termination or
machine interruption can prevent cleanup and final recovery output. Inspect project
files and available snapshots before retrying. Temporary `with-scripts-*` directories
can contain a database dump and production configuration; retain only what you need
for recovery and remove leftovers deliberately.

The safety explanation covers [what each backup protects](../explanation/production-and-local-safety.md).
