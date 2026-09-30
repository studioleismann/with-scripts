# Pulls, full-site pushes, and release deployments

Choose a workflow by the data you want to transfer and which copy should become
the destination's state.

| Workflow | Source → destination | What changes |
| --- | --- | --- |
| `pull-wordpress` | Hosted WordPress → local DDEV | Local database and remote file copies, with Git protections |
| `push-wordpress` | Local DDEV → explicit hosted WordPress | Target database and managed runtime paths after backup/review |
| Published-release workflow | Tagged website source → hosted WordPress | Selected custom theme/plugin files |

## A pull refreshes development data

A pull supplies current production content, uploads, third-party packages, and
database state for local development. Git-tracked project files are restored after
copying, and Git-managed theme/plugin packages stay local as complete units.

The result intentionally combines the imported site's data with protected local
custom code. That code can differ from the version running on production, so review
compatibility after every pull. The local database snapshot provides a return point
for overwritten local content.

## A full-site push makes the local site authoritative

A push treats the local database and copied runtime as the replacement for the
explicit target. Local accounts, orders, forms, content, and plugin settings become
the target's state. This can fit a planned first launch or a deliberate full-site
replacement, provided the operator has resolved newer target changes.

The command inventories content, prepares an export, backs up the target, and retains
a rollback handler through the scripted checks. Those safeguards help recover from
a failed transfer. They do not merge two independently edited websites.

## A release publishes selected code

A release workflow builds from the published tag and uploads selected custom code.
It leaves the existing production database, uploads, accounts, and other packages in
place. Git versioning and review apply to the files in that source state.

`setup-deployment` prepares this workflow and its SSH/GitHub configuration. Publishing
a release is a separate action. The bundled workflow is a sequential overwrite
upload with HTTP checks; backups, atomic switching, stale-file cleanup, and rollback
need their own deployment process.

## WordPress stores important work outside Git

Posts, menus, plugin settings, and saved Site Editor templates/styles live in the
database. A theme release cannot publish those database edits by itself. Move them
through a reviewed content/configuration migration, or use a full-site push when
replacing the entire target is the intended operation.

With Base also has a separate role: `setup-theme` creates a local starter copy.
`sync-tools` updates the local shared runtimes. Their changes reach production through
the chosen release or full-site transfer process.

Use the relevant guide:

- [Refresh a local copy](../how-to-guides/pull-the-latest-production-copy.md)
- [Push a complete site](../how-to-guides/push-a-local-wordpress-site.md)
- [Set up releases](../how-to-guides/set-up-release-deployments.md)
- [Publish custom code](../how-to-guides/deploy-custom-wordpress-code.md)
