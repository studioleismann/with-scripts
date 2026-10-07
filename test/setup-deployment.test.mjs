import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(packageRoot, 'bin', 'with-scripts.mjs');

for (const command of ['inspect-wordpress', 'setup-wordpress', 'pull-wordpress', 'configure-wordpress', 'setup-theme', 'sync-tools', 'push-wordpress', 'setup-deployment']) {
  test(`${command} help and unknown options stop before project access`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-options-'));
    try {
      writeFileSync(path.join(root, '.with-scripts.json'), 'invalid JSON');
      for (const flag of ['--help', '-h', '--invalid-option']) {
        const result = spawnSync(process.execPath, [cli, command, flag], { cwd: root, input: '', encoding: 'utf8', timeout: 3000 });
        assert.equal(result.status, flag === '--invalid-option' ? 1 : 0, result.stderr);
        assert.match(result.stdout + result.stderr, flag === '--invalid-option' ? /Unknown (?:push )?option/i : /Usage: with-scripts/);
        assert.doesNotMatch(result.stdout + result.stderr, /Invalid .with-scripts.json|SSH target:|unsettled top-level await/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('pull rejects unsupported dry-run and an EOF produces an actionable error', () => {
  for (const [command, args, message] of [
    ['pull-wordpress', ['--dry-run'], /Unknown option for pull-wordpress/],
    ['inspect-wordpress', [], /Input closed.*interactive terminal/],
  ]) {
    const result = spawnSync(process.execPath, [cli, command, ...args], { cwd: packageRoot, input: '', encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  }
});

test('deployment demo works in an empty folder without project or service access', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-demo-')));
  const project = path.join(root, 'empty-project');
  const bin = path.join(root, 'bin');
  const commandLog = path.join(root, 'external-commands');
  try {
    mkdirSync(project);
    mkdirSync(bin);
    for (const command of ['git', 'gh', 'ssh', 'ssh-keygen', 'ssh-keyscan', 'ddev', 'open', 'xdg-open', 'wslview', 'explorer.exe']) {
      writeFileSync(path.join(bin, command), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.TEST_COMMAND_LOG, ${JSON.stringify(command)} + '\\n'); process.exit(1);\n`, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo'], {
      cwd: project, input: '\ndemo-theme\n\n\n\n\n\n', encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: commandLog },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Stage 1\/5.*Demo/);
    assert.match(result.stdout, /Stage 5\/5.*Demo/);
    assert.match(result.stdout, /wp-content\/themes\/demo-theme/);
    assert.match(result.stdout, /Demo complete.*All steps were simulated/);
    assert.doesNotMatch(result.stdout, /Deployment setup complete|Setup complete|✓ set/);
    assert.equal(existsSync(commandLog), false, 'Demo must not call Git, SSH, GitHub CLI, or a browser.');
    assert.deepEqual(readdirSync(project), []);

    writeFileSync(path.join(project, '.with-scripts.json'), 'invalid JSON');
    const retry = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo'], {
      cwd: project, input: '', encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: commandLog },
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(path.join(project, '.with-scripts.json'), 'utf8'), 'invalid JSON');
    assert.equal(existsSync(commandLog), false);
    for (const option of ['--dry-run', '--host=real.example.org']) {
      const invalid = spawnSync(process.execPath, [cli, 'setup-deployment', '--demo', option], { cwd: project, input: '', encoding: 'utf8', timeout: 3000 });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Use --demo on its own/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function website(t, { repository = false, origin = 'git@github.com:example-owner/example.org.git' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-website-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'site');
  const bin = path.join(root, 'bin');
  const server = path.join(root, 'server');
  const remoteRoot = path.join(server, 'httpdocs');
  for (const directory of [project, bin, server, path.join(root, 'keys'), path.join(project, 'wp-content/themes/example-theme'), path.join(project, '.ddev'), ...['wp-admin', 'wp-includes', 'wp-content'].map((name) => path.join(remoteRoot, name))]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(remoteRoot, 'wp-load.php'), '<?php\n');
  writeFileSync(path.join(project, '.ddev/config.yaml'), 'name: example-site\ntype: wordpress\nphp_version: "8.3"\nnodejs_version: "24"\n');
  writeFileSync(path.join(project, 'wp-content/themes/example-theme/style.css'), '/* Theme Name: Example */\n');
  writeFileSync(path.join(project, 'wp-content/themes/example-theme/functions.php'), '<?php\n');
  writeFileSync(path.join(project, 'wp-content/themes/example-theme/package.json'), JSON.stringify({ name: 'example-theme', version: '1.0.0', files: ['style.css', 'functions.php'] }));
  writeFileSync(path.join(project, 'wp-config.php'), 'local credentials stay here');
  mkdirSync(path.join(project, 'wp-content/uploads'), { recursive: true });
  writeFileSync(path.join(project, 'wp-content/uploads/image.jpg'), 'local media');
  writeFileSync(path.join(root, 'gitconfig'), '[user]\n name = Example\n email = example@example.org\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), TEST_ROOT: root, REAL_GIT: realGit, GH_PROMPT_DISABLED: '1', CI: '1', NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'example host', '-f', path.join(root, 'host-key')]);
  writeFileSync(path.join(root, 'known_hosts'), `server.example.org ${readFileSync(path.join(root, 'host-key.pub'), 'utf8')}`);
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ repository, owner: 'example-owner/example.org', secrets: {}, variables: {}, head: '' }), { mode: 0o600 });
  const shared = `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process'; const root=process.env.TEST_ROOT; const args=process.argv.slice(2); const stateFile=path.join(root,'state.json'); const state=JSON.parse(fs.readFileSync(stateFile,'utf8')); fs.appendFileSync(path.join(root,'calls'), JSON.stringify([path.basename(process.argv[1]), ...args])+'\\n');\n`;
  writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\n${shared}
if (args[0] === 'ls-remote') { if (state.head) console.log(state.head+'\\trefs/heads/main'); process.exit(0); }
if (args.includes('push')) {
 if(process.env.FAIL_PUSH) process.exit(1);
 const result=spawnSync(process.env.REAL_GIT,['rev-parse','HEAD'], {encoding:'utf8'}); state.head=result.stdout.trim(); fs.writeFileSync(stateFile,JSON.stringify(state)); process.exit(result.status);
}
const result=spawnSync(process.env.REAL_GIT,args,{stdio:'inherit'}); process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\n${shared}
if(args[0]==='auth') process.exit(0);
if(args[0]==='api') {
 if(!state.repository){console.error('HTTP 404');process.exit(1);}
 console.log(JSON.stringify({private:!process.env.PUBLIC_REPO, permissions:{admin:true}, size:state.head?1:0, default_branch:'main', full_name:state.owner, ssh_url:'git@github.com:'+state.owner+'.git'}));process.exit(0);
}
if(args[0]==='repo' && args[1]==='create'){state.repository=true;state.owner=args[2];}
else if(args[1]==='list') {
 console.log(JSON.stringify(Object.entries(state[args[0]==='secret'?'secrets':'variables']).map(([name,value])=>args[0]==='secret'?{name}:{name,value})));process.exit(0);
} else if(args[1]==='set') {
 if(args[0]==='secret' && process.env.FAIL_SECRET===args[2]) process.exit(1);
 const value=fs.readFileSync(0,'utf8'); state[args[0]==='secret'?'secrets':'variables'][args[2]]=value;
} else {console.error('Unexpected GitHub call');process.exit(2);}
fs.writeFileSync(stateFile,JSON.stringify(state));
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}\n${shared}
if(args[0]==='-G') { console.log('hostname server.example.org\\nuser example-account\\nport 22\\nuserknownhostsfile '+path.join(root,'known_hosts'));process.exit(0); }
if(args.at(-1)==='true') { process.exit(fs.existsSync(path.join(root,'authorized'))?0:1); }
if(args.at(-1).includes('preflight')) {
 if(process.env.FAIL_PREFLIGHT) process.exit(1);
 const result=spawnSync('sh',['-s','--','preflight',path.join(root,'server/httpdocs'),'1234-1'],{input:fs.readFileSync(0),stdio:['pipe','inherit','inherit']});process.exit(result.status);
}
const publicKey=args.at(-1).match(/sh -s -- '([^']+)'/)?.[1];
if(!publicKey) {console.error('Unexpected SSH call');process.exit(2);}
const result=spawnSync('sh',['-s','--',publicKey],{input:fs.readFileSync(0),stdio:['pipe','inherit','inherit'],env:{...process.env,HOME:path.join(root,'server')}});
if(result.status===0)fs.writeFileSync(path.join(root,'authorized'),'yes');process.exit(result.status);
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'ddev'), `#!${process.execPath}\n${shared}
if(args.join(' ')==='exec node --version'){if(process.env.FAIL_DDEV_VERSION)process.exit(1);console.log('v24.0.0');process.exit(0);}
if(args[1]==='sh'){
 const script=fs.readFileSync(0,'utf8');fs.writeFileSync(path.join(root,'build-script'),script);
 if(!script.includes('WITH_DEPLOY_FULL_TESTS=1') || !script.includes('prepare-deployment.mjs'))process.exit(2);
 if(process.env.FAIL_BUILD)process.exit(1);
}
`, { mode: 0o755 });
  if (repository) {
    execFileSync(realGit, ['init', '-q'], { cwd: project, env });
    execFileSync(realGit, ['add', 'wp-content/themes', '.ddev'], { cwd: project, env });
    execFileSync(realGit, ['commit', '-qm', 'Existing website'], { cwd: project, env });
    if (origin) execFileSync(realGit, ['remote', 'add', 'origin', origin], { cwd: project, env });
  }
  const args = ['setup-deployment', '--repo=example-owner/example.org', '--theme=example-theme', '--ssh=example-site', `--root=${remoteRoot}`, '--url=https://example.org', `--key-file=${root}/keys/deployment`];
  return { root, project, server, remoteRoot, env, args };
}

for (const existing of [false, true]) {
  test(`dry-run plans ${existing ? 'an existing' : 'a new'} website without service mutations`, (t) => {
    const fixture = website(t, { repository: existing });
    const before = readdirSync(fixture.project);
    const result = spawnSync(process.execPath, [cli, ...fixture.args, '--dry-run'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /wordpress-site 1.0.0/);
    assert.match(result.stdout, /example-owner\/example.org/);
    assert.deepEqual(readdirSync(fixture.project), before);
    assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
    const calls = readFileSync(path.join(fixture.root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.some(([command, arg]) => command === 'gh' || command === 'ddev' || (command === 'ssh' && arg !== '-G')), false);
  });
}

test('owner is chosen freely and existing origin wins over saved owner', (t) => {
  const fixture = website(t, { repository: true, origin: 'ssh://git@github.com:22/another-owner/another-site.git/' });
  writeFileSync(path.join(fixture.project, '.with-scripts.json'), JSON.stringify({ wordpressDeployment: { repo: 'old-owner/old-site' } }));
  const args = fixture.args.filter((arg) => !arg.startsWith('--repo='));
  const result = spawnSync(process.execPath, [cli, ...args, '--dry-run'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /another-owner\/another-site \(from origin\)/);
  const mismatch = spawnSync(process.execPath, [cli, ...fixture.args, '--dry-run'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /differs from origin/);
});

test('saved pull target resolves SSH settings and works from a theme directory', (t) => {
  const fixture = website(t);
  writeFileSync(path.join(fixture.project, '.with-scripts.json'), JSON.stringify({ wordpressPull: { sshTarget: 'example-site', remoteRoot: fixture.remoteRoot, liveUrl: 'https://example.org' } }));
  const args = fixture.args.filter((arg) => !/^--(?:root|ssh|url|theme)=/.test(arg));
  const result = spawnSync(process.execPath, [cli, ...args, '--dry-run'], { cwd: path.join(fixture.project, 'wp-content/themes/example-theme'), env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /example-account@server.example.org:22/);
});

for (const scenario of ['template conflict', 'tracked secret', 'untracked key bytes', 'source symlink', 'nested repository', 'staged changes', 'dirty changes', 'unsafe root', 'alias mismatch', 'missing package files']) {
  test(`setup preserves the project on ${scenario}`, (t) => {
    const fixture = website(t, { repository: true });
    if (scenario === 'template conflict') {
      mkdirSync(path.join(fixture.project, '.github/workflows'), { recursive: true });
      writeFileSync(path.join(fixture.project, '.github/workflows/deploy-production.yml'), 'name: Existing deployment\n');
    }
    if (scenario === 'tracked secret') {
      writeFileSync(path.join(fixture.project, 'private.key'), 'private material');
      execFileSync(realGit, ['add', 'private.key'], { cwd: fixture.project, env: fixture.env });
      execFileSync(realGit, ['commit', '-qm', 'Fixture tracked secret'], { cwd: fixture.project, env: fixture.env });
    }
    if (scenario === 'untracked key bytes') writeFileSync(path.join(fixture.project, 'accidental.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n');
    if (scenario === 'source symlink') symlinkSync(path.join(fixture.root, 'known_hosts'), path.join(fixture.project, 'linked.txt'));
    if (scenario === 'nested repository') mkdirSync(path.join(fixture.project, 'wp-content/themes/example-theme/.git'));
    if (scenario === 'staged changes' || scenario === 'dirty changes') {
      writeFileSync(path.join(fixture.project, 'wp-content/themes/example-theme/style.css'), '/* A user edit */\n');
      if (scenario === 'staged changes') execFileSync(realGit, ['add', 'wp-content/themes/example-theme/style.css'], { cwd: fixture.project, env: fixture.env });
    }
    if (scenario === 'missing package files') writeFileSync(path.join(fixture.project, 'wp-content/themes/example-theme/package.json'), '{}');
    const args = [...fixture.args];
    if (scenario === 'unsafe root') args.push('--root=/srv/site/../other');
    if (scenario === 'alias mismatch') args.push('--host=other.example.org');
    const before = readdirSync(fixture.project);
    const result = spawnSync(process.execPath, [cli, ...args, '--dry-run'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(fixture.project), before);
    assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
  });
}

test('repository setup preserves DDEV, authorized keys, custom docs, and ignore rules; reruns are idempotent', (t) => {
  const fixture = website(t);
  writeFileSync(path.join(fixture.project, 'README.md'), '# Existing project documentation\n');
  writeFileSync(path.join(fixture.project, '.gitignore'), '# Project rule\n/private-notes/\n');
  mkdirSync(path.join(fixture.server, '.ssh'), { mode: 0o700 });
  const authorized = path.join(fixture.server, '.ssh/authorized_keys');
  writeFileSync(authorized, 'ssh-ed25519 AAAAexisting existing-key-without-final-newline', { mode: 0o600 });
  const original = readFileSync(authorized);
  const ddev = readFileSync(path.join(fixture.project, '.ddev/config.yaml'), 'utf8');
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(authorized).subarray(0, original.length).equals(original), true);
  assert.equal(readFileSync(authorized, 'utf8').split('ssh-ed25519').length, 3);
  assert.equal(statSync(authorized).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(fixture.project, '.ddev/config.yaml'), 'utf8'), ddev);
  assert.equal(readFileSync(path.join(fixture.project, 'README.md'), 'utf8'), '# Existing project documentation\n');
  assert.match(readFileSync(path.join(fixture.project, '.gitignore'), 'utf8'), /^# Project rule\n\/private-notes\//);
  const files = execFileSync(realGit, ['ls-files'], { cwd: fixture.project, encoding: 'utf8' });
  assert.doesNotMatch(files, /wp-config|uploads|\.with-scripts.json/);
  assert.match(files, /\.github\/scripts\/deployment.test.mjs/);
  const state = JSON.parse(readFileSync(path.join(fixture.root, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.secrets).sort(), ['FINGERPRINT', 'HOST', 'KEY', 'PORT', 'USERNAME']);
  assert.deepEqual(state.variables, { WORDPRESS_ROOT: fixture.remoteRoot, LIVE_URL: 'https://example.org' });
  assert.match(state.secrets.KEY, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.doesNotMatch(result.stdout + result.stderr + readFileSync(path.join(fixture.root, 'calls'), 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  const beforeHead = state.head;
  const beforeCalls = readFileSync(path.join(fixture.root, 'calls'), 'utf8').split('\n').length;
  const retry = spawnSync(process.execPath, [cli, 'setup-deployment', '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(fixture.root, 'state.json'), 'utf8')).head, beforeHead);
  assert.equal(readFileSync(authorized, 'utf8').split('ssh-ed25519').length, 3);
  const repeated = readFileSync(path.join(fixture.root, 'calls'), 'utf8').split('\n').slice(beforeCalls - 1).join('\n');
  assert.doesNotMatch(repeated, /"repo","create"|"secret","set"|"variable","set"/);
});

for (const failure of ['BUILD', 'PREFLIGHT', 'SECRET', 'PUSH']) {
  test(`setup failure at ${failure.toLowerCase()} preserves progress and can resume`, (t) => {
    const fixture = website(t);
    const failed = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: { ...fixture.env, [`FAIL_${failure}`]: failure === 'SECRET' ? 'KEY' : '1' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const state = JSON.parse(readFileSync(path.join(fixture.root, 'state.json'), 'utf8'));
    if (failure === 'BUILD') {
      assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
      assert.equal(existsSync(path.join(fixture.project, '.with-scripts.json')), false);
      assert.equal(state.repository, false);
    }
    if (failure === 'PREFLIGHT') assert.equal(state.repository, false);
    if (failure === 'SECRET') {
      assert.equal(state.repository, true);
      assert.equal(state.secrets.HOST, 'server.example.org');
      assert.equal(state.secrets.KEY, undefined);
    }
    if (failure === 'PUSH') assert.match(failed.stderr, /commit is ready locally/);
    const retry = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  });
}

test('existing secret replacement requires its own explicit option', (t) => {
  const fixture = website(t, { repository: true });
  const stateFile = path.join(fixture.root, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.secrets.HOST = 'old.example.org';
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /--replace-secrets/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).secrets.HOST, 'old.example.org');
  const retry = spawnSync(process.execPath, [cli, ...fixture.args, '--yes', '--replace-secrets'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test('public repositories stop before build, key creation, or GitHub writes', (t) => {
  const fixture = website(t, { repository: true });
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: { ...fixture.env, PUBLIC_REPO: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private GitHub repository/);
  assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
});

test('public-key append is idempotent and rejects symlink targets', (t) => {
  const fixture = website(t);
  const script = path.join(packageRoot, 'src/setup-deployment-authorize.sh');
  const key = readFileSync(path.join(fixture.root, 'host-key.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('sh', [script, key], { env: { ...process.env, HOME: fixture.server }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(path.join(fixture.server, '.ssh/authorized_keys'), 'utf8'), `${key}\n`);
  rmSync(path.join(fixture.server, '.ssh/authorized_keys'));
  symlinkSync(path.join(fixture.root, 'known_hosts'), path.join(fixture.server, '.ssh/authorized_keys'));
  const result = spawnSync('sh', [script, key], { env: { ...process.env, HOME: fixture.server }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regular .ssh/);
});

test('a distinct push destination is rejected before changes', (t) => {
  const fixture = website(t, { repository: true });
  execFileSync(realGit, ['remote', 'set-url', '--push', 'origin', 'git@github.com:another-owner/another-site.git'], { cwd: fixture.project, env: fixture.env });
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--dry-run'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /push URLs/);
  assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
});

test('removed credential files in unpublished history stop repository creation', (t) => {
  const fixture = website(t, { repository: true });
  writeFileSync(path.join(fixture.project, '.env'), 'EXAMPLE=history-only\n');
  execFileSync(realGit, ['add', '.env'], { cwd: fixture.project, env: fixture.env });
  execFileSync(realGit, ['commit', '-qm', 'Fixture history'], { cwd: fixture.project, env: fixture.env });
  execFileSync(realGit, ['rm', '.env'], { cwd: fixture.project, env: fixture.env });
  execFileSync(realGit, ['commit', '-qm', 'Remove fixture'], { cwd: fixture.project, env: fixture.env });
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /history contains a credential/);
  assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
});

test('revoked known-host identity is preserved and stops key authorization', (t) => {
  const fixture = website(t);
  const known = path.join(fixture.root, 'known_hosts');
  writeFileSync(known, '@revoked ' + readFileSync(known, 'utf8'));
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /revoked/);
  assert.equal(existsSync(path.join(fixture.root, 'keys/deployment')), false);
});

test('versioned template refresh updates untouched generated files and preserves a custom ignore rule', (t) => {
  const fixture = website(t);
  const first = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const metadataFile = path.join(fixture.project, '.github/with-scripts-deployment.json');
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
  const script = '.github/scripts/prepare-deployment.mjs';
  const previous = '// A recorded earlier template version.\n';
  writeFileSync(path.join(fixture.project, script), previous);
  metadata.version = '0.9.0';
  metadata.files[script] = createHash('sha256').update(previous).digest('hex');
  writeFileSync(metadataFile, JSON.stringify(metadata));
  const ignore = path.join(fixture.project, '.gitignore');
  writeFileSync(ignore, '# Custom rule added after setup\n/my-notes/\n' + readFileSync(ignore, 'utf8'));
  execFileSync(realGit, ['add', '.gitignore', '.github'], { cwd: fixture.project, env: fixture.env });
  execFileSync(realGit, ['commit', '-qm', 'Recorded template fixture'], { cwd: fixture.project, env: fixture.env });
  const retry = spawnSync(process.execPath, [cli, 'setup-deployment', '--yes'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(readFileSync(path.join(fixture.project, script), 'utf8'), readFileSync(path.join(packageRoot, 'templates/wordpress-site', script), 'utf8'));
  assert.match(readFileSync(ignore, 'utf8'), /^# Custom rule added after setup/);
  assert.equal(JSON.parse(readFileSync(metadataFile)).version, '1.0.0');
});


test('local Node.js 24 validates the real artifact when DDEV is unavailable', { skip: Number(process.versions.node.split('.')[0]) !== 24 }, (t) => {
  const fixture = website(t);
  const result = spawnSync(process.execPath, [cli, ...fixture.args, '--yes'], { cwd: fixture.project, env: { ...fixture.env, FAIL_DDEV_VERSION: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Prepared deployment artifact/);
  assert.match(result.stdout, /tests 20/);
  assert.equal(existsSync(path.join(fixture.project, 'wp-content/themes/example-theme/node_modules')), false);
});
