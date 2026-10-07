# WordPress project templates

## Website repository and deployment

`setup-deployment` installs the versioned
[`wordpress-site` template](../../templates/wordpress-site/template.json).
Its `.gitignore` block allows explicitly selected custom components while excluding
WordPress Core, third-party runtime content, local configuration, archives, database
dumps, and credential files. Existing custom ignore rules and DDEV settings remain.

The template includes a README, local development and repository setup guides, the
[deployment guide](../../templates/wordpress-site/docs/deployment.md), a detailed
[replacement contract](../../templates/wordpress-site/docs/deployment-replacement-spec.md),
one workflow, and three deployment scripts including their integration tests.

| Field | Checked-in template value |
| --- | --- |
| Template version | `1.0.1` |
| Trigger | `release`, activity `published`, including published prereleases |
| Checkout | `github.event.release.tag_name` |
| Token permissions | `contents: read` |
| Concurrency | `production-deployment`, `cancel-in-progress: false` |
| Runner / Node.js | `ubuntu-latest` / `24` |
| Actions | `actions/checkout@v7`, `actions/setup-node@v6`, `appleboy/scp-action` (`v1.0.0`), `appleboy/ssh-action` (`v1.2.5`) |
| Repository variables | `WORDPRESS_ROOT`, `LIVE_URL` |
| Repository secrets | `HOST`, `USERNAME`, `KEY`, `PORT`, `FINGERPRINT` |

These describe this package's versioned template, rather than the latest upstream
releases. GitHub documents the
[release event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

The artifact builder derives component ownership from tracked first-level entries
under `wp-content/themes`, `plugins`, and `mu-plugins`. npm components define their
production payload through `package.json` `files`; source-only components use
`git archive`. Directory and single-file plugins are supported.

Deployment stages a candidate, backs up and replaces owned components, verifies HTTP
responses, and commits or rolls back the transaction. Previously owned components
removed from Git are removed on deployment. Live-only components stay in place.
This release process leaves WordPress Core, uploads, and the database in place.
Read the operational guide for rollback failures and retained recovery evidence.

The setup command runs the complete integration suite and actual artifact build
in an isolated copy before configuring GitHub or authorizing a new key. The
workflow runs the suite again on the published release revision.

`.github/with-scripts-deployment.json` records the installed version and file hashes.
Unmodified generated files can receive a template update. Modified deployment files
produce a diff and stop setup; existing documentation is preserved.

## WP-CLI wrapper

[`templates/wordpress-project/ddev/commands/web/wp`](../../templates/wordpress-project/ddev/commands/web/wp)
is installed by `setup-wordpress`. It invokes `/usr/local/bin/wp-cli` with PHP
deprecation reporting suppressed before and after WordPress loads, preserves
explicit/project-configured paths, and otherwise uses the DDEV document root.

## Legacy manual templates

The earlier `wordpress-project/gitignore`, `deploy-theme.yml`, and
`deploy-theme-and-plugin.yml` remain available for existing manually configured
projects. `setup-deployment` now uses `wordpress-site`. Merge existing deployments
deliberately: the legacy workflows overwrite selected files; the website template
replaces whole owned components and removes previously owned components deleted
from Git.
