import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDatabaseStreamScript,
  buildEnvironmentScript,
  buildFileStreamScript,
  buildInspectionScript,
  buildPreflightScript,
  normalizeUrl,
} from '../src/remote-wordpress.mjs';

test('all remote scripts are valid Bash', () => {
  const builders = [
    buildPreflightScript,
    buildEnvironmentScript,
    buildInspectionScript,
    buildDatabaseStreamScript,
    buildFileStreamScript,
  ];

  for (const build of builders) {
    const result = spawnSync('bash', ['-n'], {
      input: build(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('preflight works without optional Unix tools', () => {
  const script = buildPreflightScript();
  assert.doesNotMatch(script, /\b(?:awk|cut|du|sort|tail)\b/);
  assert.doesNotMatch(script, /<\s*<\(/);
  assert.match(script, /Production access: read only/);
  assert.match(script, /Remote wp-config\.php is not readable/);
  assert.match(script, /Required remote command is unavailable/);
});

test('preflight identifies an incomplete remote WordPress root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-preflight-test-'));
  try {
    mkdirSync(path.join(root, 'wp-admin'));
    mkdirSync(path.join(root, 'wp-content'));
    mkdirSync(path.join(root, 'wp-includes'));
    const result = spawnSync('bash', ['-s', '--', root], {
      input: buildPreflightScript(),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remote wp-config\.php is not readable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid URLs get an actionable error', () => {
  assert.throws(
    () => normalizeUrl('not-a-url'),
    { message: 'URL must be a valid http or https URL.' },
  );
});

test('production data streams to stdout without remote archives', () => {
  const database = buildDatabaseStreamScript();
  const files = buildFileStreamScript();

  assert.match(database, /--single-transaction/);
  assert.match(database, /--skip-lock-tables/);
  assert.match(database, /set -euo pipefail/);
  assert.match(database, /\| gzip -c/);
  assert.doesNotMatch(database, /\.sql(?:\.gz)?/);
  assert.doesNotMatch(database, /TABLE_PREFIX/);
  assert.match(files, /-czf - \./);
  assert.match(files, /--exclude='\.\/\.git'/);
  assert.doesNotMatch(files, /-czf\s+[^-]/);
});

test('home-relative roots avoid double slashes', () => {
  const script = buildPreflightScript();
  assert.match(script, /\$\{HOME%\/\}\/\$\{1:2\}/);
});
