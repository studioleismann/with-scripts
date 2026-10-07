import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const scenario of ['OpenSSH identifiers', 'unrelated email', 'similar name']) {
  test(`privacy check distinguishes protocol identifiers from addresses: ${scenario}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-privacy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts/check-secrets.mjs');
    copyFileSync(new URL('../scripts/check-secrets.mjs', import.meta.url), script);
    // This fixture isolates the privacy guard; the real Gitleaks scan runs separately.
    const scanner = path.join(root, 'gitleaks');
    writeFileSync(scanner, '#!/bin/sh\nif [ "$1" = version ]; then echo 8.30.1; fi\nexit 0\n', { mode: 0o700 });
    const protocols = ['rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519'].map((name) => [name + '-cert-v01', 'openssh.com'].join('@'));
    const address = [scenario === 'similar name' ? 'prefix-ssh-ed25519-cert-v01' : 'contact', 'openssh.com'].join('@');
    const contents = protocols.map((value) => `'${value}'`).join('\n') + (scenario === 'OpenSSH identifiers' ? '' : `\n${address}`);
    writeFileSync(path.join(root, 'protocols.txt'), contents);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GITLEAKS_BIN: scanner };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '--all'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Privacy fixture'], { cwd: root, env });
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, scenario === 'OpenSSH identifiers' ? 0 : 1, result.stdout + result.stderr);
    if (scenario === 'OpenSSH identifiers') assert.match(result.stdout, /Secret\/privacy scan passed/);
    else {
      assert.match(result.stderr, /non-example email address/);
      assert.equal((result.stdout + result.stderr).includes(address), false);
    }
  });
}
