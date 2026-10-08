import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve(import.meta.dirname, '../bin/with-scripts.mjs');
for (const dryRun of [false, true]) {
  for (const scenario of [
    { name: 'valid database slug', slug: 'example-theme', success: true },
    { name: 'explicit slug overrides database', slug: '../uploads/attacker-package', explicit: 'example-theme', success: true },
    { name: 'current theme overrides database', slug: '../uploads/attacker-package', themeCwd: true, success: true },
    { name: 'sibling traversal', slug: '../uploads/attacker-package' },
    { name: 'parent traversal', slug: '../../outside' },
    { name: 'forward separator', slug: 'example/theme' },
    { name: 'backslash separator', slug: 'example\\theme' },
    { name: 'empty stylesheet', slug: '' },
    { name: 'absolute path', slug: '/tmp/attacker-package' },
    { name: 'linked theme', slug: 'example-theme', link: 'wp-content/themes/example-theme' },
    { name: 'linked themes ancestry', slug: 'example-theme', link: 'wp-content/themes' },
    { name: 'linked content ancestry', slug: 'example-theme', link: 'wp-content' },
    { name: 'linked package manifest', slug: 'example-theme', link: 'wp-content/themes/example-theme/package.json' },
    { name: 'explicit linked theme', slug: 'example-theme', explicit: 'example-theme', link: 'wp-content/themes/example-theme' },
    { name: 'theme cwd with linked content ancestry', slug: 'example-theme', themeCwd: true, link: 'wp-content' },
  ]) {
    test(`sync-tools ${dryRun ? 'preview' : 'apply'}: ${scenario.name}`, () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-sync-security-')));
      const project = path.join(root, 'project');
      const theme = path.join(project, 'wp-content/themes/example-theme');
      const bin = path.join(root, 'bin');
      const log = path.join(root, 'calls.jsonl');
      try {
        for (const dir of [bin, theme, path.join(project, '.ddev'), path.join(project, 'wp-content/uploads/attacker-package'), path.join(project, 'wp-content/themes/uploads/attacker-package'), path.join(project, 'wp-content/outside')]) mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(project, '.ddev/config.yaml'), 'name: example-project\n');
        for (const dir of [theme, path.join(project, 'wp-content/uploads/attacker-package'), path.join(project, 'wp-content/themes/uploads/attacker-package'), path.join(project, 'wp-content/outside')]) writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
        if (scenario.link) {
          const entry = path.join(project, scenario.link);
          const outside = path.join(root, 'linked-target');
          renameSync(entry, outside);
          symlinkSync(outside, entry);
        }
        for (const command of ['ddev', 'npm', 'unzip']) writeFileSync(path.join(bin, command), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TEST_LOG, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');\nif (process.argv.includes('stylesheet')) console.log(process.env.TEST_SLUG);\n`, { mode: 0o755 });
        const args = [cli, 'sync-tools', `--patterns-source=${bin}`, `--theme-tools-source=${bin}`, `--site-tools-source=${bin}`];
        if (dryRun) args.push('--dry-run');
        if (scenario.explicit) args.push(`--slug=${scenario.explicit}`);
        const result = spawnSync(process.execPath, args, { cwd: scenario.themeCwd ? theme : project, env: { ...process.env, PATH: bin, TEST_SLUG: scenario.slug, TEST_LOG: log }, encoding: 'utf8', timeout: 10000 });
        const output = result.stdout + result.stderr;
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
        assert.equal(result.status, scenario.success ? 0 : 1, output);
        if (scenario.success) {
          assert.ok(calls.some(call => call.command === 'npm' && call.args[1] === theme), output);
          assert.equal(calls.some(call => call.args.includes('stylesheet')), !scenario.explicit && !scenario.themeCwd);
        } else {
          assert.equal(calls.some(call => call.command === 'npm' || call.command === 'unzip'), false, JSON.stringify(calls));
          assert.equal(calls.some(call => call.args.includes('activate')), false, output);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
