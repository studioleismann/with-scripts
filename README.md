# with-scripts

`with-scripts` is a reusable CLI for WordPress projects: inspect a hosting environment,
set up DDEV, pull a site locally, configure WordPress, create a customer theme,
synchronize shared tools, prepare release deployments, and push a complete site.

## Install

Use Node.js **20.12.0 or newer** and npm. Clone the repository into the shared
[development layout](docs/reference/requirements.md#shared-tool-repositories):

```sh
mkdir -p ~/code/packages
cd ~/code/packages
git clone git@github.com:studioleismann/with-scripts.git
cd with-scripts
npm ci
npm link
with-scripts --help
```

WordPress commands use DDEV and a working Docker provider. Remote commands need SSH
access; theme and deployment commands have additional
[requirements](docs/reference/requirements.md). See
[Install and update](docs/how-to-guides/install-and-update.md) for ongoing updates.

## Choose a command

Run `with-scripts` in a terminal to open the menu, or call a command directly.
Use arrow keys and Enter; use Space for plugin selections. `NO_COLOR=1` disables
colors. Outside an interactive terminal, the bare command prints help.

| Task | Command | Main effect |
| --- | --- | --- |
| Inspect a hosted site | `inspect-wordpress` | Reads the server environment; optionally saves local connection settings |
| Set up DDEV from a hosted site | `setup-wordpress` | Writes local DDEV configuration and starts DDEV |
| Refresh a local site | `pull-wordpress` | Replaces the local database and copies remote files with Git protections |
| Apply the local WordPress profile | `configure-wordpress` | Updates local pages, settings, language files, and selected plugins |
| Create a customer theme | `setup-theme` | Copies and personalizes With Base, synchronizes tools, builds, and activates locally |
| Update shared tools | `sync-tools` | Builds local tool sources and updates theme/plugin runtimes |
| Set up code deployment | `setup-deployment` | Creates a release workflow and configures SSH access and GitHub secrets |
| Publish a complete local site | `push-wordpress` | Replaces the explicit remote target after package review and backup |

Use `with-scripts <command> --help` for supported options. The
[command reference](docs/reference/commands.md) describes prompts, working
directories, confirmations, and the different preview modes.

## Start with an existing website

Create a folder for one WordPress installation:

```sh
mkdir -p ~/code/projects/example/website
cd ~/code/projects/example/website
with-scripts setup-wordpress
with-scripts pull-wordpress
ddev launch
```

Setup reads the server's PHP CLI and database versions. Pull creates a local database
snapshot and replaces the local copy. Both use the remote site as a read-only source.
Follow the [setup tutorial](docs/tutorials/set-up-an-existing-wordpress-site.md)
for the complete process, including Git protection.

## Continue with a specific task

- [Configure local WordPress](docs/how-to-guides/configure-local-wordpress.md)
- [Create or replace a customer theme](docs/how-to-guides/set-up-customer-theme.md)
- [Synchronize shared tools](docs/how-to-guides/sync-shared-tools.md)
- [Set up release deployments](docs/how-to-guides/set-up-release-deployments.md)
- [Push a complete local WordPress site](docs/how-to-guides/push-a-local-wordpress-site.md)

To explore the deployment wizard with simulated values from any folder:

```sh
with-scripts setup-deployment --demo
```

## Documentation and development

The [documentation index](docs/README.md) separates tutorials, how-to guides,
reference, and explanation using the Diátaxis structure.

For package development, run:

```sh
npm run verify
```

This checks JavaScript, Bash, and PHP syntax and runs the existing tests. See
[Develop and verify with-scripts](docs/how-to-guides/develop-with-scripts.md)
for dependencies, test boundaries, packaging, and the source map.

## License

`with-scripts` is licensed under the GNU General Public License, version 2 or any
later version (`GPL-2.0-or-later`). See [LICENSE](LICENSE) for the full license text.
Dependencies and selected starter/tool repositories retain their own licenses.
