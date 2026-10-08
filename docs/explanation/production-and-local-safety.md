# Production and local safety

Each workflow protects a different kind of change. A database snapshot, Git history,
and a full file backup cover different recovery needs.

## Effects and recovery points

| Operation | Main writes | Recovery provided by this implementation |
| --- | --- | --- |
| Inspection | Optional local connection defaults | Remote inspection uses read operations |
| DDEV setup | Local defaults, DDEV config, project WP-CLI wrapper, DDEV runtime | Existing project files need their own protection |
| Pull | Local files/configuration/database | Database snapshot; tracked-file archive restored during normal extraction/error handling |
| Local configuration | Local database, language/plugin/theme files, `wp-config.php` | Optional existing-site database snapshot |
| Theme setup | Theme files, shared plugin files, activation state | Existing-theme branch/snapshot/file backup; theme-file restoration during preparation failures |
| Tool synchronization | Shared-source build output, theme/plugin runtimes, activation | Operator-managed backups |
| Deployment setup | Dedicated key, repository secrets, workflow/defaults | Existing differing workflow is preserved; partial key/secret changes remain |
| Full-site push | Explicit remote database and managed runtime | Original target database/files and rollback handler through scripted checks |
| Release deployment | Selected remote custom-code files | Operator-managed deployment recovery |

## Inspection and pull use the server as a source

Inspection reads environment information. Pull streams a database dump and file
archive directly into private local storage. Its remote scripts create no archive
files or deliberate database/file mutations on the server.

The dump reads the database named in `wp-config.php` using `--single-transaction`,
`--quick`, `--skip-lock-tables`, and `--no-tablespaces`. Transactional tables benefit
from the dump's consistent transaction; file contents and nontransactional tables
can change during the transfer. A detected `tar` changed-file error stops the pull
before local replacement and asks for a retry.

Pull imports that database locally, then runs database-only URL replacement across
its WordPress tables. A fresh DDEV configuration replaces source-controlled PHP
configuration. GUIDs and Custom CSS stay byte-identical. All content, revisions and
autosaves are inventoried and hashed before replacement; every changed row is read
back in the transaction. Imported WordPress PHP and import/exec hooks stay unexecuted.

## Git protection has a specific boundary

A clean Git repository rooted at the document root enables tracked-file protection.
An ancestor repository or a separate theme repository alone does not enable it.
Uncommitted and untracked files stop a protected pull.

A plugin/theme package with any tracked file is preserved as a complete package.
Other tracked files are archived before extraction and restored afterward. Subsequent
local preparation intentionally regenerates `wp-config.php` and append `.gitignore`
lines. Keep credentials in ignored configuration files.

An ignored file is still untracked. Matching untracked production packages are
replaced completely; other matching untracked files can be overwritten. With mirror
cleanup enabled, untracked local-only files can also be deleted unless they are in
the explicit [exclusion list](../reference/configuration.md#pull-file-exclusions) or
a protected package.

For example, `.with-scripts-backups/` is outside that exclusion list. Preserve needed
theme backups outside the pull's project tree before enabling mirror cleanup. Adding
an ignore rule prevents accidental tracking; it does not add pull protection.

## Snapshots protect the database

Pull creates a named snapshot before downloads and local replacement. A database
import or later failure prints its restore command. It leaves file recovery to Git
and other backups because files have already been copied before database import.

Local configuration offers a snapshot for an existing site. Theme replacement creates
one before moving the old theme. These snapshots cannot restore plugin files,
language files, or configuration changes. Local configuration and shared-tool sync
have no automatic rollback of their complete workflow.

## Full-site push verifies its own content manifest

Push inventories every stored post row, including revisions/autosaves, with hashes,
block CSS values, paths, and classes. The export changes matching local URL variants
while preserving JSON CSS strings. It verifies the prepared/imported content against
that expected result, without parsing and reserializing block markup for storage.
Local URLs inside protected CSS intentionally remain and need their own review.

The target gets a private sibling workspace, upload checksums, a lock, original
content inventory, and file/database backups. Database table names/counts and
imported settings and component files are checked by bundled code; HTTPS endpoints
are tested through the web runtime. The SSH transaction never loads site PHP. The rollback handler covers failures through those checks.
The [push guide](../how-to-guides/push-a-local-wordpress-site.md) describes exactly
what is verified and how to inspect recovery state.

This auditing is narrower than checking every possible plugin setting, external
service, or concurrent write. Keep both sites idle, review site-specific configuration,
and perform acceptance checks after transfer. A lost connection requires inspecting
the retained status; a missing completion message cannot establish rollback success.

## Deployment setup and release are separate boundaries

The setup wizard verifies a dedicated private key and a server host key selected from
an independent trusted fingerprint. It checks paths and writes GitHub secrets only
after repository confirmation and verification of the published commit. Keys and earlier secret writes can remain if a
later step fails. Successful secret-name listing cannot reveal or compare the stored
secret values.

The site template builds on an unprivileged runner and deploys its digest-checked
artifact on a fresh runner using control code from the immutable workflow revision.
Actions use full commit pins. Automatic setup rejects unmanaged workflows before
provisioning secrets. Component transactions and HTTP checks provide the recovery
boundary described in the generated deployment guide. The older theme-only templates
use pinned Actions and retain their existing direct-copy deployment behavior.

## Temporary data and interruption

Pull stores private downloads in a mode-`0700` temporary directory, with stream files
created as `0600`. Push uses a private local package and a private remote workspace.
Normal error/success paths clean local temporary data; `--prepare-only` deliberately
retains the local push package. Full-site push retains the remote original backups.

These locations can contain site data and configuration. A forced process kill or
machine interruption may bypass cleanup. Inspect recovery state, then remove
unneeded retained data deliberately. Never put those temporary files or private
configuration into Git.
