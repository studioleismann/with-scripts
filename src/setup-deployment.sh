#!/usr/bin/env bash
# Offline walkthrough; the real setup is implemented in setup-deployment.mjs.
set -euo pipefail
[[ "${1:-}" = --demo ]] || { printf '%s\n' 'Run with-scripts setup-deployment.' >&2; exit 1; }
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' 'Deployment wizard demo' 'All five stages use example values and simulate the setup.' 'Press Enter to advance; Ctrl-C ends the demo.'
read -r _ || true
printf '%s\n' 'Stage 1/5 · Demo · Choose the website repository' 'GitHub owner and repository are freely selectable: example-owner/example-site.'
printf '%s' 'Theme slug for this walkthrough [example-theme]: '
read -r demo_theme || true
demo_theme=${demo_theme:-example-theme}
printf 'Owned component: wp-content/themes/%s\n' "$demo_theme"
read -r _ || true
printf '%s\n' 'Stage 2/5 · Demo · Prepare and validate the website template' 'Real setup merges ignore rules, preserves DDEV settings, and tests the release package in a temporary copy using Node.js 24.'
read -r _ || true
printf '%s\n' 'Stage 3/5 · Demo · Authorize and verify the deployment key' 'Real setup pins a trusted server host key, appends the dedicated public key through existing SSH access, and verifies it with the agent disabled.'
read -r _ || true
printf '%s\n' 'Stage 4/5 · Demo · Configure GitHub' 'Real setup creates or reuses the private repository and verifies two variables and five secrets.' 'Existing secrets require explicit replacement approval when their saved setup differs.'
read -r _ || true
printf '%s\n' 'Stage 5/5 · Demo · Commit and push the website source' 'Real setup commits and pushes the reviewed source, then verifies the remote commit.' 'Publishing a release later starts deployment from that tag, including published prereleases.'
read -r _ || true
printf '%s\n' 'Demo complete. All steps were simulated; files, keys, and GitHub are unchanged.'
