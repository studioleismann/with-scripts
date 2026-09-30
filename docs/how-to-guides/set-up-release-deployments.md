# Set up release deployments

Prepare a GitHub Actions workflow for one custom theme and optionally one built
plugin. The wizard guides SSH-key authorization and creates or replaces five
repository secrets. Publishing a website release later starts deployment.

## Try the interaction

From any folder:

```sh
with-scripts setup-deployment --demo
```

Use `--demo` on its own. Enter advances through the five simulated stages and Ctrl-C
ends the walkthrough. It uses example values and leaves files, browser, keys, GitHub,
and servers untouched.

## Prepare the website repository

Work inside the existing website Git repository; subdirectories are supported.
Check the selected repository and source state:

```sh
git rev-parse --show-toplevel
git remote -v
git status
```

Its `origin` must point to the intended repository on `github.com`. Track the theme
under `wp-content/themes/<slug>/`, including its manifest, lockfile, `style.css`,
`functions.php`, `theme.json`, and screenshot. A built plugin also needs a manifest,
lockfile, root PHP loader, and a public static health-check file under `build/`.
Both selected components need an npm `build` script.

Read [the project requirements](../reference/requirements.md#release-deployment-project)
and check whether npm dependencies will resolve on GitHub's runner. The preview
validates manifests and paths; it never installs or builds those dependencies.

For real setup, prepare:

- GitHub CLI authenticated to `github.com`, with permission to manage repository secrets;
- the actual SSH hostname, username, port, installed WordPress root, and an existing
  writable temp directory outside the public web root;
- a dedicated passphrase-free private-key path outside the repository, with an existing parent directory;
- your provider's public-key installation instructions, hosting panel URL, and
  independently trusted SSH server fingerprint.

Sign in if required:

```sh
gh auth login --hostname github.com
```

## Preview locally

Replace these example values with the website's settings:

```sh
with-scripts setup-deployment --dry-run \
  --theme=example-theme \
  --plugin=none \
  --root=/srv/example/httpdocs \
  --temp=/srv/example/deployment-temp/ \
  --url=https://example.org \
  --host=server.example.org \
  --user=example-account \
  --port=22 \
  --key-file="$HOME/.ssh/example-site-deployment" \
  --hosting-url=https://hosting.example.org
```

For a built plugin, change `--plugin=none` to its slug and add
`--plugin-main=example-plugin.php` and `--plugin-health=build/example.css`, using the
actual loader and public asset. The plugin source list contains its loader and
`build/`; additional required runtime files need a manually reviewed workflow.

The preview checks local files and prints the full workflow. Inspect its upload
list against the files your site needs. It selects standard tracked theme paths and
the generated `build/` directory. A dry run saves no defaults, so retain the command
with your chosen values for apply.

A differing `deploy-production.yml` is preserved and stops setup. Other YAML
workflows referencing `HOST` or `KEY` secrets also stop it. Use the
[manual deployment guide](deploy-custom-wordpress-code.md) to adapt an existing setup.

## Run the five real stages

Rerun the reviewed command with the same options and remove `--dry-run`. Alternatively,
run `with-scripts setup-deployment` and supply missing values interactively. Explicit
options override saved deployment defaults; existing/default values are used without
an extra field prompt, so review the printed plan.

1. **Review project and GitHub access.** Confirm the repository, account, paths,
   components, and key file. GitHub CLI verifies repository access.
2. **Authorize a dedicated key.** Confirm creation of a new Ed25519 key if needed,
   or reuse the specified passphrase-free key. The wizard displays its public key
   and opens your hosting panel. Install that public key for the named account and confirm.
3. **Verify server identity.** Compare scanned host keys with your trusted provider
   or server-console value. Paste the verified SHA256 fingerprint.
4. **Check SSH access and paths.** The wizard tests the dedicated key with the agent
   disabled and the trusted host key pinned. It checks WordPress files, target
   permissions, remote `tar`, and the temp directory's resolved location.
5. **Write GitHub secrets.** Review the exact repository and values. Type
   `SET SECRETS <owner>/<repository>` using the displayed repository name to create
   or replace `HOST`, `USERNAME`, `PORT`, `FINGERPRINT`, and `KEY`.

Private-key bytes are sent from the file to GitHub CLI stdin. After successful writes
and secret-name listing, setup writes `.github/workflows/deploy-production.yml` and
saves `wordpressDeployment` in `.with-scripts.json`. Keep that settings file ignored.

## Verify the first deployment

Review and commit the generated workflow, build/test the components locally, and
follow [Deploy custom WordPress code](deploy-custom-wordpress-code.md).
Setup itself performs no website upload or release publication. A successful setup
confirms its SSH/GitHub steps; the first Actions run tests the runner's build and upload.

The workflow uses the published release tag. Its event includes published
prereleases as described in the [template reference](../reference/project-templates.md#release-workflow-templates).
Choose the intended release process before publishing.

## Resume an incomplete setup

A created key stays at its path. Secrets already written stay in GitHub when a later
write/check fails. The workflow is written only after those stages succeed; a
subsequent local file/configuration failure can still leave a workflow behind.
Inspect local files and repository secret names before retrying.

Retry reuses a matching workflow and key, then deliberately writes the same five
secrets after confirmation. GitHub exposes secret names rather than their stored
values, so verification consists of successful writes and the returned names. The
first real deployment establishes whether the entire setup works together.
