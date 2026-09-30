# Work with multiple WordPress sites

Give each WordPress installation its own DDEV project and project-root Git repository,
even when sites share a hosting account.

## Create separate folders

```text
projects/
  example/
    main-website/
    portal/
```

Create both folders, then set up the first installation:

```sh
mkdir -p ~/code/projects/example/main-website
mkdir -p ~/code/projects/example/portal
cd ~/code/projects/example/main-website
with-scripts setup-wordpress
```

Use the main site's remote root and a unique DDEV project name/local URL. Repeat
from the second folder with the portal's root:

```sh
cd ~/code/projects/example/portal
with-scripts setup-wordpress
```

If generated names collide, choose distinct DDEV names and matching local URLs.
For example, use `example-main` with `https://example-main.ddev.site` and
`example-portal` with `https://example-portal.ddev.site`.

## Pull each installation

```sh
cd ~/code/projects/example/main-website
with-scripts pull-wordpress
```

Then change to the portal folder:

```sh
cd ~/code/projects/example/portal
with-scripts pull-wordpress
```

Each directory stores its own `.ddev/config.yaml` and `.with-scripts.json`. A shared
SSH alias is fine; verify the distinct remote roots and URLs at every review.

## Keep transfer targets explicit

Within each settings file, `wordpressPull`, `wordpressPush`, and
`wordpressDeployment` are independent. A local preview site can pull from one
installation and deploy to another only when you configure each target explicitly.

Deployment setup takes its GitHub repository from the current website's `origin`.
Check that origin before configuring secrets. Use the
[configuration reference](../reference/configuration.md) to review saved defaults.
