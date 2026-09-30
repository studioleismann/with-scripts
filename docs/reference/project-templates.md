# WordPress project templates

Templates live in [`templates/wordpress-project/`](../../templates/wordpress-project/).
`setup-wordpress` installs the WP-CLI wrapper. `setup-deployment` renders a release
workflow. The Git-ignore baseline is applied manually.

## `gitignore`

The [baseline](../../templates/wordpress-project/gitignore) ignores local runtime
configuration, WordPress Core, and `wp-content` except explicitly selected custom
components. Replace `{{THEME_SLUG}}` and `{{PLUGIN_SLUG}}`; remove both plugin-specific
allowlist lines and the surrounding plugin rules when no custom plugin is tracked.

It includes exclusions for `.ddev/.downloads/`, `.ddev/.importdb*`, local/production
configuration, maintenance files, archives, SQL dumps, `.DS_Store`, and `node_modules`.
Other `.ddev` project configuration can be tracked.

Merge this baseline into an existing `.gitignore` so project-specific rules remain.
When theme replacement creates `.with-scripts-backups/`, add that local backup path
to the project's ignore rules separately. Changing ignore rules leaves already
tracked files tracked; inspect `git ls-files` as part of the review.

## `.ddev/commands/web/wp`

The [wrapper](../../templates/wordpress-project/ddev/commands/web/wp) is a DDEV web
command installed by `setup-wordpress`. It invokes `/usr/local/bin/wp-cli` with PHP
deprecation reporting suppressed before and after WordPress loads. It preserves
explicit/project-configured paths and otherwise adds the DDEV document root.

## Release workflow templates

| Template | Payload |
| --- | --- |
| [deploy-theme.yml](../../templates/wordpress-project/deploy-theme.yml) | One custom theme |
| [deploy-theme-and-plugin.yml](../../templates/wordpress-project/deploy-theme-and-plugin.yml) | One custom theme and one plugin with an npm build |

Both templates currently use:

| Field | Value |
| --- | --- |
| Trigger | `release`, activity `published` |
| Checked-out source | `github.event.release.tag_name` |
| GitHub token permissions | `contents: read` |
| Concurrency | `production-deployment`, `cancel-in-progress: false` |
| Runner | `ubuntu-latest` |
| Checkout action | `actions/checkout@v7` |
| Node action | `actions/setup-node@v6` |
| Build Node.js version | `24` |
| SSH transfer action | `appleboy/scp-action@v1` |
| Transfer settings | `strip_components: 3`, `overwrite: true`, configured `tar_tmp_path` |

These are the values checked into this package, rather than a promise about the
latest upstream releases. A normal Git push has no deployment trigger in these
templates. Publishing a prerelease also matches the unfiltered `published` event;
use the release workflow only for the intended production release process.
[GitHub documents stable and prerelease triggers together](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

## Template values

| Placeholder | Destination |
| --- | --- |
| `{{WORDPRESS_ROOT}}` | Absolute remote WordPress root |
| `{{DEPLOY_TMP_PATH}}` | Writable temp directory outside the public root, with trailing slash |
| `{{THEME_SLUG}}` | Theme directory |
| `{{THEME_SCREENSHOT}}` | Screenshot basename and extension |
| `{{LIVE_URL}}` | Public HTTPS URL |
| `{{PLUGIN_SLUG}}` | Optional built plugin directory |
| `{{PLUGIN_MAIN_FILE}}` | Optional root PHP loader |
| `{{PLUGIN_HEALTH_PATH}}` | Optional public static file relative to the plugin root, inside `build/` |

Public values are written into the workflow `env` block. The five repository secrets
are `HOST`, `USERNAME`, `KEY`, `PORT`, and `FINGERPRINT`.

## Build and upload lists

Each selected component runs `npm ci` followed by `npm run build`. Dependencies must
be resolvable on the GitHub runner; local filesystem dependencies need an explicit
release-compatible arrangement. The templates add no sibling repository checkout
or private-package authentication step.

Theme upload candidates are:

```text
assets/  build/  inc/  parts/  patterns/  styles/  templates/
functions.php  LICENSE  <screenshot>  style.css  theme.json
```

When the wizard renders a workflow, it includes `build/` and keeps the other listed
paths only when Git tracks that file or something beneath the directory. This
selects whole directories for SCP; build-generated files inside an included directory
also enter the upload. Extra runtime directories outside this list need a reviewed
workflow edit. A manually copied template still contains the full candidate list,
so trim absent paths before running it.

The plugin upload contains only `build/` and its loader PHP file. Add any additional
required runtime paths explicitly when adapting the workflow.

The pre-upload checks require theme `style.css`, `functions.php`, and `build/`, plus
the optional plugin loader and `build/`. They verify existence, rather than PHP
syntax, lint, tests, or dependency completeness.

## Transfer and verification boundaries

The templates upload theme and optional plugin sequentially. Existing matching files
are overwritten; old remote-only files remain. There is no atomic switch, remote
backup, or automatic rollback in these templates. Plugin activation, theme activation,
database migration, and content publishing are separate operations.
The action exposes `overwrite` and target removal as separate settings; these
templates enable only overwrite. See the
[SCP action's file-transfer settings](https://github.com/appleboy/scp-action/tree/v1#-file-transfer-settings).

HTTP checks follow redirects and retry failures three times with a five-second
delay. They request the homepage, theme stylesheet, and optional plugin health file.
These checks establish HTTP availability; visual behavior and authenticated workflows
need separate review. A failing check can occur after files have already been uploaded.

See [Deploy custom WordPress code](../how-to-guides/deploy-custom-wordpress-code.md)
for release preparation and recovery, and
[full-site push](../how-to-guides/push-a-local-wordpress-site.md) for the separate
backup-and-replacement workflow.
