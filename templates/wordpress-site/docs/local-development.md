# Local development

Use the project's existing DDEV configuration:

```sh
ddev start
```

For a fresh clone, configure the SSH alias and production WordPress root with
`with-scripts inspect-wordpress`, then use `with-scripts pull-wordpress` to obtain
the local database, WordPress Core, third-party plugins, and uploads. Review the
pull plan and tracked-file protection before importing production data.

Each custom component defines its build and development commands in its own
`package.json`. Run them with the project's configured Node.js runtime. Release
builds use Node.js 24; `with-scripts setup-deployment` checks that runtime and tests
the release package in a temporary copy.

Keep `.with-scripts.json`, credentials, database dumps, and local runtime files
outside Git. Existing DDEV settings are preserved by deployment setup.
