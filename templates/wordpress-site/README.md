# {{PROJECT_NAME}}

WordPress website repository for {{LIVE_URL}}.

Git tracks the selected custom themes, plugins, project documentation, deployment
scripts, and existing DDEV configuration. WordPress Core, third-party components,
uploads, database dumps, credentials, and machine-local settings are excluded.

Repository-owned components:

{{COMPONENT_LIST}}

- [Local development](docs/local-development.md)
- [Deployment](docs/deployment.md)
- [Repository setup](docs/repository-setup.md)
- [Deployment replacement contract](docs/deployment-replacement-spec.md)

Publishing a GitHub Release deploys the code from its tag. Published prereleases
also deploy. Review the target and release commit before publishing.
