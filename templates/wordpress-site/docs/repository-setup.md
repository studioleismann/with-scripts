# Repository setup

This repository uses the versioned `wordpress-site` template shipped with
`with-scripts`. `.github/with-scripts-deployment.json` records its version and
hashes. Run `with-scripts setup-deployment --dry-run` to preview a refresh.

The GitHub owner is chosen during setup or inferred from `origin`. Setup creates
a private repository when needed, verifies the release package, authorizes a
dedicated deployment key through existing SSH access, and configures these values:

- Variables: `WORDPRESS_ROOT`, `LIVE_URL`.
- Secrets: `HOST`, `USERNAME`, `PORT`, `FINGERPRINT`, `KEY`.

Public setup settings and resumable progress are kept in the ignored
`.with-scripts.json`. The private deployment key stays outside the repository;
its bytes are sent to GitHub CLI through standard input.

Setup preserves existing keys, DDEV configuration, and project-specific ignore
rules. Existing documentation is kept. Modified deployment template files produce
a diff and stop the update so that changes can be merged deliberately.

Before adding another owned component, rerun setup with a repeatable
`--component=wp-content/plugins/example-plugin` or the appropriate theme/mu-plugin
path. Already tracked components retain ownership. Removing a tracked component
from Git schedules its removal on the next published release.

Setup commits and pushes the reviewed website source. Publishing the first release
and checking its Actions run is a separate step.
