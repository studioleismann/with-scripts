import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const packageRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(packageRoot, 'bin/with-scripts.mjs');
const hasPty = spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;

test('piped help stays static and contains no terminal controls', () => {
  const result = spawnSync(process.execPath, [cli], { input: '', encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /setup-wordpress/);
  assert.doesNotMatch(result.stdout, /What would you like to do|\x1b/);
});

for (const scenario of [
  {
    name: 'menu opens an existing command and cancellation preserves the folder', args: [],
    steps: [['What would you like to do?', '\x1b[B\r'], ['SSH target', '\x03']],
    expected: /Operation cancelled/, exit: 130,
  },
  {
    name: 'required text validates inline and cancellation stops before SSH', args: ['inspect-wordpress'],
    steps: [['SSH target', '\r'], ['SSH target is required.', 'example-host\r'], ['Remote WordPress root', '\x03']],
    expected: /Operation cancelled/, exit: 130,
  },
  {
    name: 'confirmation keeps a conservative default and typed approval stays explicit', promptFixture: true,
    steps: [['Apply changes?', '\r'], ['Type PUSH to continue', '\r']],
    expected: /RESULT:false:false/, exit: 0,
  },
  {
    name: 'plugin multiselect permits an empty selection and final confirmation defaults to no', args: ['configure-wordpress'], configure: true,
    steps: [
      ['Is this a fresh WordPress installation?', '\r'],
      ...['Startseite', 'Blog', 'Rechtliches', 'Datenschutzerklärung', 'Impressum'].map((title) => [`${title}: enter an existing page ID`, '\r']),
      ['WordPress language', '\r'], ['Site title', '\r'], ['Tagline (enter - to clear)', '\r'],
      ['Administrator email', '\r'], ['Discourage search engines', '\r'], ['Display avatars?', '\r'],
      ['Organize uploads', '\r'], ['Default post category', '\x1b[B\r'], ['Close comments and pingbacks', '\r'],
      ['Configure the WordPress media sizes?', '\r'],
      ['Choose plugins to install and activate', ' \x1b[B \x1b[B \r'],
      ['Delete the Hello Dolly plugin', '\r'], ['Apply this configuration', '\r'],
    ],
    expected: /Stopped before making WordPress changes/, exit: 0,
  },
]) {
  test(`terminal UI: ${scenario.name}`, { skip: !hasPty, timeout: 15000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'with-scripts-terminal-'));
    const project = path.join(root, 'project');
    const bin = path.join(root, 'bin');
    const commandLog = path.join(root, 'commands.jsonl');
    let child;
    try {
      mkdirSync(project);
      mkdirSync(bin);
      for (const command of ['ssh', 'gh', 'ddev']) {
        writeFileSync(path.join(bin, command), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify(process.argv.slice(1)) + '\\n');
if (process.argv.includes('eval')) console.log('WITH_SCRIPTS_JSON:' + process.env.TEST_INSPECTION);
`, { mode: 0o755 });
      }
      let entry = cli;
      if (scenario.promptFixture) {
        entry = path.join(root, 'prompts.mjs');
        writeFileSync(entry, `import {ask, askYesNo, createPrompts} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'src/cli.mjs')).href)};
const rl = createPrompts();
const approved = await askYesNo(rl, 'Apply changes?', false);
const typed = await ask(rl, 'Type PUSH to continue');
rl?.close();
console.log('RESULT:' + approved + ':' + (typed === 'PUSH'));
`);
      }
      if (scenario.configure) {
        mkdirSync(path.join(project, '.ddev'));
        writeFileSync(path.join(project, '.ddev/config.yaml'), 'name: example-site\n');
      }
      const before = readdirSync(project, { recursive: true }).sort();
      const args = [process.execPath, entry, ...(scenario.args || [])];
      // A real terminal exercises raw-mode keys, cancellation, and prompt defaults.
      // Python's standard library supplies the PTY without a native npm dependency.
      const terminal = `import os, pty, sys, select, struct, fcntl, termios, subprocess
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 90, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(master, data)
finally:
    os.close(master)
    if process.poll() is None:
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
print('\\n__UI_EXIT__' + str(process.wait()), flush=True)
`;
      child = spawn('python3', ['-u', '-c', terminal, ...args], {
        cwd: project,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, TERM: 'xterm-256color', CI: '', NO_COLOR: '1',
          TEST_COMMAND_LOG: commandLog,
          TEST_INSPECTION: JSON.stringify({
            environmentType: 'local', pages: [], postCount: 0, commentCount: 0, homeUrl: 'https://example.local',
            siteTitle: 'Example site', tagline: '', adminEmail: 'admin@example.org', blogPublic: 0,
            showAvatars: 0, yearMonthUploads: 1, defaultCategory: 1, themes: [], plugins: {},
            categories: [{ id: 1, name: 'General' }, { id: 2, name: 'Updates' }],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let step = 0;
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (step < scenario.steps.length && stripVTControlCharacters(output).includes(scenario.steps[step][0])) {
          const keys = scenario.steps[step++][1];
          setTimeout(() => child.stdin.write(keys), 30);
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.stdin.on('error', () => {});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Terminal stalled at step ${step}: ${stripVTControlCharacters(output).slice(-1500)}`)); }, 10000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
      const plain = stripVTControlCharacters(output);
      assert.equal(step, scenario.steps.length, plain);
      assert.match(plain, scenario.expected);
      assert.ok(plain.includes(`__UI_EXIT__${scenario.exit}`), plain);
      assert.doesNotMatch(output, /\x1b\[[0-9;]*m/, 'NO_COLOR must suppress colors while preserving keyboard controls.');
      assert.deepEqual(readdirSync(project, { recursive: true }).sort(), before);
      if (scenario.configure) {
        assert.match(plain, /Plugins: none/);
        const calls = readFileSync(commandLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(calls.length, 3, 'Only DDEV start and the two existing inspection commands may run.');
        assert.equal(calls.some((call) => call.includes('install') || call.includes('activate')), false);
      } else assert.equal(existsSync(commandLog), false, 'Cancellation and prompt previews must not call an external service.');
    } finally {
      child?.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
}
