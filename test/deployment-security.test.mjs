import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(root, 'templates/wordpress-site/.github/workflows/deploy-production.yml'), 'utf8');

test('all shipped deployment actions use full immutable commit IDs', () => {
  for (const relative of ['templates/wordpress-site/.github/workflows/deploy-production.yml', 'templates/wordpress-project/deploy-theme.yml', 'templates/wordpress-project/deploy-theme-and-plugin.yml']) {
    const contents = readFileSync(path.join(root, relative), 'utf8');
    const actions = [...contents.matchAll(/uses:\s*([^\s#]+)/g)].map(match => match[1]);
    assert.ok(actions.length >= 3, relative);
    for (const action of actions) assert.match(action, /^[a-zA-Z0-9_/-]+@[a-f0-9]{40}$/, relative);
    assert.match(contents, /persist-credentials: false/);
  }
});

test('build and deploy use separate runners and control code comes from the workflow revision', () => {
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  deploy:'));
  const deploy = workflow.slice(workflow.indexOf('  deploy:'));
  assert.match(build, /runs-on: ubuntu-latest/);
  assert.match(deploy, /runs-on: ubuntu-latest/);
  assert.match(deploy, /needs: build/);
  assert.doesNotMatch(build, /secrets\.|appleboy/);
  assert.match(build, /prepare-deployment\.mjs/);
  assert.doesNotMatch(deploy, /npm|prepare-deployment\.mjs|node --test/);
  assert.match(deploy, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(deploy, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);
  assert.ok(deploy.indexOf('Verify deployment inputs') < deploy.indexOf('secrets.KEY'));
});

test('deployment input check rejects a build-modified control script and altered archive', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'with-scripts-deploy-inputs-'));
  try {
    const temp = path.join(fixture, 'runner');
    const scriptPath = '.github/scripts/remote-deployment.sh';
    mkdirSync(path.join(fixture, '.github/scripts'), { recursive: true });
    mkdirSync(path.join(temp, 'download'), { recursive: true });
    copyFileSync(path.join(root, 'templates/wordpress-site', scriptPath), path.join(fixture, scriptPath));
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['add', '.github'], { cwd: fixture });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Trusted controls'], { cwd: fixture });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const step = workflow.slice(workflow.indexOf('      - name: Verify deployment inputs'), workflow.indexOf('      - name: Validate deployment configuration'));
    const shell = step.split('        run: |\n')[1].trimEnd().split('\n').map(line => line.slice(10)).join('\n');
    const archive = Buffer.from('opaque build artifact');
    const digest = createHash('sha256').update(archive).digest('hex');
    for (const scenario of ['control modified', 'archive modified', 'valid']) {
      execFileSync('git', ['restore', '--', scriptPath], { cwd: fixture });
      writeFileSync(path.join(temp, 'download/with-deployment.tar.gz'), scenario === 'archive modified' ? 'changed' : archive);
      if (scenario === 'control modified') {
        // A component build can write the entire build checkout. Deploy must reject these bytes.
        execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(".github/scripts/remote-deployment.sh", "echo attacker\\n")'], { cwd: fixture });
      }
      const result = spawnSync('bash', ['-s'], { cwd: fixture, input: shell, env: { ...process.env, RUNNER_TEMP: temp, CONTROL_REVISION: revision, ARCHIVE_SHA256: digest }, encoding: 'utf8' });
      assert.equal(result.status === 0, scenario === 'valid', scenario + ': ' + result.stdout + result.stderr);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
