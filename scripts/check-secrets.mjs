#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from this checkout, including when called by Git from another directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const gitOptions = { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
let temporaryRoot;

try {
  let scanner = process.env.GITLEAKS_BIN;
  if (!scanner) {
    const configured = spawnSync('git', ['config', '--path', '--get', 'with-scripts.gitleaksPath'], { cwd: root, encoding: 'utf8' });
    if (configured.error || ![0, 1].includes(configured.status)) {
      throw new Error('The local scanner configuration could not be read. Check Git configuration and rerun the scan.');
    }
    scanner = configured.stdout.trim() || 'gitleaks';
  }
  if (process.argv.slice(2).some((argument) => argument !== '--pre-push')) {
    throw new Error('Use node scripts/check-secrets.mjs, or let the pre-push hook supply --pre-push.');
  }
  const pushRefs = process.argv.includes('--pre-push') ? readFileSync(0, 'utf8') : '';
  const pushObjects = [];
  for (const entry of pushRefs.split('\n').filter(Boolean)) {
    const fields = entry.split(' ');
    if (fields.length !== 4 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(fields[1])) {
      throw new Error('The pre-push ref list could not be read. Retry the push after checking the Git hook configuration.');
    }
    if (!/^0+$/.test(fields[1])) pushObjects.push(fields[1]);
  }
  const version = spawnSync(scanner, ['version'], { cwd: root, encoding: 'utf8' });
  if (version.error || version.status !== 0 || version.stdout.trim() !== '8.30.1') {
    throw new Error('Install Gitleaks 8.30.1 from its official release. Set with-scripts.gitleaksPath in local Git configuration, set GITLEAKS_BIN, or add the binary to PATH. The scan is required before pushing.');
  }
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], gitOptions).toString().trim() !== 'false') {
    throw new Error('Fetch complete history with git fetch --unshallow --tags, then run the scan again.');
  }

  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'with-scripts-secret-scan-'));
  const snapshots = path.join(temporaryRoot, 'snapshots');
  mkdirSync(snapshots);
  const objectIds = new Set();
  const sources = [];
  const history = execFileSync('git', ['rev-list', '--objects', '--all', 'HEAD', ...pushObjects], gitOptions).toString().trim();
  for (const [index, entry] of history.split('\n').entries()) {
    if (!entry) continue;
    const separator = entry.indexOf(' ');
    objectIds.add(separator < 0 ? entry : entry.slice(0, separator));
    if (separator >= 0) sources.push({ label: `historical filename #${index + 1}`, text: entry.slice(separator + 1), filename: true });
  }

  // Read staged blobs as well: a clean working file can still have a secret staged.
  const staged = execFileSync('git', ['ls-files', '--stage', '-z'], gitOptions).toString().split('\0').filter(Boolean);
  for (const [index, entry] of staged.entries()) {
    const match = entry.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
    if (!match || match[3] !== '0') throw new Error('Resolve index conflicts, then run the scan again.');
    if (match[1] === '160000') throw new Error('A submodule requires its own complete secret scan. Review it before continuing.');
    objectIds.add(match[2]);
    sources.push({ label: `indexed filename #${index + 1}`, text: match[4], filename: true });
  }

  const objects = execFileSync('git', ['cat-file', '--batch'], { ...gitOptions, input: [...objectIds].join('\n') + '\n' });
  let offset = 0;
  while (offset < objects.length) {
    const lineEnd = objects.indexOf(10, offset);
    const header = objects.subarray(offset, lineEnd).toString().match(/^([0-9a-f]+) (blob|commit|tag|tree) (\d+)$/);
    if (lineEnd < 0 || !header) throw new Error('Git object inspection was incomplete. Check repository integrity and rerun the scan.');
    const end = lineEnd + 1 + Number(header[3]);
    if (end >= objects.length || objects[end] !== 10) throw new Error('Git object inspection was incomplete. Check repository integrity and rerun the scan.');
    const content = objects.subarray(lineEnd + 1, end);
    sources.push({ label: `${header[2]} ${header[1]}`, text: content.toString() });
    // Include raw commit/tag data, binary blobs and merge results in secret detection.
    writeFileSync(path.join(snapshots, header[1]), content, { mode: 0o600 });
    offset = end + 1;
  }

  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], gitOptions).toString() + pushRefs;
  sources.push({ label: 'Git reference names', text: refs });
  writeFileSync(path.join(snapshots, 'reference-names'), refs, { mode: 0o600 });

  const files = [...new Set(execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], gitOptions).toString().split('\0').filter(Boolean))];
  for (const [index, file] of files.entries()) {
    const location = path.resolve(root, file);
    if (!location.startsWith(root)) throw new Error('A file resolved outside the repository. Review tracked paths before continuing.');
    let stat;
    try { stat = lstatSync(location); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('A working file cannot be inspected. Review tracked paths before continuing.');
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(location)) : readFileSync(location);
    sources.push({ label: `working filename #${index + 1}`, text: file, filename: true });
    sources.push({ label: `working file #${index + 1}`, text: content.toString() });
    const destination = path.join(snapshots, 'working-files', file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: 0o600 });
  }

  let privacyFindings = 0;
  for (const source of sources) {
    const findings = [];
    for (const match of source.text.matchAll(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)+)\b/gi)) {
      const lineStart = source.text.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.text.indexOf('\n', match.index);
      const line = source.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      const action = line.match(/^(\s*(?:-\s*)?uses:\s*["']?)([a-z0-9-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*@v?\d+(?:\.\d+){1,2}(?:[-+][a-z0-9.-]+)?)["']?\s*(?:#.*)?$/i);
      // A versioned GitHub Actions uses value is a repository reference. Other emails on its line still count.
      if (action && match.index >= lineStart + action[1].length && match.index + match[0].length <= lineStart + action[1].length + action[2].length) continue;
      const address = match[0].toLowerCase();
      const domain = match[1].toLowerCase();
      if (/^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/.test(domain) || /\.(?:example|invalid|test)$/.test(domain)) continue;
      if (domain === 'users.noreply.github.com' || address === 'noreply@github.com' || /^git@(?:github|gitlab)\.com$/.test(address)) continue;
      findings.push({ kind: 'non-example email address', offset: match.index });
    }
    for (const match of source.text.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)(?=[/\\])/g)) {
      if (/^(?:example(?:-[a-z0-9-]+)?|demo(?:-[a-z0-9-]+)?|runner|node|shared|www)$/i.test(match[1])) continue;
      findings.push({ kind: 'personal home directory', offset: match.index });
    }
    for (const match of source.text.matchAll(/(?<![a-z0-9_.-])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*)\.(?:ddev\.site|local)(?![a-z0-9_.-])/gi)) {
      if (/^(?:example(?:-[a-z0-9-]+)?|demo(?:-[a-z0-9-]+)?|project|with-base)(?:\.[a-z0-9-]+)*$/i.test(match[1])) continue;
      findings.push({ kind: 'non-example local hostname', offset: match.index });
    }
    for (const match of source.text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const parts = match[0].split('.').map(Number);
      if (parts.some((part) => part > 255)) continue;
      if (parts[0] === 127 || match[0] === '0.0.0.0' || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(match[0])) continue;
      findings.push({ kind: 'non-example IP address', offset: match.index });
    }
    if (source.filename) {
      const name = path.posix.basename(source.text);
      const example = /(?:^|[.-])(?:example|sample|template)(?:[.-]|$)/.test(name);
      if (!example && /^(?:\.env(?:\..*)?|\.with-scripts\.json|\.npmrc|\.netrc|auth\.json|credentials\.json|wp-config\.php|wp-cli\.local\.yml|id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|p12|pfx|sql|sql\.(?:gz|bz2|xz)|dump|sqlite3?|db))$/.test(name)) {
        findings.push({ kind: 'local settings, credential or database file', offset: 0 });
      }
      if (/(?:^|\/)(?:\.ssh|\.aws|\.with-scripts|\.with-scripts-backups|\.with-scripts-push\.[^/]+)(?:\/|$)/.test(source.text)) {
        findings.push({ kind: 'private runtime directory', offset: 0 });
      }
    }
    for (const finding of findings) {
      privacyFindings++;
      const line = source.text.slice(0, finding.offset).split('\n').length;
      // Never copy a matched value or potentially private filename into public CI logs.
      console.error(`Privacy finding: ${finding.kind}; ${source.label}; line ${line}.`);
    }
  }

  // Pin default rules and disable inline/baseline suppressions for this guard.
  const config = path.join(temporaryRoot, 'gitleaks.toml');
  const ignore = path.join(temporaryRoot, '.gitleaksignore');
  writeFileSync(config, '[extend]\nuseDefault = true\n', { mode: 0o600 });
  writeFileSync(ignore, '', { mode: 0o600 });
  const flags = ['--config', config, '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level=warn', '--max-archive-depth=3', '--max-decode-depth=5'];
  let scannerFailed = false;
  const logOptions = ['--all', '--full-history', '-m', 'HEAD', ...pushObjects].join(' ');
  for (const args of [
    ['git', `--log-opts=${logOptions}`, root, ...flags],
    ['dir', snapshots, ...flags],
  ]) {
    const result = spawnSync(scanner, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    // Gitleaks can return success after an internal Git error. Warnings/errors also block the scan.
    if (result.error || result.status !== 0 || result.stderr?.trim() || result.stdout?.trim()) {
      scannerFailed = true;
      console.error(`Gitleaks blocked the ${args[0] === 'git' ? 'Git history' : 'object and working file'} scan. Run Gitleaks locally with --redact=100 to inspect findings or errors.`);
    }
  }
  if (privacyFindings || scannerFailed) {
    throw new Error('Secret/privacy scan failed. Review findings locally, remove them from every affected commit, and rerun the scan. Values are withheld from logs.');
  }
  console.log('Secret/privacy scan passed: complete reachable history, commit/tag metadata, index and publishable working files.');
  console.log('Manual review is still required for arbitrary personal names, customer names and infrastructure details.');
} catch (error) {
  console.error(`Error: ${error.code || error.cmd ? 'The scan could not complete. Check Git access and readable repository files, then retry.' : error.message}`);
  process.exitCode = 1;
} finally {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}
