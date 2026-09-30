# Develop and verify with-scripts

Work from the package checkout. Changes here affect a globally linked `with-scripts`
command, so use disposable fixtures or an intended test site for command execution.

## Install the development dependencies

Use the declared Node.js version range, npm, Bash, Git, and local PHP CLI:

```sh
npm ci
node --version
npm --version
command -v php
```

The package uses native ES modules and has no compilation step of its own. Its
WordPress commands can invoke builds in other packages.

## Run the existing checks

```sh
npm run verify
```

| Script | Behavior |
| --- | --- |
| `npm run check` | `node --check` on the CLI/modules, `bash -n` on the two shell scripts, and `php -l` on `push-content.php` |
| `npm test` | `node --test` for the `test/` suite |
| `npm run verify` | Syntax checks followed by tests |
| `npm run check:secrets` | Gitleaks and privacy checks for Git history, metadata, staged content, and publishable working files |
| `npm run hooks:install` | Enables this checkout's `.githooks/pre-push` scan |
| `npm run pack:dry-run` | `npm pack --dry-run`; its `prepack` lifecycle runs verification |

The tests cover CLI contracts and errors, URL handling, Git protection and package
replacement, profile PHP generation, theme identity/setup failures, sync routing,
deployment previews/secret stages, push transaction failures, and terminal interaction.
External commands are replaced with fixtures/mocks where required.

Terminal interaction tests use Python 3's standard `pty` module when it is available.
They exercise navigation, cancellation, required input, conservative confirmations,
and plugin multiselect. Those tests are skipped when Python/PTY support is unavailable.
Local PHP is needed for the package's syntax script; individual PHP tests also contain
their own availability checks.

Passing tests establish those fixture-backed conditions. DDEV runtime behavior,
host-specific PHP/database combinations, authenticated editor use, SSH hosting, and
GitHub Actions deployment need their own live checks on an appropriate test site.

## Check secrets and public examples

Download **Gitleaks 8.30.1** for your operating system and architecture from the
[official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).
Verify the archive's SHA-256 against the release's `gitleaks_8.30.1_checksums.txt`
before extracting it. Put the verified executable on `PATH`, or store it locally
inside the checkout's Git metadata. Replace `/path/to/verified/gitleaks` below with
the extracted executable:

```sh
mkdir -p "$(git rev-parse --git-path tools)"
install -m 700 /path/to/verified/gitleaks "$(git rev-parse --git-path tools/gitleaks)"
git config --local with-scripts.gitleaksPath "$(git rev-parse --git-path tools/gitleaks)"
npm run check:secrets
npm run hooks:install
```

Scanner lookup uses `GITLEAKS_BIN`, then `with-scripts.gitleaksPath` from Git
configuration, then `gitleaks` on `PATH`. Review any existing `core.hooksPath`
before installing the repository hook. Each checkout needs its own hook setup.

The hook scans complete reachable history, commit and tag metadata, staged blobs,
and publishable working files. It also checks explicitly pushed objects. Missing
tools, shallow history, findings, and scanner errors block the push. CI runs the
same check on pushes and pull requests with complete fetched history and a pinned,
checksum-verified Gitleaks release. Matched values and filenames are withheld from logs.

Review customer names, personal names, account identifiers, hosting details, and
project-specific paths manually as well. Automated pattern checks cover common
emails, user directories, local hostnames, and IP addresses; arbitrary names and
infrastructure details need human review. Use neutral examples and a GitHub
`noreply` address for public commit metadata.

## Inspect the package contents

```sh
npm run pack:dry-run
```

The package file list contains `bin`, `docs`, `src`, `templates`, `README.md`, and
`CHANGELOG.md`, alongside npm's package metadata. Tests are development-only. For a
restricted or unwritable default npm cache, supply a writable cache directory:

```sh
npm --cache /private/tmp/with-scripts-npm-cache pack --dry-run
```

The source is licensed under `GPL-2.0-or-later`; see [LICENSE](../../LICENSE).
The package setting `private: true` prevents accidental npm publication.

## Source map

| File | Responsibility |
| --- | --- |
| [`bin/with-scripts.mjs`](../../bin/with-scripts.mjs) | Command registry, menu, help, dispatch, and top-level error handling |
| [`src/cli.mjs`](../../src/cli.mjs) | Shared prompts, subprocess execution, downloads, and local settings |
| [`src/remote-wordpress.mjs`](../../src/remote-wordpress.mjs) | SSH validation, inspection/stream scripts, URL normalization, and pull exclusions |
| [`src/inspect-wordpress.mjs`](../../src/inspect-wordpress.mjs) | Remote environment report |
| [`src/setup-wordpress.mjs`](../../src/setup-wordpress.mjs) | DDEV setup and project WP-CLI wrapper installation |
| [`src/pull-wordpress.mjs`](../../src/pull-wordpress.mjs) | Local snapshot, download, file protection, import, and URL replacement |
| [`src/configure-wordpress.mjs`](../../src/configure-wordpress.mjs) | Built-in profile, generated PHP, wizard, and verification |
| [`src/setup-theme.mjs`](../../src/setup-theme.mjs) | With Base copy, personalization, backups, build, and activation |
| [`src/sync-tools.mjs`](../../src/sync-tools.mjs) | Local source resolution and sequential runtime synchronization |
| [`src/push-wordpress.mjs`](../../src/push-wordpress.mjs) | Target review, local package/export, upload, and transaction dispatch |
| [`src/push-content.php`](../../src/push-content.php) | Content/revision/CSS inventory and imported-state verification |
| [`src/push-remote.sh`](../../src/push-remote.sh) | Remote backup, import, runtime switch, HTTP checks, and rollback |
| [`src/setup-deployment.mjs`](../../src/setup-deployment.mjs) | Project/options validation, template rendering, and saving local outputs |
| [`src/setup-deployment.sh`](../../src/setup-deployment.sh) | Five manual SSH/GitHub setup stages and demo |
| [`scripts/check-secrets.mjs`](../../scripts/check-secrets.mjs) | Complete-history secret scan and generic privacy checks |
| [`templates/wordpress-project/`](../../templates/wordpress-project/) | Git-ignore baseline, WP-CLI wrapper, and release workflow templates |

## Keep documentation aligned with a change

For a command change, check its help, argument parser, side-effect order, failure
paths, and existing tests together. Update the relevant pages:

- [commands](../reference/commands.md) for options, confirmations, directories, and previews;
- [configuration](../reference/configuration.md) for fields, precedence, generated files, and filters;
- [profile](../reference/wordpress-profile.md) for WordPress values and check scope;
- [templates](../reference/project-templates.md) for CI source, build/upload lists, and checks;
- the task's how-to guide and [safety explanation](../explanation/production-and-local-safety.md)
  when effects or recovery change.

Use neutral example projects. Validate local links/anchors, JSON examples, and shell
syntax. Verify executable examples only within their intended scope: running a
published-release command or a full push is a real external action, not a documentation
check. Keep release history in the [changelog](../../CHANGELOG.md) and distinguish
unreleased behavior from tagged releases.
