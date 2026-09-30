# Synchronize shared tools

Update a compatible customer theme's With Patterns runtime and the local With Theme
Tools and With Site Tools plugins from their current source checkouts.

## Prepare the repositories

Prepare all [shared sources](../reference/requirements.md#shared-tool-repositories)
and their dependencies. Review/update each source checkout separately; synchronization
uses its current files and performs no Git fetch.

For sources outside the default layout, pass `--patterns-source=<path>`,
`--theme-tools-source=<path>`, and `--site-tools-source=<path>`. Each path is resolved
from your working directory. The Patterns build source should match the source
already installed as the theme dependency; sync keeps that dependency assignment.

Start DDEV and preserve any local changes in the theme and target plugins. The sync
has no confirmation prompt, clean-Git requirement, automatic snapshot, or rollback.
Its build/check/sync scripts run sequentially, so a later failure can follow earlier
successful changes.

## Select the target

From the WordPress document root, specify the theme:

```sh
ddev start
with-scripts sync-tools --slug=example-theme --dry-run
```

Omitting `--slug` at the project root reads WordPress's active `stylesheet` option.
From `wp-content/themes/example-theme`, the current directory always selects the
theme, including when a slug option is present.

The dry run checks local WordPress, the theme Patterns runtime, the Theme Tools source
version and installed plugin status, and the Site Tools runtime. It skips builds and
synchronization. A failed check is useful information about what needs attention;
it is not a preview of every byte that would change.

## Apply the sync

```sh
with-scripts sync-tools --slug=example-theme
```

The sequence is:

1. Build/check the With Patterns source, then check/sync/check the theme runtime.
2. Build `dist/with-theme-tools.zip` and unzip it over `wp-content/plugins/with-theme-tools`.
3. Build the With Site Tools source, then check/sync/check
   `wp-content/plugins/with-site-tools`.
4. Activate With Theme Tools, followed by With Site Tools.

With Patterns remains a theme dependency. Both Tools packages run as independent
plugins. Theme Tools installation overlays the ZIP onto its target; stale files in
the local plugin directory are not explicitly deleted. Inspect unexpected leftover files
when investigating version problems.

## Verify in WordPress

Run the checks again:

```sh
with-scripts sync-tools --slug=example-theme --dry-run
```

Then review the local frontend, Site Editor, and relevant plugin administration.
The dry run reports its scripted checks; it does not compare all installed Theme
Tools files against the ZIP or verify rendered editor behavior.

If a step fails, read the last completed task to establish what changed. Restore
necessary files and activation state from your own backups before retrying. An
activation failure can occur after all runtime files have been synchronized.
