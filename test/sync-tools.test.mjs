import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseSyncToolsArgs,
  resolveToolTargets,
} from '../src/sync-tools.mjs';

test('sync-tools supports an optional theme slug and read-only preview', () => {
  assert.deepEqual(parseSyncToolsArgs([]), {
    slug: '',
    toolSources: {},
    dryRun: false,
  });
  assert.deepEqual(parseSyncToolsArgs(['--slug=exampletheme', '--dry-run']), {
    slug: 'exampletheme',
    toolSources: {},
    dryRun: true,
  });
  assert.throws(() => parseSyncToolsArgs(['--update-base']), /Unknown option/);
  assert.throws(
    () => parseSyncToolsArgs(['--slug=../../customer']),
    /Theme slug/,
  );
  assert.deepEqual(parseSyncToolsArgs([
    '--patterns-source=/tmp/example-patterns',
    '--theme-tools-source=/tmp/example-theme-tools',
    '--site-tools-source=/tmp/example-site-tools',
  ]).toolSources, {
    patterns: '/tmp/example-patterns',
    themeTools: '/tmp/example-theme-tools',
    siteTools: '/tmp/example-site-tools',
  });
  assert.throws(() => parseSyncToolsArgs(['--site-tools-source=']), /Provide a local directory/);
});

test('sync-tools detects a theme root without querying WordPress', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'with-scripts-tools-'));
  const theme = path.join(project, 'wp-content', 'themes', 'exampletheme');
  try {
    const targets = resolveToolTargets(theme);
    assert.deepEqual(targets, {
      projectRoot: project,
      themeRoot: theme,
      slug: 'exampletheme',
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
