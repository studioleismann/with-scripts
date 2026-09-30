# Requirements and supported layouts

## Package runtime

| Requirement | Current contract |
| --- | --- |
| Node.js | `>=20.12.0`, as declared in `package.json` |
| npm | Used for installation, linking, builds, and tests; no version range is declared |
| Operating environment | A Unix-like shell environment with the commands required below |
| Runtime dependencies | `@clack/prompts` `1.8.1` and `picocolors` `1.1.1`; resolved dependencies are recorded in `package-lock.json` |
| Package distribution | Git checkout; `private: true` prevents npm publication |

The package declares no minimum WordPress, Gutenberg, PHP, or DDEV version. Test the
chosen WordPress and DDEV combination for each project. The Gutenberg plugin is
neither installed nor required by these commands. Full-site push uses PHP 8 functions
and requires matching local and remote PHP major/minor versions.

## Local command dependencies

| Command | Tools and state |
| --- | --- |
| `inspect-wordpress` | `ssh`; a readable remote WordPress configuration and database |
| `setup-wordpress` | `ssh`, DDEV, and a working Docker provider; a remote installation to inspect |
| `pull-wordpress` | DDEV, `ssh`, `tar`, `gzip`; Git for tracked-file protection; `.ddev/config.yaml` in the current directory |
| `configure-wordpress` | DDEV and an installed single-site WordPress database; network access for selected language/plugin downloads |
| `setup-theme` | Running DDEV, installed WordPress, Git, npm, `unzip`, a local With Base starter, and shared source repositories |
| `sync-tools` | Running DDEV, installed WordPress, npm, `unzip`, a compatible theme with Patterns scripts, and shared source repositories |
| `push-wordpress` | Running DDEV, installed single-site WordPress, `ssh`, `scp`, `tar`, `gzip`, `chmod`; npm and installed dependencies for buildable Git-tracked components |
| `setup-deployment` | Git and an existing website repository; real setup also needs Bash, `gh`, `ssh`, `ssh-keygen`, `ssh-keyscan`, GitHub access, and an interactive terminal |

`setup-theme --dry-run` skips the local WordPress check but still resolves the
project and reads its local source. `setup-deployment --dry-run` validates
local files; `--demo` can run from an empty folder. See the
[preview matrix](commands.md#preview-modes) for exact differences.

## Remote inspection and pull

The server needs Bash and PHP CLI. Inspection and DDEV setup use `mysql`; pulling
uses `mysqldump`, `gzip`, and `tar`. SSH runs with `BatchMode=yes` and a 15-second
connection timeout. Establish host trust and key authentication before starting.
Use a local SSH alias for custom ports and agent settings.

Remote WP-CLI is optional for inspection, setup, and pull. If reading configuration
through WP-CLI fails, PHP reads literal database constants and the table prefix from
`wp-config.php`. Configurations built from environment variables or includes may
need working remote WP-CLI. `DB_HOST` must use `host` or `host:port`; socket-form
values are outside the implemented parser.

Accepted remote roots begin with `/` or `~/`, use letters, numbers, dots,
underscores, hyphens, and slashes, and contain no `..` path segment. SSH targets
use letters, numbers, dots, underscores, hyphens, and `@`, and must begin with
something other than `-`.

Setup detects **PHP CLI** and the database engine/version. PHP-FPM/web-server
settings and extension parity require separate inspection. DDEV must support the
detected PHP and MySQL/MariaDB versions. Setup configures a WordPress project with
its document root at `.`; custom web-server rules and custom local hostnames need
their own DDEV configuration.

## Full-site push target

The target must already contain WordPress and have:

- a public HTTPS URL at the domain root, matching both database `home` and `siteurl`;
- a dedicated database containing only base tables with its WordPress prefix;
- the standard `wp-content` location and an absolute document root below a site directory;
- PHP 8 or newer, matching the local major/minor version, with the extensions needed by the site;
- `mysql`, `mysqldump`, `gzip`, `tar`, `curl`, and `sha256sum` available over SSH;
- permissions and disk space for a private sibling workspace, a full backup, and the candidate site;
- HTTPS serving that exact document root and working WordPress permalink rules.

Push rejects Multisite, target database views, local/target URLs with subdirectory
paths, a target already in maintenance mode, and symbolic links in copied runtime
files or managed target paths. The target URL accepts no explicit port or local
hostname suffix such as `.ddev.site`, `.local`, or `.test`.

Choose hosting-specific PHP with `--php=/absolute/path/to/php`. Push bundles the
DDEV WP-CLI executable for the remote transaction. Local root-level content drop-ins
such as `object-cache.php` and `db.php` are outside its upload set. Review
[the transfer boundaries](commands.md#push-wordpress) before using a site with these files.

## Shared tool repositories

The default source paths are relative to the installed `with-scripts` package.
The parent directory name is freely selectable; this is an example layout:

```text
code/
  packages/
    with-scripts/
    with-patterns/
  plugins/
    with-theme-tools/
    with-site-tools/
```

`setup-theme` and `sync-tools` require all three tool directories. Prepare each
repository's dependencies according to its own setup instructions. The commands use
the current local checkouts; fetching and updating those repositories is a separate
step. Their build and check scripts determine further tool requirements.

For another layout, both commands accept `--patterns-source=<path>`,
`--theme-tools-source=<path>`, and `--site-tools-source=<path>`. Paths are resolved
from the current working directory and shown in the plan. These options select
compatible local source packages. The With Patterns source used for synchronization
must also be the source installed as the theme's Patterns dependency.

Supply a local With Base starter with `setup-theme --source=<path>`. Its root must
contain `style.css`, `theme.json`, and `package.json`. The wizard asks for the source
directory when the option is omitted. Obtain the starter and shared tools from
repositories that you control or have permission to use.

## Release deployment project

`setup-deployment` resolves the website Git root from the current directory. It
accepts `github.com` origins in SSH, HTTPS, or `ssh://git@github.com/` form.
The selected components must be tracked under:

```text
wp-content/themes/<theme>/
wp-content/plugins/<plugin>/
```

The theme needs tracked `package.json`, `package-lock.json`, `style.css`,
`functions.php`, `theme.json`, and a screenshot named `screenshot.png`, `.jpg`,
`.jpeg`, or `.webp`. The optional plugin needs a tracked npm manifest, lockfile, and
root PHP loader. Both components need an npm `build` script.

Real setup needs a dedicated passphrase-free private key outside the repository,
a trusted server host-key fingerprint, and permission to manage repository Actions
secrets. The key's parent directory must already exist, including for dry runs.
The deployment temp directory must already exist on the server and resolve outside
the web root. Full details are in [Set up release deployments](../how-to-guides/set-up-release-deployments.md).
