# Set up a customer theme

Create a personalized copy of With Base in a local DDEV WordPress project. The
command also sets up With Patterns and installs/activates With Theme Tools and With
Site Tools from their local source repositories.

## Prepare the project and sources

Start DDEV and confirm that WordPress is installed:

```sh
ddev start
ddev wp core is-installed --skip-plugins --skip-themes
```

For a new site, complete the installer at the local `/wp-admin/install.php` first.
Prepare a local With Base starter directory, the three
[shared source repositories](../reference/requirements.md#shared-tool-repositories),
and their dependencies. Use sources that you control or have permission to use.
For shared tools in another layout, pass `--patterns-source=<path>`,
`--theme-tools-source=<path>`, and `--site-tools-source=<path>` alongside `--source`.
The selected Patterns source is installed as the new theme's development dependency.

Run from the DDEV document root or an immediate theme root. A new theme is created
under `wp-content/themes/<slug>`. Source paths are resolved from where you run the
command.

## Preview a new theme

```sh
with-scripts setup-theme --name="Example Theme" --slug=example-theme --source=/path/to/with-base --dry-run
```

The preview reads the local source and prints source commit, target, name, slug,
local URL, and whether a target already exists. It skips WordPress installation
checks and project writes. Omit `--source` to enter the directory at the prompt.

Replace the source path with a theme directory containing `style.css`, `theme.json`,
and `package.json`. This uses that directory's current files, including local edits;
the displayed Git commit identifies its repository state only.

## Create and activate the theme

```sh
with-scripts setup-theme --name="Example Theme" --slug=example-theme --source=/path/to/with-base
```

Confirm the final plan. Setup copies and personalizes With Base, installs the local
Patterns dependency, runs Patterns setup and tool synchronization, builds the theme,
runs its CSS/JavaScript lint scripts, and activates it. Shared plugin activation
occurs during synchronization, before the final theme build and activation.

Check the frontend, Site Editor, templates, and saved Global Styles. The copy changes
With Base identity forms while retaining independent shared-tool names. Customer
features and stored WordPress content require their own migration.

For a new theme, add the result to the appropriate project repository yourself.
Setup creates files but does not initialize Git. `--yes` can skip the final plan
confirmation when name, slug, and source are supplied; normal source, WordPress, and backup
checks still apply.

## Replace an existing theme

Replacement applies only when the existing theme is **its own Git repository** with
a completely clean worktree and a valid `HEAD`. A theme tracked only by the website
repository does not meet that requirement.

From the theme directory, inspect its Git root and changes:

```sh
git rev-parse --show-toplevel
git status --short --untracked-files=all
```

Commit or otherwise preserve intentional work. Then preview:

```sh
with-scripts setup-theme --name="Example Theme" --slug=example-theme --source=/path/to/with-base --replace-existing --dry-run
```

The preview identifies the replacement. Git cleanliness and backup creation are
checked during apply:

```sh
with-scripts setup-theme --name="Example Theme" --slug=example-theme --source=/path/to/with-base --replace-existing
```

Before replacement, apply creates:

- a `backup/pre-with-base-<timestamp>` Git branch;
- a `pre-with-base-<timestamp>` DDEV database snapshot;
- the previous files at `.with-scripts-backups/themes/<slug>-<timestamp>/`.

The theme keeps its existing Git metadata. Add `.with-scripts-backups/` to the
website's local ignore rules if needed, and retain the backup until review is complete.
Before a pull with mirror cleanup, preserve needed backups outside the project tree;
that cleanup has no exclusion for `.with-scripts-backups/`.

## Recover and continue

A failure during theme preparation restores the previous theme files, or removes
an incomplete new theme. Shared plugin files and activation state can already have
changed. Review them separately and use the database snapshot/file backups when
needed. Setup reports that limit when synchronization has started.

Once the baseline works, migrate customer-specific changes deliberately. For later
shared-tool updates, use [Synchronize shared tools](sync-shared-tools.md). With Base
is copied as a starter; those updates are independent of copying With Base again.
