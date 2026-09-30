# Deploy custom WordPress code

Use a website GitHub release to publish a custom theme and optionally one built
plugin. This guide covers reviewing or manually adapting the bundled workflows and
publishing from an exact source state. For guided SSH/key/secret setup, start with
[Set up release deployments](set-up-release-deployments.md).

## 1. Review tracked source and runtime files

The website repository should track the custom components under `wp-content/themes/`
and `wp-content/plugins/`. Merge the
[Git-ignore baseline](../../templates/wordpress-project/gitignore) into existing rules,
replace its slug placeholders, and review `git ls-files` for previously tracked
runtime/configuration files. Private configuration, uploads, and third-party code
belong outside this code release.

Check the branch, origin, and changes before selecting a release state:

```sh
git branch --show-current
git remote -v
git status
git log -1 --oneline
```

## 2. Build and test the components

From the website root, using the real theme slug:

```sh
npm --prefix wp-content/themes/example-theme ci
npm --prefix wp-content/themes/example-theme run build
```

For the optional built plugin:

```sh
npm --prefix wp-content/plugins/example-plugin ci
npm --prefix wp-content/plugins/example-plugin run build
```

Run each package's existing lint/tests and inspect them together in local WordPress.
Check that lockfiles and dependencies work on a clean GitHub runner. For example,
a `file:` dependency pointing to a sibling checkout needs that source or another
reviewed dependency arrangement available in CI.

## 3. Create or review the workflow

The wizard generates `.github/workflows/deploy-production.yml`. For manual setup,
choose the [theme template](../../templates/wordpress-project/deploy-theme.yml) or
[theme-and-plugin template](../../templates/wordpress-project/deploy-theme-and-plugin.yml).
When there is no existing deployment file, copy the chosen template:

```sh
mkdir -p .github/workflows
cp ~/code/packages/with-scripts/templates/wordpress-project/deploy-theme.yml .github/workflows/deploy-production.yml
```

Replace the placeholders listed in the
[template reference](../reference/project-templates.md#template-values). Keep public
paths/slugs/URLs in `env`. Use an existing writable `DEPLOY_TMP_PATH` outside the web
root with a trailing slash.

Review the explicit upload lists. The theme list must contain every required runtime
path and omit absent paths. The plugin list supplies only `build/` and the loader;
add other required runtime files deliberately. A plugin with no npm build needs a
manually adapted workflow.

The checked-in templates run on `release: published`, check out that release's tag,
and use Node.js 24. They overwrite matching uploaded files and leave remote-only
files present. Plan removals explicitly when source files were deleted. Theme/plugin
activation and database changes are separate tasks.

## 4. Verify credentials and target paths

The workflow expects five repository Actions secrets:

| Secret | Value |
| --- | --- |
| `HOST` | Actual SSH hostname/IP reachable from GitHub Actions |
| `USERNAME` | Hosting account |
| `KEY` | Complete private deployment key |
| `PORT` | SSH port |
| `FINGERPRINT` | SHA256 server host-key fingerprint |

Use a dedicated deployment key. The wizard verifies it with the personal agent
disabled and an explicitly trusted host key. If doing this manually, establish the
same checks: authorized public key, passphrase-free private key, trusted host identity,
and target/temp paths writable by that account.

A scan can list candidate server fingerprints:

```sh
ssh-keyscan -p 22 server.example.org 2>/dev/null | ssh-keygen -lf - -E sha256
```

Confirm the chosen fingerprint through the hosting provider or a trusted server
console before storing it. The scan alone supplies no independent trust.

## 5. Publish the reviewed state

Choose an unused website tag. For example, from the clean, reviewed checkout with
its intended origin/branch and workflow already committed:

```sh
git tag v1.0.0
git push origin HEAD
git push origin v1.0.0
gh release create v1.0.0 --verify-tag --generate-notes
```

The final command publishes the release and starts deployment. The tag is created
from the reviewed local commit and uploaded explicitly. Published prereleases also
match this workflow's event; see [GitHub's release-event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

## 6. Verify the result

Open the Actions run for the release and check the build, upload, and HTTP results.
Then review the homepage, relevant pages, theme assets, and plugin behavior in the
actual site. The template's HTTP checks follow redirects and only test the homepage,
theme stylesheet, and optional plugin asset.

Take and retain appropriate production backups through the site's normal process.
The release templates supply an overwrite upload; they contain no remote backup,
atomic switch, automatic rollback, or deletion of stale files. If a plugin upload
fails after the theme upload, the site can contain components from different releases.

## Diagnose a failed release

| Failure | What to inspect |
| --- | --- |
| `npm ci` or build failure | Lockfile consistency, private dependencies, local path dependencies, and build scripts under Node.js 24 |
| Archive/source-path error | Every configured source path, including optional theme folders and generated assets |
| Host-key fingerprint mismatch | The verified key type negotiated by the action; compare available host keys with a trusted source and retain fingerprint verification |
| Upload exits after connecting | Temp-directory existence/write access and its trailing slash; target write access |
| Failure while extracting | Target path, permissions, and remote `tar` support |
| HTTP check failure | Current remote files, site errors, redirects, and configured asset paths; some uploads may already have completed |

For a broken code release, deploy a reviewed correction or known-good source through
a new release, accounting for any files that must be removed separately. For a
workflow-file fix, commit it and publish a new tag/release; rerunning an old release
job retains its old workflow/source context.

Use [full-site push](push-a-local-wordpress-site.md) only when the local database and
complete runtime are the intended replacement for the target. Normal code releases
leave production content and accounts in place.
