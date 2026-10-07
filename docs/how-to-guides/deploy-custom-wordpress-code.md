# Deploy custom WordPress code

Use [Set up a website repository and release deployment](set-up-release-deployments.md)
to prepare the repository, release package, dedicated SSH key, and GitHub settings.
The generated [deployment guide](../../templates/wordpress-site/docs/deployment.md)
describes production transactions, rollback, and recovery.

## Review the release source

```sh
git branch --show-current
git remote -v
git status
git log -1 --oneline
```

Review tracked custom themes, plugins, and MU-plugins. Their complete runtime
payload must be present in the release package. A component with `package.json`
uses its `files` array and build script; one without it is exported from Git.
WordPress Core, third-party plugins, uploads, credentials, and database dumps belong
outside the code release. Removing an owned component from Git removes it from
production on the next successful release.

## Build and test

With Node.js 24, from the website repository root:

```sh
WITH_DEPLOY_FULL_TESTS=1 node --test .github/scripts/deployment.test.mjs
node .github/scripts/prepare-deployment.mjs /tmp/example-deployment.tar.gz
```

The packager installs/builds npm components in its current checkout. Use a temporary
copy to preserve development dependencies and generated files, as `setup-deployment`
does automatically. It refuses to overwrite an existing output archive. Dependencies
must resolve in a clean GitHub runner; local sibling `file:` dependencies need a
release-compatible arrangement. Run component lint/tests and inspect the local site.

## Check configuration

The private website repository needs variables `WORDPRESS_ROOT` and `LIVE_URL`,
and secrets `HOST`, `USERNAME`, `PORT`, `FINGERPRINT`, and `KEY`. Confirm the trusted
server fingerprint selected by the deployment Actions, the intended account, writable
WordPress paths, and public IPv4 SSH reachability from GitHub Actions. Setup verifies the key with the
personal agent disabled and runs the remote read-only preflight.

## Publish the reviewed tag

Choose an unused version tag from the clean, reviewed commit:

```sh
git tag v1.0.0
git push origin HEAD
git push origin v1.0.0
gh release create v1.0.0 --verify-tag --generate-notes
```

The final command publishes the release and starts deployment from that exact tag.
Published prereleases also deploy. A normal push or draft release does not trigger
the generated deployment workflow.

## Verify production and recover failures

Inspect the Actions run, its artifact preparation, transaction switch, and HTTP
checks. Then verify the changed pages and application behavior in the live site.
HTTP checks establish availability; they do not establish visual/editor correctness.
Keep production backups through the site's normal backup process.

Build/preparation failures stop before switching live components. A failed smoke
check triggers rollback; an incomplete rollback retains maintenance/recovery
material. Follow the generated deployment guide before manually removing it.

Correct a broken code release by publishing a reviewed fixed or known-good revision
under a new tag. Workflow changes also require a new release revision; retrying an
old release retains its workflow/source context.

Use [full-site push](push-a-local-wordpress-site.md) only for a deliberately planned
replacement of the database and full runtime. Code releases preserve live content
and accounts.
