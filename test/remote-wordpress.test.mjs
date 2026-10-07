import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
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

const fixturePhp = spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' });

for (const scenario of [
  { name: 'preserves a working default ahead of newer installed versions', defaultVersion: 80100, alternatives: true, selected: 'php' },
  { name: 'replaces a CGI default with the newest working CLI', defaultVersion: 0, alternatives: true, selected: 'php8.5-cli' },
  { name: 'finds a CLI when the unversioned command is missing', missingDefault: true, alternatives: true, selected: 'php8.5-cli' },
  { name: 'reports an actionable error when only CGI is available', defaultVersion: 0, failure: /No working PHP CLI/ },
  { name: 'checks the WordPress root before running PHP', defaultVersion: 0, alternatives: true, missingConfig: true, failure: /Check the remote WordPress root/ },
]) {
  test(`remote PHP: ${scenario.name}`, { skip: fixturePhp.status !== 0 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-php-test-'));
    const project = path.join(root, 'wordpress');
    const bin = path.join(root, 'bin with spaces');
    const commandLog = path.join(root, 'commands.jsonl');
    try {
      mkdirSync(bin);
      for (const directory of ['wp-admin', 'wp-content', 'wp-includes']) {
        mkdirSync(path.join(project, directory), { recursive: true });
      }
      if (!scenario.missingConfig) {
        writeFileSync(path.join(project, 'wp-config.php'), `<?php
define('DB_NAME', 'example_db');
define('DB_USER', 'example_user');
define('DB_PASSWORD', 'fixture-password');
define('DB_HOST', 'database.example:3307');
$table_prefix = 'example_';
`);
      }
      writeFileSync(path.join(project, 'wp-includes/version.php'), "<?php $wp_version = '7.1.3';\n");
      const commands = ['mysql', 'mysqldump', 'tar', ...(scenario.missingDefault ? [] : ['php'])];
      if (scenario.alternatives) commands.push('php8.4-cli', 'php8.5-cli', 'php8.6', 'php8.6-fpm');
      for (const command of commands) {
        writeFileSync(path.join(bin, command), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ command, args }) + '\\n');
if (command.startsWith('php')) {
  const versions = { php: Number(process.env.TEST_DEFAULT_PHP), 'php8.4-cli': 80400, 'php8.5-cli': 80500 };
  if (!versions[command]) {
    console.error('Error in argument 1, char 2: option not found r');
    process.exit(1);
  }
  if (args[0] === '-r' && args[1].includes('echo PHP_VERSION_ID;')) {
    console.log(versions[command]);
    process.exit(0);
  }
  const result = spawnSync(process.env.TEST_REAL_PHP, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (command === 'mysql') {
  const query = args.at(-1);
  if (query.includes("CONCAT(option_name")) console.log('home=https://example.org\\nsiteurl=https://example.org');
  else if (query.includes("option_name='home'")) console.log('https://example.org');
  else if (query.includes('@@version_comment')) console.log('MySQL Community Server');
  else if (query.includes('SELECT VERSION()')) console.log('8.0.40');
}
if (command === 'mysqldump') console.log('-- Example database stream');
`, { mode: 0o755 });
      }
      symlinkSync('/usr/bin/gzip', path.join(bin, 'gzip'));
      const env = {
        ...process.env, PATH: bin, BASH_ENV: '', TEST_COMMAND_LOG: commandLog,
        TEST_REAL_PHP: fixturePhp.stdout.trim(), TEST_DEFAULT_PHP: String(scenario.defaultVersion || 0),
      };
      for (const build of [buildPreflightScript, buildInspectionScript, buildEnvironmentScript, buildDatabaseStreamScript]) {
        const result = spawnSync('/bin/bash', ['-s', '--', project], { input: build(), env });
        const stderr = result.stderr.toString();
        const stdout = result.stdout.toString();
        if (scenario.failure) {
          assert.notEqual(result.status, 0);
          assert.match(stderr, scenario.failure);
          assert.doesNotMatch(stderr, /option not found r/);
          continue;
        }
        assert.equal(result.status, 0, stderr);
        assert.equal(stderr, '');
        assert.doesNotMatch(stdout, /fixture-password/);
        if (build === buildInspectionScript) {
          assert.ok(stdout.includes(`Executable: ${path.join(bin, scenario.selected)}`));
          assert.match(stdout, /PHP CLI \(SSH\)/);
          assert.match(stdout, /Website PHP version: not determined/);
          assert.match(stdout, /WordPress 7\.1\.3/);
          assert.match(stdout, /home=https:\/\/example\.org/);
        }
        if (build === buildEnvironmentScript) {
          assert.match(stdout, /WITH_SCRIPTS_LIVE_URL=https:\/\/example\.org/);
          assert.match(stdout, /WITH_SCRIPTS_DATABASE_VERSION=8\.0/);
        }
        if (build === buildDatabaseStreamScript) {
          assert.equal(gunzipSync(result.stdout).toString(), '-- Example database stream\n');
        }
      }
      if (scenario.missingConfig) {
        assert.throws(() => readFileSync(commandLog), { code: 'ENOENT' });
      } else {
        const calls = readFileSync(commandLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.ok(calls.every(({ command }) => command !== 'php8.6-fpm'));
        const executedPhp = calls.filter(({ command, args }) => command.startsWith('php') && !args[1]?.includes('echo PHP_VERSION_ID;'));
        assert.ok(executedPhp.every(({ command }) => command === scenario.selected));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
