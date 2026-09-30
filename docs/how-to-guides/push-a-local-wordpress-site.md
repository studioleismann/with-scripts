# Push a local WordPress site

Replace a dedicated remote WordPress installation with the local DDEV database and
runtime files. Each push replaces target accounts, content, settings, plugins,
themes, and uploads. Repeated pushes use the same review and backup process.

## 1. Prepare both sites

Start DDEV and verify the local site. Keep the local and target sites idle through
the transfer so background edits and customer activity cannot race with the export
or backup.

The [target requirements](../reference/requirements.md#full-site-push-target) include
an installed single-site WordPress site, dedicated database, public HTTPS domain-root
URL, standard content directory, and matching PHP major/minor versions. Configure
HTTPS and permalink handling at the host first. Choose a hosting-specific CLI
interpreter through `--php=/absolute/path/to/php` if needed.

Review the local files, installed dependencies, content, and accounts you intend to
publish. The current working copy supplies files, including uncommitted changes.
Git-tracked themes/plugins with build scripts build in a disposable copy using their
installed local `node_modules`. Other packages use their existing runtime files.

The target's database credentials, salts, and server configuration are retained.
Its `wp-config.php` is reused with the source table prefix. Existing `.htaccess`
is kept; absent rules are generated through WordPress. Review custom absolute paths
or other host-specific constants in that configuration.

The complete target `wp-content` directory is replaced. The upload includes plugins,
themes, mu-plugins, languages, uploads, and a content index, but excludes local
content-root drop-ins such as `db.php` and `object-cache.php`. Target drop-ins also
leave the runtime with the replaced directory. Review a separate adaptation before
using a site that depends on them. See the [exact payload and filters](../reference/configuration.md#push-runtime-filter).

## 2. Run the read-only preflight

From the DDEV document root:

```sh
with-scripts push-wordpress \
  --ssh=example-host \
  --root=/srv/example/httpdocs \
  --url=https://example.org \
  --dry-run
```

Add the selected `--php` option when the host's default `php` differs from DDEV.
The preflight inventories local content and reads the target. It verifies matching
PHP versions and target database URLs, among other checks. It performs no build,
package upload, backup, or replacement.

Saved defaults, if desired, belong in `wordpressPush` in `.with-scripts.json`.
Maintain that section manually; the command reads it but never saves it. The pull
source is independent of the push target.

## 3. Prepare locally or run the push

To examine the package without contacting the target, replace `--dry-run` with
`--prepare-only`. This still needs the intended target values for URL export. It
builds/exports locally and prints a retained private directory containing site data.
Inspect it and remove it when finished. It is a preparation result; a later normal
push builds a fresh package and performs its own checks.

For the actual push, rerun the reviewed command without either preview flag:

```sh
with-scripts push-wordpress \
  --ssh=example-host \
  --root=/srv/example/httpdocs \
  --url=https://example.org
```

Review source/target/root/URL and the replacement summary. After packaging, type the
exact `PUSH https://example.org` confirmation for that target. A final `--yes` bypass
is unavailable. Declining at this point discards the temporary local package before
any upload.

## 4. Understand the checks during transfer

The local export uses WP-CLI's
[`search-replace --export`](https://developer.wordpress.org/cli/commands/search-replace/)
to change URLs in SQL output while retaining the local database. The implementation
includes prefixed plugin tables, serialized values, escaped URL variants, exact host
boundaries, and `guid` exclusion.

The push audits all stored post rows, including revisions and autosaves, with SHA-256
content hashes. It inventories `attrs.style.css` with block path and `className` and
checks expected URL-only content changes without reserializing Gutenberg blocks.
JSON CSS strings stay byte-identical, so local URLs inside Custom CSS stay unchanged
and need deliberate review. A stored `has-custom-css` class in block `className`
stops the audit.

Before upload it verifies exported table names and re-reads the source manifest.
This catches changes to audited content/settings and table counts; it is not a
transaction lock or a hash of every value in every plugin table.

On the target, the command:

1. Rechecks the target and creates a private sibling workspace plus a shared parent lock.
2. Verifies uploaded SHA-256 checksums and tests that HTTPS serves the chosen root
   using a temporary random probe file.
3. Inventories the original content/CSS, enters maintenance, and backs up the target
   database, root files, and configuration outside the document root.
4. Validates archives and rechecks original content before importing the replacement.
5. Checks imported table names/counts, exact content hashes, protected CSS, and key
   settings before switching runtime files.
6. Loads WordPress with its theme/plugins before and after the switch, then checks
   HTTPS and content again under the rollback handler.

The homepage and login checks require HTTP `200`, a nonempty response, and absence
of the specific fatal/database-error strings checked by the script. If a published
page is available, its permalink must return `200`. Redirects are not followed by
these push checks. They establish the scripted conditions; complete functionality
and visual review remain separate.

## 5. Review the published site and retain its backup

After success, review the frontend, administration, media, plugin behavior, scheduled
jobs, and host-specific services. Local users/settings are now the target's state.
The command prints the retained remote `rollback/` path.

The workspace is created beside the document root with private permissions. Use a
hosting layout where that parent directory is outside all publicly served roots.
The lock is shared by sibling sites under that parent. Plan space for the package,
full backup, and candidate runtime. Local temporary data is removed on normal
completion; original target backups remain until you deliberately clean them up.

## Recover after failure or interruption

When the remote handler catches a failure, it attempts to restore the original
managed paths and database, then verifies original content/CSS when database import
had started. Its status file is the first place to inspect:

| Workspace `status` | Meaning |
| --- | --- |
| `UPLOADING` | Workspace exists; the transaction has not advanced to preparation |
| `UPLOAD_FAILED` | Upload failed before dispatch; the unused lock release was attempted |
| `PREPARING` | Target checks, backup, or runtime preparation started; inspect the process and files |
| `APPLYING` | Database replacement started; runtime switch/checks may be incomplete |
| `ROLLED_BACK` | The recovery handler completed; an imported database was restored and its original content verified, or replacement had not begun |
| `ROLLBACK_FAILED` | At least one recovery step failed; recovery data and lock remain |
| `VERIFIED` | Scripted content/runtime/HTTPS checks passed; original backups remain |

An SSH disconnect can prevent a trustworthy final result. Inspect the retained
workspace and any running process before retrying or removing its lock. Early
errors can also leave a workspace before the rollback handler was installed.

Recovery files include `rollback/database.sql.gz`, `rollback/files.tar.gz`,
`rollback/wp-config.php`, and `rollback/content.json`. A failed automatic recovery
needs those matching database/files/configuration backups restored together. Verify
maintenance state, retain the workspace, and verify restored content through the
retained audit script/WP-CLI before reopening the site. Manual recovery is an
operator procedure; the CLI has no general rollback subcommand.

Keep successful backups until acceptance and your retention requirements are met.
Clean up the printed workspace deliberately after review.
