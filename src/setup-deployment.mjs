import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { log, note, outro } from '@clack/prompts';
import { askRequired, askYesNo, createPrompts, readConfig, writeConfig } from './cli.mjs';

export async function setupDeployment(args = []) {
  const { values } = parseArgs({
    args,
    options: {
      ...Object.fromEntries(['repo', 'ssh', 'theme', 'plugin', 'root', 'url', 'host', 'user', 'port', 'key-file', 'fingerprint'].map((name) => [name, { type: 'string' }])),
      component: { type: 'string', multiple: true },
      ...Object.fromEntries(['dry-run', 'demo', 'yes', 'replace-secrets'].map((name) => [name, { type: 'boolean' }])),
    },
    allowPositionals: false,
  });
  if (values.demo) {
    if (Object.keys(values).length !== 1) throw new Error('Use --demo on its own. The walkthrough supplies example values.');
    const result = spawnSync('bash', [fileURLToPath(new URL('./setup-deployment.sh', import.meta.url)), '--demo'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Deployment demo stopped. Run with-scripts setup-deployment --demo to try again.');
    return;
  }
  const preview = values['dry-run'];
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!preview && !values.yes && !interactive) throw new Error('Run setup-deployment in a terminal, use --dry-run for a preview, or --yes with complete settings.');
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some((name) => process.env[name])) throw new Error('Unset GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE before running website setup.');
  const startDirectory = realpathSync(process.cwd());
  let projectRoot = startDirectory;
  while (!existsSync(path.join(projectRoot, 'wp-content')) && path.dirname(projectRoot) !== projectRoot) projectRoot = path.dirname(projectRoot);
  if (!existsSync(path.join(projectRoot, 'wp-content'))) {
    throw new Error(`No WordPress website root containing wp-content was found at ${startDirectory}.\nRun setup-deployment in the local website folder, or try with-scripts setup-deployment --demo.`);
  }
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitRoot.error) throw new Error('Install Git and run setup-deployment again.');
  const hasGit = gitRoot.status === 0;
  if (hasGit && realpathSync(gitRoot.stdout.trim()) !== projectRoot) throw new Error('The website is inside another Git repository. Use a separate website checkout before setup.');
  for (const relative of ['wp-content', '.with-scripts.json', '.github', '.github/with-scripts-deployment.json', '.gitignore']) {
    if (lstatSync(path.join(projectRoot, relative), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Use a regular project path for ${relative}.`);
  }
  const config = readConfig(projectRoot);
  const saved = config.wordpressDeployment || {};
  const pull = config.wordpressPull || {};
  const remote = hasGit ? spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf8' }) : null;
  const origin = remote?.status === 0 ? remote.stdout.trim() : '';
  const match = origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::[0-9]+)?\/)([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (origin && !match) throw new Error('The origin remote is not a supported github.com URL. Review git remote -v before retrying.');
  if (values.repo && match && values.repo.toLowerCase() !== match[1].toLowerCase()) throw new Error('--repo differs from origin. Use the intended website checkout; setup preserves existing remotes.');
  if (origin) {
    const pushUrls = execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd: projectRoot, encoding: 'utf8' }).trim().split('\n');
    if (pushUrls.length !== 1 || pushUrls[0] !== origin) throw new Error('Origin has a different or multiple push URLs. Review git remote -v and use the same intended GitHub URL for fetch and push before setup.');
  }
  const tracked = hasGit ? execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean) : [];
  const trackedComponents = [...new Set(tracked.flatMap((file) => file.match(/^(wp-content\/(?:themes|plugins|mu-plugins)\/[^/]+)/)?.slice(1) || []))];
  let components = [...new Set([...trackedComponents, ...(values.component || saved.components || [])])];
  if (values.theme) components.push(`wp-content/themes/${values.theme}`);
  if (values.plugin && values.plugin !== 'none') components.push(`wp-content/plugins/${values.plugin}`);
  const settings = {};
  const rl = interactive && !preview && !values.yes ? createPrompts() : null;
  let temporary;
  let containerDirectory;
  let changed = false;
  try {
    settings.repo = values.repo || match?.[1] || saved.repo || '';
    settings.url = values.url || saved.url || pull.liveUrl || '';
    if (!settings.repo && interactive && !preview && !values.yes) {
      const owner = await askRequired(rl, 'GitHub owner or organization');
      let defaultName = '';
      try { defaultName = new URL(settings.url).hostname; } catch { /* Ask when no URL is available. */ }
      settings.repo = `${owner}/${await askRequired(rl, 'Repository name', defaultName)}`;
    }
    if (!/^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*$/.test(settings.repo) || settings.repo.endsWith('.git')) throw new Error('Supply --repo=<owner/name> or choose the GitHub owner and repository in a terminal.');
    if (!components.length) {
      const themesDirectory = path.join(projectRoot, 'wp-content/themes');
      const themes = existsSync(themesDirectory) ? readdirSync(themesDirectory).filter((name) => existsSync(path.join(themesDirectory, name, 'style.css'))) : [];
      const current = path.relative(projectRoot, startDirectory).match(/^wp-content\/themes\/([^/]+)(?:\/|$)/)?.[1];
      if (current) components = [`wp-content/themes/${current}`];
      else if (interactive && !preview && !values.yes) {
        log.info(`Available themes: ${themes.join(', ') || 'none'}`);
        components = (await askRequired(rl, 'Owned component paths (comma-separated)', themes.length === 1 ? `wp-content/themes/${themes[0]}` : '')).split(',').map((value) => value.trim());
      } else throw new Error('Choose owned code with --theme=<slug> or repeatable --component=wp-content/<themes|plugins|mu-plugins>/<name>.');
    }
    components = [...new Set(components)].sort();
    for (const component of components) {
      if (!/^wp-content\/(themes|plugins|mu-plugins)\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(component) || !existsSync(path.join(projectRoot, component))) throw new Error(`Choose an existing component path: ${component}.`);
      for (let entry = path.join(projectRoot, component); entry !== projectRoot; entry = path.dirname(entry)) {
        if (lstatSync(entry).isSymbolicLink()) throw new Error(`Use regular component paths: ${component}.`);
      }
      if (existsSync(path.join(projectRoot, component, '.git'))) throw new Error(`Nested Git repository: ${component}. Convert it to website-owned files before setup.`);
      const manifestFile = path.join(projectRoot, component, 'package.json');
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error(`${component}/package.json needs a non-empty files array defining its production package.`);
        if (manifest.scripts?.build && !existsSync(path.join(projectRoot, component, 'package-lock.json'))) throw new Error(`${component} needs package-lock.json for its release build.`);
      }
    }
    settings.components = components;
    settings.ssh = values.ssh || saved.ssh || pull.sshTarget || '';
    if (settings.ssh && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(settings.ssh)) throw new Error('Use a local SSH alias or user@hostname for --ssh.');
    let sshConfig = {};
    if (settings.ssh) {
      const resolved = spawnSync('ssh', ['-G', settings.ssh], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (resolved.status !== 0) throw new Error('Could not resolve the SSH alias. Check ssh -G for the configured target.');
      sshConfig = Object.fromEntries(resolved.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]));
    }
    for (const [name, label, fallback] of [
      ['root', 'Absolute production WordPress root', pull.remoteRoot || ''],
      ['url', 'Production HTTPS URL', pull.liveUrl || ''],
      ['host', 'Public SSH hostname', sshConfig.hostname || ''],
      ['user', 'SSH username', sshConfig.user || ''],
      ['port', 'SSH port', sshConfig.port || '22'],
      ['key-file', 'Dedicated deployment private-key file', path.join(homedir(), '.ssh', `${settings.repo.replace('/', '-')}-deployment`)],
    ]) {
      let value = values[name] ?? saved[name] ?? fallback;
      if (!value && interactive && !preview && !values.yes) value = await askRequired(rl, label);
      if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid --${name}. Supply the option or complete setup in a terminal.`);
      settings[name] = value.trim();
    }
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(settings.root) || settings.root.split('/').some((part) => part === '..' || part === '.')) throw new Error('--root requires an absolute path using letters, numbers, dots, underscores, and hyphens.');
    settings.root = path.posix.normalize(settings.root).replace(/\/$/, '');
    if (!settings.root) throw new Error('Choose a dedicated WordPress directory for --root.');
    const liveUrl = new URL(settings.url);
    if (liveUrl.protocol !== 'https:' || liveUrl.username || liveUrl.password || liveUrl.port || liveUrl.pathname !== '/' || liveUrl.search || liveUrl.hash || !/^[a-zA-Z0-9.-]+$/.test(liveUrl.hostname)) throw new Error('Use a production HTTPS URL at the domain root.');
    settings.url = liveUrl.origin;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(settings.host)) throw new Error('Use the public SSH hostname or IPv4 address for --host.');
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(settings.user)) throw new Error('Invalid SSH username.');
    if (!/^\d+$/.test(settings.port) || Number(settings.port) < 1 || Number(settings.port) > 65535) throw new Error('SSH port must be between 1 and 65535.');
    settings.port = String(Number(settings.port));
    if (settings.ssh && (sshConfig.hostname !== settings.host || sshConfig.user !== settings.user || sshConfig.port !== settings.port)) throw new Error('The SSH alias resolves to a different host, user, or port. Review the saved settings and ssh -G before setup.');
    settings.fingerprint = values.fingerprint || saved.fingerprint || '';
    if (settings.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(settings.fingerprint)) throw new Error('Use an independently trusted SHA256 server host-key fingerprint.');
    settings['key-file'] = settings['key-file'].replace(/^~\//, `${homedir()}/`);
    if (!path.isAbsolute(settings['key-file']) || !existsSync(path.dirname(settings['key-file']))) throw new Error('Choose an absolute private-key path with an existing parent directory outside the website repository.');
    settings['key-file'] = path.join(realpathSync(path.dirname(settings['key-file'])), path.basename(settings['key-file']));
    for (const keyFile of [settings['key-file'], `${settings['key-file']}.pub`]) {
      if (keyFile.startsWith(`${projectRoot}/`) || keyFile === projectRoot || lstatSync(keyFile, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Store the dedicated key outside the website repository in regular files.');
    }

    // Assemble the candidate in a temporary Git tree. All preview writes stay here.
    temporary = mkdtempSync(path.join(tmpdir(), 'with-scripts-deployment-'));
    const candidate = path.join(temporary, 'source');
    mkdirSync(candidate);
    execFileSync('git', ['init', '-q', '--initial-branch=main', candidate]);
    execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: candidate });
    const templateRoot = fileURLToPath(new URL('../templates/wordpress-site/', import.meta.url));
    const template = JSON.parse(readFileSync(path.join(templateRoot, 'template.json'), 'utf8'));
    const metadataPath = '.github/with-scripts-deployment.json';
    const priorMetadata = existsSync(path.join(projectRoot, metadataPath)) ? JSON.parse(readFileSync(path.join(projectRoot, metadataPath), 'utf8')) : {};
    const replacements = {
      PROJECT_NAME: settings.repo.split('/')[1], LIVE_URL: settings.url,
      COMPONENT_LIST: components.map((component) => `- \`${component}\``).join('\n'),
      COMPONENT_RULES: ['themes', 'plugins', 'mu-plugins'].filter((kind) => components.some((component) => component.startsWith(`wp-content/${kind}/`))).flatMap((kind) => [
        `!/wp-content/${kind}/`, `/wp-content/${kind}/*`,
        ...components.filter((component) => component.startsWith(`wp-content/${kind}/`)).flatMap((component) => [
          `!/${component}${lstatSync(path.join(projectRoot, component)).isDirectory() ? '/' : ''}`,
          ...(lstatSync(path.join(projectRoot, component)).isDirectory() ? [`/${component}/.github/workflows/`] : []),
        ]),
      ]).join('\n'),
    };
    const planned = new Map();
    const before = new Map();
    const metadata = { template: 'wordpress-site', version: template.version, files: {} };
    const conflicts = [];
    for (const relative of ['.gitignore', ...template.files, metadataPath]) {
      for (let file = path.join(projectRoot, relative); file !== projectRoot; file = path.dirname(file)) {
        if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Use a regular project path for ${relative}.`);
      }
      const original = existsSync(path.join(projectRoot, relative)) ? readFileSync(path.join(projectRoot, relative)) : null;
      before.set(relative, original ? createHash('sha256').update(original).digest('hex') : null);
      if (relative === metadataPath) continue;
      let contents = readFileSync(path.join(templateRoot, relative === '.gitignore' ? 'gitignore' : relative), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => replacements[name]);
      if (relative === '.gitignore') {
        const start = '# BEGIN with-scripts wordpress-site';
        const end = '# END with-scripts wordpress-site';
        const text = original?.toString() || '';
        const block = text.match(/# BEGIN with-scripts wordpress-site\n[\s\S]*?# END with-scripts wordpress-site\n?/g);
        if ((text.includes(start) || text.includes(end)) && (!block || block.length !== 1)) throw new Error('Review the incomplete or duplicate with-scripts block in .gitignore.');
        const baseline = `${start}\n${contents}${end}\n`;
        if (block && block[0] !== baseline && priorMetadata.ignoreBlock !== createHash('sha256').update(block[0]).digest('hex')) conflicts.push(relative);
        contents = block ? text.replace(block[0], baseline) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${baseline}`;
        metadata.ignoreBlock = createHash('sha256').update(baseline).digest('hex');
      } else if (original && original.toString() !== contents && priorMetadata.files?.[relative] !== before.get(relative)) {
        if (relative === 'README.md' || relative.startsWith('docs/')) {
          log.info(`Preserving existing ${relative}.`);
          continue;
        }
        conflicts.push(relative);
      }
      planned.set(relative, Buffer.from(contents));
      metadata.files[relative] = createHash('sha256').update(contents).digest('hex');
      mkdirSync(path.dirname(path.join(candidate, relative)), { recursive: true });
      writeFileSync(path.join(candidate, relative), contents);
    }
    if (conflicts.length) {
      for (const relative of conflicts) {
        const diff = spawnSync('git', ['diff', '--no-index', '--', path.join(projectRoot, relative), path.join(candidate, relative)], { encoding: 'utf8' });
        process.stdout.write(diff.stdout || '');
      }
      throw new Error(`Merge the displayed template differences before retrying: ${conflicts.join(', ')}. Existing project files were preserved.`);
    }
    planned.set(metadataPath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
    const rules = path.join(temporary, 'ignore');
    writeFileSync(rules, planned.get('.gitignore'));
    const untracked = execFileSync('git', ['--git-dir=' + path.join(candidate, '.git'), '--work-tree=' + projectRoot, 'ls-files', '--others', '--exclude-standard', '--exclude-from=' + rules, '-z'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    const sourceFiles = [...new Set([...tracked, ...untracked, ...planned.keys()])].sort();
    const sourceHashes = new Map();
    for (const relative of sourceFiles) {
      if (/^(?:wp-admin|wp-includes|\.private|\.with-scripts-backups|\.deploy-artifact)\//.test(relative) || /^(?:wp-config[^/]*|\.htaccess[^/]*|\.with-scripts\.json|\.maintenance[^/]*)$/.test(relative)
          || /(^|\/)(?:node_modules|\.git|\.ssh|\.aws)(\/|$)|(^|\/)\.env(?!\.(?:example|sample)$)(?:\.|$)|(^|\/)(?:\.npmrc|\.netrc|auth\.json|credentials\.json|wp-cli\.local\.yml)$|\.(?:sql(?:\..*)?|dump|sqlite3?|db|pem|key|p12|pfx|tgz|tar(?:\.gz)?)$/i.test(relative)
          || /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/.test(relative)
          || (relative.startsWith('wp-content/') && !components.some((component) => relative === component || relative.startsWith(`${component}/`)))
          || (!relative.includes('/') && relative.endsWith('.php'))) throw new Error(`Excluded runtime or credential file is tracked or selected: ${relative}. Remove it from Git deliberately before setup.`);
      if (/[\r\n\t\0]/.test(relative) || relative.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Unsupported source path: ${JSON.stringify(relative)}.`);
      let contents = planned.get(relative);
      if (!contents) {
        const absolute = path.join(projectRoot, relative);
        for (let file = absolute; file !== projectRoot; file = path.dirname(file)) {
          if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${relative}.`);
        }
        if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) throw new Error(`Use regular source files; check for nested Git repositories or missing files: ${relative}.`);
        contents = readFileSync(absolute);
        sourceHashes.set(relative, createHash('sha256').update(contents).digest('hex'));
      }
      if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/.test(contents.toString())) throw new Error(`Possible credential in ${relative}. Review and remove it before publishing; matching bytes were not printed.`);
      mkdirSync(path.dirname(path.join(candidate, relative)), { recursive: true });
      writeFileSync(path.join(candidate, relative), contents);
      chmodSync(path.join(candidate, relative), (lstatSync(path.join(projectRoot, relative), { throwIfNoEntry: false })?.mode || 0o644) & 0o777);
    }
    for (const relative of sourceFiles.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file) && file !== '.github/workflows/deploy-production.yml')) {
      if (/secrets(?:\.(?:HOST|KEY)\b|\[['"](?:HOST|KEY)['"]\])/.test(readFileSync(path.join(candidate, relative), 'utf8'))) throw new Error(`Existing workflow ${relative} uses deployment secrets. Review it before installing this release workflow.`);
    }
    if (hasGit) {
      if (execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: projectRoot, encoding: 'utf8' }).trim()) throw new Error('Commit or unstage existing staged changes before website setup.');
      const dirty = execFileSync('git', ['diff', '--name-only', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
      for (const relative of dirty) {
        const file = path.join(projectRoot, relative);
        if (!planned.has(relative) || !existsSync(file) || saved.pendingFiles?.[relative] !== createHash('sha256').update(readFileSync(file)).digest('hex')) throw new Error(`Commit or stash existing changes before setup: ${relative}.`);
      }
    }
    execFileSync('git', ['add', '--all'], { cwd: candidate });
    const candidateFiles = execFileSync('git', ['ls-files', '-z'], { cwd: candidate, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const relative of [...sourceFiles, ...planned.keys()]) {
      if (!candidateFiles.includes(relative)) throw new Error(`Project ignore rules exclude selected source: ${relative}. Review the rules before setup.`);
    }
    for (const component of components) {
      if (!candidateFiles.some((file) => file === component || file.startsWith(`${component}/`))) throw new Error(`No source files selected for ${component}. Review its ignore rules.`);
    }
    const branch = hasGit ? execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim() : 'main';
    const changes = [...planned].filter(([file, contents]) => before.get(file) !== createHash('sha256').update(contents).digest('hex')).map(([file]) => file);
    note([
      `Project: ${projectRoot}`, `Repository: ${settings.repo}${origin ? ' (from origin)' : ' (create private if absent)'}`, `Branch: ${branch}`,
      `SSH: ${settings.ssh || `${settings.user}@${settings.host}`} → ${settings.user}@${settings.host}:${settings.port}`,
      `WordPress root: ${settings.root}`, `Website: ${settings.url}`, `Owned components: ${components.join(', ')}`,
      `Template: wordpress-site ${template.version}; ${candidateFiles.length} source files`, `Files to add/update: ${changes.join(', ') || 'none'}`,
      `Dedicated key: ${settings['key-file']}`, 'Variables: WORDPRESS_ROOT, LIVE_URL', 'Secrets: HOST, USERNAME, PORT, FINGERPRINT, KEY',
      'Validation: Node.js 24, deployment integration tests, real release package in an isolated copy',
      'Publication: commit and push website source; deployment starts when a release is published (including prereleases)',
    ].join('\n'), 'Website repository and deployment plan');
    if (preview) {
      outro('Preview complete. Project files, keys, GitHub, and servers are unchanged. Build, SSH, and GitHub checks run during setup.');
      return;
    }

    // Read-only service checks and the actual release build precede setup mutations.
    if (spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'inherit' }).status !== 0) throw new Error('Run gh auth login --hostname github.com, then retry.');
    const ghEnvironment = { ...process.env, GH_HOST: 'github.com' };
    let repositoryResult = spawnSync('gh', ['api', `repos/${settings.repo}`], { encoding: 'utf8', env: ghEnvironment });
    if (repositoryResult.error || (repositoryResult.status !== 0 && !/HTTP 404/.test(repositoryResult.stderr))) throw new Error('Could not inspect the GitHub repository. Check GitHub access and retry.');
    let repository = repositoryResult.status === 0 ? JSON.parse(repositoryResult.stdout) : null;
    if (repository && repository.full_name.toLowerCase() !== settings.repo.toLowerCase()) throw new Error('GitHub resolved a different repository name. Review the canonical repository and origin before setup.');
    if (repository && (!repository.private || !repository.permissions?.admin)) throw new Error('Setup requires a private GitHub repository and administrator access to manage its configuration.');
    if (repository && repository.default_branch !== branch && repository.size > 0) throw new Error(`Check out the repository default branch (${repository.default_branch}) before setup.`);
    const remoteRefs = repository ? spawnSync('git', ['ls-remote', '--heads', origin || repository.ssh_url], { encoding: 'utf8' }) : null;
    if (remoteRefs && remoteRefs.status !== 0) throw new Error('Could not read GitHub Git refs. Verify Git authentication before setup.');
    const remoteHead = remoteRefs?.stdout.split('\n').find((line) => line.endsWith(`\trefs/heads/${branch}`))?.split('\t')[0];
    if (remoteHead && (!hasGit || spawnSync('git', ['merge-base', '--is-ancestor', remoteHead, 'HEAD'], { cwd: projectRoot }).status !== 0)) throw new Error('The GitHub branch contains commits missing locally. Fetch and reconcile it before setup; no force push is performed.');
    if (hasGit && spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot, stdio: 'ignore' }).status === 0) {
      const objects = execFileSync('git', ['rev-list', '--objects', 'HEAD', ...(remoteHead ? ['--not', remoteHead] : [])], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
      if (objects) {
        const entries = objects.split('\n');
        for (const entry of entries) {
          const filename = entry.slice(entry.indexOf(' ') + 1);
          if (/(^|\/)(?:\.with-scripts\.json|wp-config[^/]*|\.npmrc|\.netrc|auth\.json|credentials\.json|id_(?:rsa|ed25519)[^/]*|\.env(?!\.(?:example|sample)$)[^/]*)$|\.(?:pem|key|p12|pfx|sql(?:\..*)?)$/i.test(filename)) throw new Error('Unpublished Git history contains a credential or database filename. Review and clean that history before publishing.');
        }
        const contents = execFileSync('git', ['cat-file', '--batch'], { cwd: projectRoot, input: entries.map((entry) => entry.split(' ')[0]).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
        if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/.test(contents.toString())) throw new Error('Possible credential in unpublished Git history. Review and clean the history before publishing; matching bytes were not printed.');
      }
    }
    for (const name of ['user.name', 'user.email']) {
      if (spawnSync('git', ['config', '--get', name], { cwd: projectRoot, encoding: 'utf8' }).status !== 0) throw new Error(`Configure Git ${name} before creating the website commit.`);
    }
    const secretsResult = repository ? spawnSync('gh', ['secret', 'list', '--repo', settings.repo, '--json', 'name'], { encoding: 'utf8', env: ghEnvironment }) : null;
    if (secretsResult && secretsResult.status !== 0) throw new Error('Could not read repository secret names. Check GitHub permissions before setup.');
    const secretNames = new Set(secretsResult ? JSON.parse(secretsResult.stdout).map((secret) => secret.name) : []);
    const variablesResult = repository ? spawnSync('gh', ['variable', 'list', '--repo', settings.repo, '--json', 'name,value'], { encoding: 'utf8', env: ghEnvironment }) : null;
    if (variablesResult && variablesResult.status !== 0) throw new Error('Could not read repository variables. Check GitHub permissions before setup.');
    const existingVariables = Object.fromEntries(variablesResult ? JSON.parse(variablesResult.stdout).map((entry) => [entry.name, entry.value]) : []);

    log.step('Validating the isolated release package with Node.js 24.');
    execFileSync('git', ['-c', 'user.name=Deployment validation', '-c', 'user.email=deployment@example.org', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Validate website deployment'], { cwd: candidate });
    const node24 = Number(process.versions.node.split('.')[0]) === 24;
    const ddevVersion = existsSync(path.join(projectRoot, '.ddev/config.yaml')) ? spawnSync('ddev', ['exec', 'node', '--version'], { cwd: projectRoot, encoding: 'utf8' }) : null;
    const useDdev = ddevVersion?.status === 0 && /^v24\./.test(ddevVersion.stdout.trim());
    if (node24 && !useDdev) {
      for (const command of [[process.execPath, ['--test', '.github/scripts/deployment.test.mjs']], [process.execPath, ['.github/scripts/prepare-deployment.mjs', path.join(temporary, 'artifact.tar.gz')]]]) {
        const result = spawnSync(command[0], command[1], { cwd: candidate, stdio: 'inherit', env: { ...process.env, WITH_DEPLOY_FULL_TESTS: '1', npm_config_cache: path.join(temporary, 'npm-cache') } });
        if (result.status !== 0) throw new Error('Release validation failed in the temporary copy. Fix the component package/build and retry.');
      }
    } else {
      if (!useDdev) throw new Error('Release validation needs Node.js 24 locally or in the running DDEV web container. Configure Node.js 24, start DDEV, and retry.');
      containerDirectory = `/tmp/with-scripts-deployment-${randomUUID()}`;
      const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: candidate, maxBuffer: 256 * 1024 * 1024 });
      if (spawnSync('ddev', ['exec', 'mkdir', '-m', '700', containerDirectory], { cwd: projectRoot, stdio: 'inherit' }).status !== 0) throw new Error('Could not create the isolated DDEV validation directory.');
      if (spawnSync('ddev', ['exec', 'tar', '-xf', '-', '-C', containerDirectory], { cwd: projectRoot, input: archive, stdio: ['pipe', 'inherit', 'inherit'] }).status !== 0) throw new Error('Could not transfer the candidate into the DDEV validation directory.');
      const script = `set -eu\ncd '${containerDirectory}'\ngit init -q --initial-branch=main\ngit add --all\ngit -c user.name='Deployment validation' -c user.email=deployment@example.org -c commit.gpgsign=false commit -qm 'Validate website deployment'\nexport WITH_DEPLOY_FULL_TESTS=1\nexport npm_config_cache='${containerDirectory}/.npm-cache'\nnode --test .github/scripts/deployment.test.mjs\nnode .github/scripts/prepare-deployment.mjs '${containerDirectory}/artifact.tar.gz'\n`;
      if (spawnSync('ddev', ['exec', 'sh', '-s'], { cwd: projectRoot, input: script, stdio: ['pipe', 'inherit', 'inherit'] }).status !== 0) throw new Error('Release validation failed in the DDEV temporary copy. Fix the component package/build and retry.');
    }
    log.success('Deployment integration tests and release build passed.');
    if (!values.yes && !await askYesNo(rl, `Create or update ${settings.repo}, authorize the dedicated key, configure GitHub, and commit/push this website?`, false)) throw new Error('Setup cancelled before project or service changes.');

    // Trust comes from known_hosts or an explicitly supplied provider fingerprint.
    const knownHosts = path.join(temporary, 'known_hosts');
    const lookup = settings.port === '22' ? settings.host : `[${settings.host}]:${settings.port}`;
    const knownPaths = sshConfig.userknownhostsfile ? sshConfig.userknownhostsfile.match(/(?:[^\s"]+|"[^"]*")+/g).map((file) => file.replace(/^"|"$/g, '').replace(/^~\//, `${homedir()}/`)) : [path.join(homedir(), '.ssh/known_hosts')];
    const hostKeys = new Map();
    for (const file of knownPaths) {
      if (!existsSync(file)) continue;
      const found = spawnSync('ssh-keygen', ['-F', lookup, '-f', file], { encoding: 'utf8' });
      if (/^@revoked /m.test(found.stdout || '')) throw new Error('A server key is marked revoked in known_hosts. Resolve the revoked host identity before setup.');
      for (const line of (found.stdout || '').split('\n')) {
        const key = line.match(/^\S+ ((?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+)(?: |$)/)?.[1];
        if (!key) continue;
        const candidateKey = path.join(temporary, 'server-key.pub');
        writeFileSync(candidateKey, `${key}\n`, { mode: 0o600 });
        const fingerprint = spawnSync('ssh-keygen', ['-lf', candidateKey, '-E', 'sha256'], { encoding: 'utf8' });
        if (fingerprint.status === 0) hostKeys.set(fingerprint.stdout.trim().split(/\s+/)[1], key);
      }
    }
    // Match drone-scp 1.8.0 / drone-ssh 1.8.2 (x/crypto v0.37.0 / v0.45.0).
    // Their default host-key order differs from OpenSSH. Recheck when upgrading Actions.
    const actionAlgorithms = [
      'rsa-sha2-256-cert-v01@openssh.com', 'rsa-sha2-512-cert-v01@openssh.com',
      'ssh-rsa-cert-v01@openssh.com', 'ssh-dss-cert-v01@openssh.com',
      'ecdsa-sha2-nistp256-cert-v01@openssh.com', 'ecdsa-sha2-nistp384-cert-v01@openssh.com',
      'ecdsa-sha2-nistp521-cert-v01@openssh.com', 'ssh-ed25519-cert-v01@openssh.com',
      'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
      'rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa', 'ssh-dss', 'ssh-ed25519',
    ];
    const supportedAlgorithms = actionAlgorithms.filter((algorithm) => !algorithm.includes('-cert-') && !['ssh-rsa', 'ssh-dss'].includes(algorithm));
    writeFileSync(knownHosts, [...hostKeys.values()].map((key) => `${lookup} ${key}\n`).join(''), { mode: 0o600 });
    const sshOptions = ['-4', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no'];
    // Discover negotiation without credentials; an unknown host or denied login is expected.
    // Neither discovery nor ssh-keyscan establishes trust in the returned key.
    const probe = spawnSync('ssh', ['-F', '/dev/null', ...sshOptions, '-vv', '-o', `HostKeyAlgorithms=${supportedAlgorithms.join(',')}`, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'IdentityAgent=none', '-p', settings.port, `${settings.user}@${settings.host}`, 'true'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 });
    const offered = probe.stderr?.split('debug2: peer server KEXINIT proposal')[1]?.match(/^debug2: host key algorithms: ([^\r\n]+)/m)?.[1].split(',') || [];
    const algorithm = actionAlgorithms.find((entry) => offered.includes(entry));
    if (algorithm && !supportedAlgorithms.includes(algorithm)) throw new Error(`The deployment Actions select ${algorithm}. Automatic setup requires a plain ECDSA, RSA-SHA2, or Ed25519 host key; review the server host-key configuration before retrying.`);
    const negotiated = probe.stderr?.match(/^debug1: kex: host key algorithm: ([^\r\n]+)/m)?.[1];
    const presented = probe.stderr?.match(/^debug1: Server host key: (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) (SHA256:[A-Za-z0-9+/]{43})(?:\r?$)/m);
    if (probe.error || !algorithm || negotiated !== algorithm || !presented) throw new Error('Could not determine the deployment host key. Check IPv4 SSH access and the local OpenSSH client, then retry.');
    const [, keyType, observedFingerprint] = presented;
    if (!settings.fingerprint && hostKeys.has(observedFingerprint)) settings.fingerprint = observedFingerprint;
    if (!settings.fingerprint && interactive && !values.yes) settings.fingerprint = await askRequired(rl, `Trusted ${keyType} server fingerprint (from your provider or server console)`);
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(settings.fingerprint)) throw new Error(`Supply --fingerprint with the independently trusted ${keyType} server fingerprint selected by the deployment Actions, or establish trust for that key in known_hosts first.`);
    if (settings.fingerprint !== observedFingerprint) throw new Error(`The ${keyType} host key selected by the deployment Actions does not match the trusted fingerprint. Verify this key with the provider and retry with --fingerprint. Existing keys and GitHub secrets were preserved.`);
    let hostKey = hostKeys.get(settings.fingerprint);
    if (!hostKey) {
      const scanType = keyType === 'ssh-rsa' ? 'rsa' : keyType === 'ssh-ed25519' ? 'ed25519' : 'ecdsa';
      const scan = spawnSync('ssh-keyscan', ['-4', '-T', '10', '-p', settings.port, '-t', scanType, settings.host], { encoding: 'utf8', timeout: 15000 });
      if (scan.status !== 0) throw new Error('Could not retrieve the deployment host key. Check IPv4 SSH access and retry; existing keys and GitHub secrets were preserved.');
      for (const line of (scan.stdout || '').split('\n')) {
        const key = line.match(/^\S+ ((?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+)(?: |$)/)?.[1];
        if (!key || !key.startsWith(`${keyType} `)) continue;
        const candidateKey = path.join(temporary, 'server-key.pub');
        writeFileSync(candidateKey, `${key}\n`, { mode: 0o600 });
        const fingerprint = spawnSync('ssh-keygen', ['-lf', candidateKey, '-E', 'sha256'], { encoding: 'utf8' });
        if (fingerprint.status === 0 && fingerprint.stdout.trim().split(/\s+/)[1] === settings.fingerprint) hostKey = key;
      }
    }
    if (!hostKey) throw new Error('The retrieved deployment host key does not match the trusted fingerprint. Verify the endpoint with the provider before retrying.');
    writeFileSync(knownHosts, `${lookup} ${hostKey}\n`, { mode: 0o600 });
    sshOptions.push('-o', `HostKeyAlgorithms=${algorithm}`);
    log.success(`Deployment host key verified: ${keyType} ${settings.fingerprint}`);
    const keyFile = settings['key-file'];
    if (!existsSync(keyFile)) {
      if (existsSync(`${keyFile}.pub`)) throw new Error('A public key already occupies the chosen key path. Choose a dedicated unused --key-file.');
      const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${settings.repo} deployment`, '-f', keyFile], { stdio: 'inherit' });
      if (generated.status !== 0) throw new Error('Could not create the deployment key. Check its parent directory and retry.');
      changed = true;
    }
    if (!lstatSync(keyFile).isFile() || (lstatSync(keyFile).mode & 0o077)) throw new Error('Use a regular deployment private key readable only by its owner (chmod 600).');
    const publicKeyResult = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', keyFile], { encoding: 'utf8' });
    if (publicKeyResult.status !== 0 || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: |$)/.test(publicKeyResult.stdout)) throw new Error('Use a dedicated passphrase-free Ed25519 key; keep your personal key in its SSH agent.');
    const publicKey = publicKeyResult.stdout.trim().split(/\s+/).slice(0, 2).join(' ');
    if (existsSync(`${keyFile}.pub`) && readFileSync(`${keyFile}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') !== publicKey) throw new Error('The deployment public and private key files differ. Review the key pair before retrying.');
    const dedicatedOptions = ['-F', '/dev/null', ...sshOptions, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-i', keyFile, '-p', settings.port, `${settings.user}@${settings.host}`];
    if (spawnSync('ssh', [...dedicatedOptions, 'true'], { stdio: 'ignore' }).status !== 0) {
      log.step('Authorizing the dedicated public key through your existing SSH access.');
      const authorize = readFileSync(new URL('./setup-deployment-authorize.sh', import.meta.url), 'utf8');
      const bootstrap = [...sshOptions, '-o', `BatchMode=${interactive ? 'no' : 'yes'}`, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'HostKeyAlias=' + lookup, '-p', settings.port, settings.ssh || `${settings.user}@${settings.host}`, `sh -s -- '${publicKey}'`];
      if (spawnSync('ssh', bootstrap, { input: authorize, stdio: ['pipe', 'inherit', 'inherit'] }).status !== 0) throw new Error('Could not authorize the deployment key. Verify your existing SSH login and retry; enter passwords only in the terminal.');
      changed = true;
      if (spawnSync('ssh', [...dedicatedOptions, 'true'], { stdio: 'inherit' }).status !== 0) throw new Error('The dedicated key login failed. Check server key permissions and retry.');
    }
    const remotePreflight = spawnSync('ssh', [...dedicatedOptions, `sh -s -- preflight '${settings.root}' '${Date.now()}-1'`], { input: planned.get('.github/scripts/remote-deployment.sh'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
    if (remotePreflight.status !== 0 || !/^Remote preflight passed\.$/m.test(remotePreflight.stdout || '')) throw new Error('Remote deployment preflight failed. Check the WordPress root and account permissions, then retry.');
    log.success('Dedicated SSH key and remote WordPress preflight verified with the agent disabled.');

    const state = { ...settings, templateVersion: template.version, secretsApplied: saved.repo === settings.repo ? { ...saved.secretsApplied } : {} };
    const privateKey = readFileSync(keyFile);
    const checkedPublicKey = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', keyFile], { encoding: 'utf8' });
    if (checkedPublicKey.status !== 0 || checkedPublicKey.stdout.trim().split(/\s+/).slice(0, 2).join(' ') !== publicKey) throw new Error('The key changed during setup. Review the dedicated key before retrying.');
    const secretValues = { HOST: settings.host, USERNAME: settings.user, PORT: settings.port, FINGERPRINT: settings.fingerprint, KEY: publicKey };
    const replace = Object.keys(secretValues).filter((name) => secretNames.has(name) && state.secretsApplied[name] !== createHash('sha256').update(secretValues[name]).digest('hex'));
    if (replace.length && !values['replace-secrets']) {
      if (!interactive || values.yes || !await askYesNo(rl, `Replace existing secrets ${replace.join(', ')} in ${settings.repo} with this verified target and key?`, false)) throw new Error('Existing secrets were preserved. Review this target and use --replace-secrets to explicitly replace the listed deployment secrets.');
    }
    if (!repository) {
      const created = spawnSync('gh', ['repo', 'create', settings.repo, '--private'], { stdio: 'inherit', env: ghEnvironment });
      if (created.status !== 0) throw new Error('GitHub repository creation did not finish. Rerun setup to inspect and reuse the repository if it was created.');
      changed = true;
      repositoryResult = spawnSync('gh', ['api', `repos/${settings.repo}`], { encoding: 'utf8', env: ghEnvironment });
      if (repositoryResult.status !== 0) throw new Error('Could not verify the newly created repository. Retry to inspect its current state.');
      repository = JSON.parse(repositoryResult.stdout);
      if (!repository.private || repository.full_name.toLowerCase() !== settings.repo.toLowerCase()) throw new Error('The created GitHub repository does not match the private repository plan. Inspect it before retrying.');
    }
    writeConfig(projectRoot, { ...readConfig(projectRoot), wordpressDeployment: state });
    changed = true;
    for (const [name, value] of Object.entries({ WORDPRESS_ROOT: settings.root, LIVE_URL: settings.url })) {
      if (existingVariables[name] === value) continue;
      const result = spawnSync('gh', ['variable', 'set', name, '--repo', settings.repo], { input: value, encoding: 'utf8', env: ghEnvironment });
      if (result.status !== 0) throw new Error(`Could not set ${name}. Check GitHub permissions and rerun setup.`);
    }
    for (const [name, value] of Object.entries(secretValues)) {
      const hash = createHash('sha256').update(value).digest('hex');
      if (!values['replace-secrets'] && secretNames.has(name) && state.secretsApplied[name] === hash) continue;
      const result = spawnSync('gh', ['secret', 'set', name, '--repo', settings.repo], { input: name === 'KEY' ? privateKey : value, stdio: ['pipe', 'pipe', 'pipe'], env: ghEnvironment });
      if (result.status !== 0) throw new Error(`Could not set ${name}. Successfully written secrets are recorded; rerun setup to resume.`);
      state.secretsApplied[name] = hash;
      writeConfig(projectRoot, { ...readConfig(projectRoot), wordpressDeployment: state });
    }
    const verifiedVariables = JSON.parse(execFileSync('gh', ['variable', 'list', '--repo', settings.repo, '--json', 'name,value'], { encoding: 'utf8', env: ghEnvironment }));
    const verifiedSecrets = JSON.parse(execFileSync('gh', ['secret', 'list', '--repo', settings.repo, '--json', 'name'], { encoding: 'utf8', env: ghEnvironment }));
    if (!Object.keys(secretValues).every((name) => verifiedSecrets.some((secret) => secret.name === name)) || !Object.entries({ WORDPRESS_ROOT: settings.root, LIVE_URL: settings.url }).every(([name, value]) => verifiedVariables.some((entry) => entry.name === name && entry.value === value))) throw new Error('GitHub configuration read-back failed. Rerun setup to inspect and repair missing values.');

    // Recheck the reviewed bytes after build and service work before committing.
    for (const [relative, hash] of [...before, ...sourceHashes]) {
      const file = path.join(projectRoot, relative);
      const current = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
      if (current !== hash) throw new Error(`Project file changed during setup: ${relative}. Changes were preserved; review and retry.`);
    }
    if (hasGit && execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: projectRoot, encoding: 'utf8' }).trim()) throw new Error('The Git index changed during setup. Review staged files and retry.');
    state.pendingFiles = Object.fromEntries([...planned].map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')]));
    writeConfig(projectRoot, { ...readConfig(projectRoot), wordpressDeployment: state });
    for (const [relative, contents] of planned) {
      for (let file = path.join(projectRoot, relative); file !== projectRoot; file = path.dirname(file)) {
        if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Project path changed during setup: ${relative}. Review and retry.`);
      }
      mkdirSync(path.dirname(path.join(projectRoot, relative)), { recursive: true });
      writeFileSync(path.join(projectRoot, relative), contents);
    }
    if (!hasGit) execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: projectRoot });
    if (!origin) execFileSync('git', ['remote', 'add', 'origin', repository.ssh_url], { cwd: projectRoot });
    const finalOrigin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    if (finalOrigin !== (origin || repository.ssh_url) || execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim() !== branch) throw new Error('Git branch or origin changed during setup. Review them before committing.');
    execFileSync('git', ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: projectRoot, input: sourceFiles.join('\0') + '\0', env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
    const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
    if (stagedFiles.some((file) => !sourceFiles.includes(file))) throw new Error('Unexpected staged files appeared. Review the Git index before committing.');
    for (const relative of sourceFiles) {
      const staged = execFileSync('git', ['show', `:${relative}`], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
      if (createHash('sha256').update(staged).digest('hex') !== createHash('sha256').update(readFileSync(path.join(candidate, relative))).digest('hex')) throw new Error(`Staged source differs from the validated snapshot: ${relative}. Review the Git index before committing.`);
    }
    if (stagedFiles.length && spawnSync('git', ['commit', '-m', 'Set up website repository and release deployment'], { cwd: projectRoot, stdio: 'inherit' }).status !== 0) throw new Error('The website commit failed. Prepared files remain staged; complete or unstage the commit, then rerun setup.');
    const expectedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: candidate, encoding: 'utf8' }).trim();
    if (execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8' }).trim() !== expectedTree) throw new Error('The committed tree differs from the validated source. Review commit hooks and source files before pushing.');
    const pushUrls = execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd: projectRoot, encoding: 'utf8' }).trim().split('\n');
    if (pushUrls.length !== 1 || pushUrls[0] !== finalOrigin || execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim() !== branch) throw new Error('The push destination or branch changed during commit. Review Git configuration before pushing.');
    if (spawnSync('git', ['-c', 'push.followTags=false', 'push', '--set-upstream', 'origin', branch], { cwd: projectRoot, stdio: 'inherit' }).status !== 0) throw new Error('The website commit is ready locally, but push failed. Fix Git access or reconcile the remote branch and retry.');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    const published = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: projectRoot, encoding: 'utf8' }).split(/\s+/)[0];
    if (published !== head) throw new Error('The remote branch differs from the prepared commit. Inspect GitHub before publishing a release.');
    delete state.pendingFiles;
    state.commit = head;
    writeConfig(projectRoot, { ...readConfig(projectRoot), wordpressDeployment: state });
    outro(`Website setup complete: https://github.com/${settings.repo}\nTemplate ${template.version}, build/tests, SSH access, GitHub settings, and pushed commit verified.\nPublish a release when ready, then verify its first Actions run and the live website.`);
  } catch (error) {
    if (changed) error.message += '\nCompleted setup steps remain available: local key, repository, and saved progress. Rerun setup with the same settings to resume.';
    throw error;
  } finally {
    rl?.close();
    if (containerDirectory) {
      const cleanup = spawnSync('ddev', ['exec', 'rm', '-rf', '--', containerDirectory], { cwd: projectRoot, stdio: 'ignore' });
      if (cleanup.status !== 0) log.warn(`Remove the temporary validation directory when DDEV is available: ${containerDirectory}`);
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
