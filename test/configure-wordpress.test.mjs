import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildConfigurePhp,
  parseConfigureWordPressArgs,
  pixelsFromLayout,
} from '../src/configure-wordpress.mjs';

test('configure-wordpress follows the profile command-line contract', () => {
  assert.deepEqual(parseConfigureWordPressArgs([]), {
    profileName: 'standard',
    dryRun: false,
    check: false,
  });
  assert.deepEqual(parseConfigureWordPressArgs(['--profile=standard', '--dry-run']), {
    profileName: 'standard',
    dryRun: true,
    check: false,
  });
  assert.deepEqual(parseConfigureWordPressArgs(['--check']), {
    profileName: 'standard',
    dryRun: false,
    check: true,
  });
  assert.throws(() => parseConfigureWordPressArgs(['--profile=customer']), /Unknown WordPress profile/);
  assert.throws(() => parseConfigureWordPressArgs(['--dry-run', '--check']), /either --dry-run or --check/);
  assert.throws(() => parseConfigureWordPressArgs(['--remote']), /Unknown option/);
});

test('theme layout sizes use pixels or the documented fallbacks', () => {
  assert.equal(pixelsFromLayout('720px', 640), 720);
  assert.equal(pixelsFromLayout('720.4px', 640), 720);
  assert.equal(pixelsFromLayout(960, 640), 960);
  assert.equal(pixelsFromLayout('40rem', 640), 640);
  assert.equal(pixelsFromLayout('clamp(40rem, 80vw, 80rem)', 1280), 1280);
});

test('generated WordPress configuration is valid PHP and preserves safety markers', (t) => {
  const php = buildConfigurePhp({
    samples: [],
    pages: {
      home: { selection: 'Startseite', status: 'publish' },
      blog: { selection: 'Blog', status: 'publish' },
      legal: { selection: 'Rechtliches', status: 'draft' },
      privacy: { selection: 'Datenschutzerklärung', status: 'draft', parent: 'legal' },
      imprint: { selection: 'Impressum', status: 'draft', parent: 'legal' },
    },
    options: {},
    closeExistingComments: false,
    media: null,
    defaultCategory: 1,
    configureActivityLog: true,
    activityLogDays: 128,
  });

  assert.match(php, /_with_scripts_setup_key/);
  assert.match(php, /is_multisite\(\)/);
  assert.match(php, /WITH_SCRIPTS_JSON/);

  const availability = spawnSync('php', ['-v'], { stdio: 'ignore' });
  if (availability.error) {
    t.skip('PHP CLI is unavailable');
    return;
  }

  const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-php-test-'));
  const file = path.join(root, 'configure.php');
  try {
    writeFileSync(file, `<?php\n${php}\n`);
    const result = spawnSync('php', ['-l', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help lists the established WordPress, theme, and shared-tools commands', () => {
  const result = spawnSync(process.execPath, ['./bin/with-scripts.mjs', '--help'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configure-wordpress/);
  assert.match(result.stdout, /setup-theme/);
  assert.match(result.stdout, /sync-tools/);
  assert.doesNotMatch(result.stdout, /wordpress:setup/);
});
