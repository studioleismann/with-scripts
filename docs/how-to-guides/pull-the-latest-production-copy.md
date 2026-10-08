# Pull the latest production copy

Use this guide to replace an existing local DDEV database and refresh files from a
hosted WordPress site. Local database edits are replaced by the imported state.

## 1. Prepare the local project

Enter the document root containing `.ddev/config.yaml`:

```sh
cd ~/code/projects/example/website
git status
```

For a repository rooted here, commit or stash local work, including untracked files,
until Git reports a clean worktree. Update from its upstream separately if needed.
Preserve local database work and untracked runtime files that you may want later.
The command creates a database snapshot, while Git protection covers tracked files.

A repository containing the project as a subfolder provides no tracked-file
protection to this pull. An existing WordPress installation in that layout requires
`PULL WITHOUT BACKUP`. Prefer a repository rooted at the WordPress document root.

## 2. Run the pull and review its choices

```sh
with-scripts pull-wordpress
```

Check the SSH target, remote root, live URL, and local URL. The wizard suggests saved
settings and the current DDEV hostname. It starts DDEV after confirmation.

Choose whether to delete local files missing from production:

- **No** keeps local-only files and packages. Matching untracked production packages
  are still replaced completely, and other matching untracked files can be overwritten.
- **Yes** also removes local-only unprotected paths. Git-tracked files, complete
  Git-managed theme/plugin packages, and the
  [pull exclusions](../reference/configuration.md#pull-file-exclusions) remain protected.

This choice is asked on every pull and defaults to **No**.

For a clean project repository, confirm **Continue?** with **Yes**. For existing
WordPress files without project-root Git protection, enter the exact text
`PULL WITHOUT BACKUP` after reviewing the file-recovery limit.

## 3. Let the transfer finish

Pull snapshots the local database, downloads and validates files/database, protects
tracked files, replaces untracked packages, generates local DDEV configuration, imports
the database, and replaces URL variants with trusted database-only code. Received-byte counters show download progress.
A stream stops after 90 seconds without new bytes.

The final check reads the database's `home` and `siteurl` values. Imported configuration,
Core, plugins, and themes stay unexecuted throughout local preparation. Import/exec
hooks are skipped. Review imported PHP before opening the local website.

Pull requires a literal table prefix and a dedicated database with InnoDB tables.
URL changes preserve serialized data, GUIDs, Gutenberg markup and Custom CSS. Every
content row, revision and autosave is inventoried before replacement; changed rows
are read back inside a transaction. Unsupported or malformed data stops replacement.

The new `wp-config.php` uses DDEV's `db` database/user/password/host and fresh local
salts. Review and reapply any needed local settings deliberately; production PHP
configuration is treated as source data.

## 4. Review the result

```sh
ddev launch
git status
```

Check the homepage, administration, representative content, and local URLs. Review
any `.gitignore` additions or configuration changes made during local preparation.

For recovery, use [Troubleshoot a WordPress pull](troubleshoot-a-wordpress-pull.md).
For file-protection details, read [Production and local safety](../explanation/production-and-local-safety.md).
