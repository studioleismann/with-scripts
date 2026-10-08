# Command reference

## Usage and terminal behavior

```text
with-scripts
with-scripts --help
with-scripts <command> --help
with-scripts <command> [options]
```

The bare command opens a menu when stdin and stdout are terminals, `CI` is unset,
and `TERM` is other than `dumb`. Otherwise it prints help. Arrow keys select an
item, Enter confirms, and Space toggles plugins in the configuration multiselect.
`NO_COLOR=1` disables colors. Shared prompts fall back to line-based input outside
the interactive interface; deployment setup also accepts --yes with complete settings.

Use `--help` or `-h` as the command's only option to get help before project access.
Unknown commands and unsupported options fail. Value options below use `--name=value`;
quote values containing spaces. `setup-deployment` also accepts `--name value`.

Successful completion, help, and declining a normal apply prompt return status `0`.
Errors and profile drift return `1`. Cancellation through a shared Clack prompt
returns `130`; a failed or cancelled deployment Bash stage is reported as an error
by its Node wrapper. Closed input produces an actionable error.

## Working directories

| Command | Run from |
| --- | --- |
| `inspect-wordpress` | Folder in which connection settings should be read/saved |
| `setup-wordpress` | Intended local WordPress document root |
| `pull-wordpress`, `configure-wordpress`, `push-wordpress` | Document root containing `.ddev/config.yaml` |
| `setup-theme` | DDEV WordPress project root or an immediate theme root under `wp-content/themes/` |
| `sync-tools` | Project root or an immediate theme root; the current theme directory takes precedence over `--slug` |
| `setup-deployment` | Website root containing wp-content, or any subdirectory; `--demo` works from any folder |

## Preview modes

| Command/mode | What runs before returning |
| --- | --- |
| `configure-wordpress --dry-run` | Starts DDEV, loads WordPress, collects choices, and prints the plan; skips applying the profile |
| `configure-wordpress --check` | Starts DDEV, loads WordPress, and checks the fixed profile; drift returns `1` |
| `setup-theme --dry-run` | Resolves the project, reads the selected local source, and shows tool source paths; skips project writes and local WordPress verification |
| `sync-tools --dry-run` | Reads local WordPress and runs existing runtime/source checks; skips builds, sync, installation, and activation |
| `push-wordpress --dry-run` | Inventories the local site and runs the remote preflight; skips packaging and remote writes |
| `push-wordpress --prepare-only` | Builds and exports a private local package; retains its directory; skips all target connections |
| `setup-deployment --dry-run` | Validates a temporary source tree and prints the plan; may resolve local SSH settings; skips network access and project/service writes |
| `setup-deployment --demo` | Simulates the five stages with example values |

These modes have different requirements. WordPress inspection loads its runtime,
and DDEV startup may update local runtime files. `inspect-wordpress`,
`setup-wordpress`, and `pull-wordpress` accept only their help flags; a pull preview
flag is unavailable.

## `inspect-wordpress`

```sh
with-scripts inspect-wordpress
```

Prompts for SSH target, remote WordPress root, and saving settings (default: yes).
Defaults come from `wordpressPull`. The report includes WordPress version, WP-CLI
availability, PHP CLI version/settings/extensions, WordPress URLs, and database
version/engine/charset/collation. Successful inspection can save the SSH target and
root in `.with-scripts.json`. The remote scripts perform read operations.

The report names the selected PHP CLI executable and explicitly distinguishes it
from the website's web-server PHP version. A working `php` CLI keeps priority;
otherwise inspection automatically uses the highest working versioned CLI found
in the remote `PATH`. The same discovery supports setup and pull. An incorrect
WordPress root stops before PHP or database access with a targeted path error.

## `setup-wordpress`

```sh
with-scripts setup-wordpress
```

Prompts for SSH target and remote root, inspects the server, then asks for local URL,
DDEV name, saving settings, and configuring/starting DDEV. Both confirmations default
to yes. The generated URL derives from the remote home URL; the name defaults to a
saved `projectName` or the first hostname label of the chosen local URL.

After confirmation it optionally saves `wordpressPull`, runs `ddev config --auto`
with project type `wordpress`, docroot `.`, name, detected PHP version, and database
engine/version, installs `.ddev/commands/web/wp`, and runs `ddev start`.

The local URL is stored as a pull default. DDEV routing still comes from its own
configuration; choosing a custom URL here requires matching DDEV hostname settings.
This command prepares DDEV. Use `pull-wordpress` to obtain files and a database.

## `pull-wordpress`

```sh
with-scripts pull-wordpress
```

Requires `.ddev/config.yaml`. A Git repository rooted at the document root must be
clean, including untracked files. Existing WordPress files outside such a repository
require the typed confirmation below.

Prompts use `wordpressPull` defaults: SSH target, remote root, live URL, local URL,
save settings (yes), and delete local files missing from production (no).
The final confirmation is:

| Local state | Confirmation |
| --- | --- |
| Empty project or clean repository rooted at the document root | `Continue?`, default no |
| Existing WordPress files without that Git protection | Exact text `PULL WITHOUT BACKUP` |

After confirmation the command:

1. Checks the remote root and required tools, optionally saves settings, starts DDEV,
   and creates `before-pull-<ISO timestamp>` with colons/dots replaced by hyphens.
2. Streams the database and files into private temporary storage. Downloads stop
   after 90 seconds without new bytes; `gzip` and `tar` validate the archives.
3. Archives Git-tracked files when protected. Optional mirror cleanup removes
   unprotected local paths absent from production.
4. Replaces matching untracked plugin/theme packages as complete units, excludes
   Git-managed packages, extracts other files, and restores tracked files.
5. Generates and validates local DDEV `wp-config.php`, appends pull ignore rules, and renames
   `.maintenance` to `.maintenance.production-copy` when present.
6. Imports the database with hooks skipped and applies URL variants using trusted
   database-only code. It preserves GUIDs, serialized data and Custom CSS, verifies
   each changed row in a transaction, and checks the local database URLs.

The file stream excludes local metadata and known cache/backup paths. See
[configuration](configuration.md#pull-file-exclusions) for the exact list and local
URL precedence. File protection applies during copying; the later `wp-config.php`
generation and `.gitignore` additions are intentional local edits.

Temporary downloads are removed in normal success/error cleanup. The database
snapshot remains. Recovery guidance depends on whether files or database import
were reached; see [Troubleshoot a pull](../how-to-guides/troubleshoot-a-wordpress-pull.md).

## `configure-wordpress`

```sh
with-scripts configure-wordpress --profile=standard
```

| Option | Effect |
| --- | --- |
| `--profile=standard` | Selects the only built-in profile; also the default |
| `--dry-run` | Collects choices and prints the plan without applying it |
| `--check` | Checks fixed profile settings and reports `OK`/`MISSING`; drift returns `1` |

`--dry-run` and `--check` are mutually exclusive. The command starts DDEV, requires
installed WordPress, and rejects Multisite. Normal mode asks about fresh/existing
state, page assignments, site/language settings, category, comments, media, plugins,
cleanup, and an optional database snapshot for an existing site. The final apply
confirmation defaults to no.

The [profile reference](wordpress-profile.md) lists every setting and the exact
check scope. Choices are stored in WordPress, rather than in `.with-scripts.json`.
The check always compares against the full fixed profile, even if a previous run
used another language or skipped plugins/media.

## `setup-theme`

```sh
with-scripts setup-theme --name="Example Theme" --slug=example-theme --source=/path/to/with-base
```

| Option | Effect |
| --- | --- |
| `--name=<name>` | Nonempty single-line display name; prompted if omitted |
| `--slug=<slug>` | Directory, text domain, package name, and source identity; prompted if omitted |
| `--source=<path>` | Local With Base starter directory; prompted if omitted |
| `--patterns-source=<path>` | Override the local With Patterns source directory |
| `--theme-tools-source=<path>` | Override the local With Theme Tools source directory |
| `--site-tools-source=<path>` | Override the local With Site Tools source directory |
| `--replace-existing` | Allows replacement after checking a clean standalone theme Git repository |
| `--dry-run` | Reads the local source and prints the plan |
| `--yes` | Skips the final apply confirmation; missing name/slug/source still prompt and normal safeguards still run |

Slugs start with a lowercase letter, continue with lowercase letters/numbers, and
may contain single separating hyphens. `with-base` is reserved.

Apply checks local WordPress before reading the source. It copies the theme root
excluding `.git`, `node_modules`, and `.webpack-cache`; replaces the `With Base`,
`with-base`, `with_base`, and `WITH_BASE` identity forms in supported text files and
renames paths containing `with-base`. It adjusts the theme header, package metadata,
and BrowserSync start URL, installs local With Patterns as a development dependency,
runs `patterns:setup` and `sync-tools`, builds/lints the theme, and activates it.

Replacing an existing theme requires that theme to be its own clean Git root. Apply
creates a `backup/pre-with-base-<timestamp>` branch, a `pre-with-base-<timestamp>`
DDEV snapshot, and `.with-scripts-backups/themes/<slug>-<timestamp>/`. The original
Git metadata stays with the replacement. The dry run reports replacement intent;
it leaves the Git cleanliness and backup checks to apply.

Failures during theme preparation restore the previous theme files or remove an
incomplete new theme. Shared plugin files and activation state may already have
changed. Customer-specific code and saved Site Editor styles/templates require
separate migration and review. See [Set up a customer theme](../how-to-guides/set-up-customer-theme.md).

## `sync-tools`

```sh
with-scripts sync-tools --slug=example-theme
```

| Option | Effect |
| --- | --- |
| `--slug=<slug>` | Selects a theme from the project root; otherwise reads the active `stylesheet` option |
| `--patterns-source=<path>` | Override the local With Patterns build source; match the theme's installed Patterns dependency |
| `--theme-tools-source=<path>` | Override the local With Theme Tools source directory |
| `--site-tools-source=<path>` | Override the local With Site Tools source directory |
| `--dry-run` | Checks existing runtimes/source version and plugin status without synchronizing |

From a theme root, that directory selects the theme. Requires local WordPress,
a theme `package.json`, and all [shared source repositories](requirements.md#shared-tool-repositories).

Apply builds/checks With Patterns, runs theme `patterns:check`, `patterns:sync`, and
`patterns:check`, builds the With Theme Tools ZIP and unzips it over the plugin path,
then builds/checks/syncs/checks With Site Tools. Finally it activates both plugins.
It uses local source checkouts and has no confirmation prompt or automatic rollback.

Dry run invokes theme `patterns:check`, Theme Tools `check:version`,
`ddev wp plugin status with-theme-tools`, and Site Tools `sync:check`. It can return a
failure for a missing or divergent runtime. It does not compare every installed
Theme Tools file with its source. See [Synchronize shared tools](../how-to-guides/sync-shared-tools.md).

## `push-wordpress`

```sh
with-scripts push-wordpress --ssh=example-host --root=/srv/example/httpdocs --url=https://example.org --dry-run
```

| Option | Effect |
| --- | --- |
| `--ssh=<host>` | SSH alias or `user@host` |
| `--root=<path>` | Absolute existing target document root below a site directory |
| `--url=<https-url>` | Public HTTPS domain-root URL matching target `home` and `siteurl` |
| `--php=<path>` | Remote PHP executable: `php` (default) or an absolute path |
| `--dry-run` | Local inventory and remote preflight only |
| `--prepare-only` | Builds/exports locally, retains the private package, and skips target access |

The two preview modes are mutually exclusive. Options override `wordpressPush`
settings. Missing SSH/root/URL values prompt; pull settings are independent. This
command reads saved push settings but never writes them. An actual push always
requires exact text `PUSH <normalized-target-url>` after package preparation.

The payload contains listed Core runtime paths and `wp-content/{plugins,themes,
mu-plugins,languages,uploads}` plus an `index.php`. Managed target paths include all
of `wp-content`, `wp-config.php`, and `index.html`: existing target drop-ins and other
content-root files therefore disappear with the old directory. The target's
`wp-config.php` is reused, with its table prefix adjusted. Existing `.htaccess`
stays; missing rules are generated through WordPress. See
[configuration](configuration.md#push-runtime-filter) for filters and file boundaries.

Git-tracked themes/plugins with a build script build in a disposable copy using
installed local dependencies. The current working copy, including uncommitted
runtime changes, supplies the files. Prebuilt packages also work without Git.

The database export uses all source tables with the WordPress prefix, serialized
value handling, URL boundaries, and `guid` exclusion. Protected JSON CSS strings
remain unchanged, including local URLs inside them. Source hashes, revisions,
autosaves, CSS values, table names/counts, and imported settings are checked.
Target backup, replacement, static component checks, and HTTPS checks run under a
rollback handler. Bundled database code performs remote checks without loading site PHP.
The sibling workspace and original backups remain for review/retention.

See [Push a local WordPress site](../how-to-guides/push-a-local-wordpress-site.md)
for requirements, the exact verification scope, status values, and recovery.

## `setup-deployment`

```sh
with-scripts setup-deployment
with-scripts setup-deployment --repo=example-owner/example.org --dry-run
with-scripts setup-deployment --demo
```

| Option | Effect/default |
| --- | --- |
| `--repo=<owner/name>` | Freely chosen GitHub owner and repository; inferred from existing origin or asked interactively |
| `--ssh=<alias>` | Existing setup SSH connection; falls back to saved pull target and resolves through `ssh -G` |
| `--component=<path>` | Repeatable owned theme/plugin/MU-plugin path; existing tracked components are retained |
| `--theme=<slug>` | Shorthand for an owned theme |
| `--plugin=<slug\|none>` | Shorthand for an owned plugin |
| `--root=<path>` | Absolute production WordPress root; falls back to saved pull settings |
| `--url=<https-url>` | HTTPS domain-root URL; falls back to saved pull settings |
| `--host=<hostname>` | Public SSH hostname/IP; otherwise resolved from the SSH alias |
| `--user=<username>` | SSH account; otherwise resolved from the SSH alias |
| `--port=<port>` | Integer 1–65535; resolved from alias, otherwise 22 |
| `--key-file=<path>` | Dedicated private-key path outside Git; default `~/.ssh/<owner>-<repository>-deployment` |
| `--fingerprint=<SHA256:...>` | Trusted fingerprint for the host key selected by the Actions; otherwise use that known host key or prompt |
| `--dry-run` | Local plan, exclusions and template conflict checks; no project/service changes |
| `--yes` | Accept the setup plan with complete inputs; usable without a terminal |
| `--replace-secrets` | Explicitly replace existing deployment secrets when saved progress does not match |
| `--demo` | Five simulated stages; use on its own from any folder |

Explicit inputs override saved deployment settings, then inferred pull/SSH values.
The GitHub owner is never fixed by the package. An existing origin takes precedence
over a stale saved repository; an explicit conflicting `--repo` stops setup.

Real setup validates the release build in a temporary copy, authorizes a dedicated
key, verifies SSH/preflight and GitHub settings, then commits/pushes the reviewed
website source. Generated files carry template version/hash metadata. Retrying
reuses existing resources and successful secret writes. Release publication is a
separate production action.

See [Set up a website repository and release deployment](../how-to-guides/set-up-release-deployments.md)
for prerequisites, secret replacement, template updates, and recovery.
