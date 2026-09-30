import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { log, note, outro } from '@clack/prompts';
import { askRequired, createPrompts, readConfig, writeConfig } from './cli.mjs';

export async function setupDeployment(args = []) {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries([
      'theme', 'plugin', 'root', 'temp', 'url', 'host', 'user', 'port',
      'key-file', 'hosting-url', 'plugin-main', 'plugin-health', 'dry-run', 'demo',
    ].map((name) => [name, { type: ['dry-run', 'demo'].includes(name) ? 'boolean' : 'string' }])),
    allowPositionals: false,
  });
  if (values.demo) {
    if (Object.keys(values).length !== 1) throw new Error('Use --demo on its own. The walkthrough supplies example values.');
    const result = spawnSync('bash', [fileURLToPath(new URL('./setup-deployment.sh', import.meta.url)), '--demo'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Deployment demo stopped. Run with-scripts setup-deployment --demo to try again.');
    return;
  }
  if (!values['dry-run'] && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Run setup-deployment in an interactive terminal, or use --dry-run for a local preview.');
  }
  const startDirectory = realpathSync(process.cwd());
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (gitRoot.error) throw new Error('Git could not be started. Install Git and run setup-deployment again.');
  if (gitRoot.status !== 0) {
    if (readdirSync(startDirectory).filter((name) => name !== '.DS_Store').length === 0) {
      throw new Error(`This folder is empty: ${startDirectory}.\nTry the wizard with: with-scripts setup-deployment --demo\nFor real deployment setup, create or clone the website project first, then run this command there.`);
    }
    throw new Error(`No Git repository could be read at ${startDirectory}.\nRun setup-deployment inside the website repository. Check git status if this folder should already be a repository.`);
  }
  const projectRoot = realpathSync(gitRoot.stdout.trim());
  for (const relative of ['.github', '.github/workflows', '.github/workflows/deploy-production.yml', '.with-scripts.json']) {
    if (lstatSync(path.join(projectRoot, relative), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Use a regular project path for ${relative}.`);
    }
  }
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (remote.error || remote.status !== 0) {
    throw new Error(`The repository at ${projectRoot} has no readable origin remote.\nConnect it to the intended GitHub repository with git remote add origin <repository-url>, then retry.`);
  }
  const match = remote.stdout.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::[0-9]+)?\/)([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error('The origin remote is not a supported github.com URL.\nThis setup uses GitHub Actions. Check git remote -v and configure the intended GitHub origin before retrying.');
  const repository = match[1];
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0');

  const config = readConfig(projectRoot);
  const saved = config.wordpressDeployment || {};
  const settings = {};
  const themes = [...new Set(tracked.flatMap((file) => file.match(/^wp-content\/themes\/([^/]+)\/style\.css$/)?.slice(1) || []))];
  const currentTheme = path.relative(projectRoot, startDirectory).split(path.sep);
  const themeFromDirectory = currentTheme[0] === 'wp-content' && currentTheme[1] === 'themes' && themes.includes(currentTheme[2]) ? currentTheme[2] : '';
  const promptForMissing = process.stdin.isTTY && !values['dry-run'];
  const rl = promptForMissing ? createPrompts() : null;
  try {
    const fields = [
      ['theme', 'Theme slug', themeFromDirectory || (themes.length === 1 ? themes[0] : '')],
      ['plugin', 'Built plugin slug (none for theme only)', 'none'],
      ['root', 'Absolute production WordPress root', ''],
      ['temp', 'Writable deployment temp directory outside the web root', ''],
      ['url', 'Production HTTPS URL', ''],
      ['host', 'SSH hostname (as used by GitHub Actions)', ''],
      ['user', 'SSH username', ''],
      ['port', 'SSH port', '22'],
      ['key-file', 'Dedicated deployment private-key file', path.join(homedir(), '.ssh', `${repository.replace('/', '-')}-deployment`)],
      ['hosting-url', 'Hosting control panel URL', ''],
    ];
    note(`Deployment project: ${projectRoot}\nGitHub repository: ${repository}`, 'Set up release deployments');
    if (themes.length > 1) log.info(`Tracked themes: ${themes.join(', ')}`);
    for (const [name, label, fallback] of fields) {
      const value = values[name] ?? saved[name] ?? fallback;
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error(`Invalid deployment setting: ${name}.`);
      settings[name] = value.trim();
      if (!settings[name] && promptForMissing) settings[name] = await askRequired(rl, label);
      if (!settings[name]) throw new Error(`Missing --${name}. Supply the option or run setup-deployment in a terminal.`);
    }
    if (settings.plugin !== 'none') {
      for (const [name, label, fallback] of [
        ['plugin-main', 'Plugin loader filename', `${settings.plugin}.php`],
        ['plugin-health', 'Public plugin build file for the HTTP check', ''],
      ]) {
        const value = values[name] ?? saved[name] ?? fallback;
        if (typeof value !== 'string') throw new Error(`Invalid deployment setting: ${name}.`);
        settings[name] = value.trim();
        if (!settings[name] && promptForMissing) settings[name] = await askRequired(rl, label);
        if (!settings[name]) throw new Error(`Missing --${name}.`);
      }
    } else if (values['plugin-main'] || values['plugin-health']) {
      throw new Error('Plugin file options require --plugin=<slug>.');
    }
  } finally {
    rl?.close();
  }

  for (const slug of [settings.theme, settings.plugin]) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Component slugs must use lowercase letters, numbers, and single hyphens.');
  }
  for (const name of ['root', 'temp']) {
    const value = settings[name];
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(value) || value.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error(`--${name} requires an absolute path using letters, numbers, dots, underscores, and hyphens.`);
    }
    settings[name] = path.posix.normalize(value).replace(/\/$/, '');
    if (!settings[name]) throw new Error(`Choose a dedicated directory for --${name}.`);
  }
  if (`${settings.temp}/`.startsWith(`${settings.root}/`)) throw new Error('Deployment temp directory must be outside the WordPress web root.');
  settings.temp += '/';
  const liveUrl = new URL(settings.url);
  if (liveUrl.protocol !== 'https:' || liveUrl.username || liveUrl.password || liveUrl.port || liveUrl.pathname !== '/' || liveUrl.search || liveUrl.hash || !/^[a-zA-Z0-9.-]+$/.test(liveUrl.hostname)) {
    throw new Error('Use a production HTTPS URL at the domain root.');
  }
  settings.url = liveUrl.origin;
  const hostingUrl = new URL(settings['hosting-url']);
  if (hostingUrl.protocol !== 'https:' || hostingUrl.username || hostingUrl.password) throw new Error('Hosting control panel URL must use HTTPS without embedded credentials.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(settings.host)) throw new Error('Use the actual SSH hostname or IPv4 address, rather than a local SSH alias.');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(settings.user)) throw new Error('Invalid SSH username.');
  if (!/^\d+$/.test(settings.port) || Number(settings.port) < 1 || Number(settings.port) > 65535) throw new Error('SSH port must be between 1 and 65535.');
  settings.port = String(Number(settings.port));
  const keyFile = settings['key-file'].replace(/^~\//, `${homedir()}/`);
  if (!path.isAbsolute(keyFile)) throw new Error('Private-key file must be an absolute path outside the website repository.');
  settings['key-file'] = path.resolve(keyFile);
  if (!existsSync(path.dirname(settings['key-file']))) throw new Error('Create the private-key parent directory first, then rerun setup-deployment.');
  const keyParent = realpathSync(path.dirname(settings['key-file']));
  const resolvedKey = path.join(keyParent, path.basename(settings['key-file']));
  if (resolvedKey === projectRoot || resolvedKey.startsWith(`${projectRoot}${path.sep}`) || lstatSync(resolvedKey, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Store the dedicated private key outside the website repository, in a regular file.');
  }
  settings['key-file'] = resolvedKey;

  const themeRoot = `wp-content/themes/${settings.theme}`;
  const pluginRoot = `wp-content/plugins/${settings.plugin}`;
  for (const component of [themeRoot, ...(settings.plugin === 'none' ? [] : [pluginRoot])]) {
    for (const file of ['package.json', 'package-lock.json', ...(component === themeRoot ? ['style.css', 'functions.php', 'theme.json'] : [])]) {
      const relative = `${component}/${file}`;
      const absolute = path.join(projectRoot, relative);
      if (!tracked.includes(relative) || !existsSync(absolute)) throw new Error(`Track ${relative} in Git before preparing deployment.`);
      if (!realpathSync(absolute).startsWith(`${projectRoot}${path.sep}`)) throw new Error(`Deployment source points outside the repository: ${relative}.`);
    }
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, component, 'package.json'), 'utf8'));
    if (!manifest.scripts?.build) throw new Error(`${component}/package.json needs a build script for the shared workflow.`);
  }
  const screenshot = ['screenshot.png', 'screenshot.jpg', 'screenshot.jpeg', 'screenshot.webp'].find((file) => tracked.includes(`${themeRoot}/${file}`) && existsSync(path.join(projectRoot, themeRoot, file)));
  if (!screenshot) throw new Error('Track a theme screenshot before preparing deployment.');
  if (settings.plugin !== 'none') {
    if (!/^[a-zA-Z0-9_-]+\.php$/.test(settings['plugin-main']) || !tracked.includes(`${pluginRoot}/${settings['plugin-main']}`) || !existsSync(path.join(projectRoot, pluginRoot, settings['plugin-main']))) {
      throw new Error('Plugin loader must be a tracked PHP file in the plugin root.');
    }
    if (!/^build\/[a-zA-Z0-9_./-]+$/.test(settings['plugin-health']) || settings['plugin-health'].split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Plugin health path must name a public static file inside build/.');
    }
  }

  const template = settings.plugin === 'none' ? 'deploy-theme.yml' : 'deploy-theme-and-plugin.yml';
  const replacements = {
    WORDPRESS_ROOT: settings.root,
    DEPLOY_TMP_PATH: settings.temp,
    LIVE_URL: settings.url,
    THEME_SLUG: settings.theme,
    THEME_SCREENSHOT: screenshot,
    PLUGIN_SLUG: settings.plugin,
    PLUGIN_MAIN_FILE: settings['plugin-main'],
    PLUGIN_HEALTH_PATH: settings['plugin-health'],
  };
  let workflow = readFileSync(new URL(`../templates/wordpress-project/${template}`, import.meta.url), 'utf8')
    .replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
      if (!replacements[name]) throw new Error(`Missing template value: ${name}.`);
      return replacements[name];
    });
  // Include tracked standard runtime paths plus the generated build directory.
  // Empty or absent optional directories must not break scp-action's archive.
  workflow = workflow.replace(/^          source: (wp-content\/themes\/[^\n]+)$/m, (_, sources) => {
    const included = sources.split(',').filter((source) => {
      const relative = source.replaceAll('${{ env.THEME_SLUG }}', settings.theme)
        .replaceAll('${{ env.THEME_SCREENSHOT }}', screenshot);
      return relative === `${themeRoot}/build` || tracked.some((file) => file === relative || file.startsWith(`${relative}/`));
    });
    return `          source: ${included.join(',')}`;
  });
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'deploy-production.yml');
  if (existsSync(workflowPath) && readFileSync(workflowPath, 'utf8') !== workflow) {
    throw new Error('An existing deploy-production.yml differs from this plan. Review and adapt that workflow manually; it was preserved.');
  }
  if (existsSync(path.dirname(workflowPath))) {
    for (const name of readdirSync(path.dirname(workflowPath))) {
      if (name === 'deploy-production.yml' || !/\.ya?ml$/.test(name)) continue;
      const file = path.join(path.dirname(workflowPath), name);
      if (!lstatSync(file).isFile()) throw new Error(`Use a regular file for workflow ${name}.`);
      const contents = readFileSync(file, 'utf8');
      if (/secrets(?:\.(?:HOST|KEY)\b|\[['"](?:HOST|KEY)['"]\])/.test(contents)) {
        throw new Error(`Existing workflow ${name} uses deployment secrets. Review that setup before adding another deployment workflow.`);
      }
    }
  }
  note([
    `Repository: ${repository}\nTarget: ${settings.user}@${settings.host}:${settings.port}${settings.root}`,
    `URL: ${settings.url}\nTemp path: ${settings.temp}\nTemplate: ${template}`,
    `Key file: ${settings['key-file']}\nWorkflow: ${workflowPath}`,
    'GitHub Actions secrets: HOST, USERNAME, KEY, PORT, FINGERPRINT',
    'Trigger: published release; checkout: the published release tag',
  ].join('\n'), 'Deployment plan');
  console.log(`\n${workflow}`);
  if (values['dry-run']) {
    outro('Preview complete. SSH access, GitHub permissions, and release builds still need verification.');
    return;
  }
  const result = spawnSync('bash', [fileURLToPath(new URL('./setup-deployment.sh', import.meta.url))], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ENV_FILE: '/dev/null',
      GH_HOST: 'github.com',
      GH_REPO: repository,
      WITH_DEPLOY_HOST: settings.host,
      WITH_DEPLOY_USER: settings.user,
      WITH_DEPLOY_PORT: settings.port,
      WITH_DEPLOY_ROOT: settings.root,
      WITH_DEPLOY_TEMP: settings.temp,
      WITH_DEPLOY_THEME: settings.theme,
      WITH_DEPLOY_PLUGIN: settings.plugin,
      WITH_DEPLOY_KEY: settings['key-file'],
      WITH_DEPLOY_HOSTING_URL: settings['hosting-url'],
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error('Deployment setup is incomplete. The workflow was not written. Any created key or updated GitHub secrets remain available for a retry.');
  }
  // Recheck project files after the manual steps, preserving concurrent edits.
  for (const relative of ['.github', '.github/workflows', '.github/workflows/deploy-production.yml', '.with-scripts.json']) {
    const file = path.join(projectRoot, relative);
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Project path changed during setup: ${relative}. GitHub secrets were configured; review the local files.`);
  }
  if (existsSync(workflowPath) && readFileSync(workflowPath, 'utf8') !== workflow) throw new Error('Workflow changed during setup and was preserved. GitHub secrets were configured; review the local workflow.');
  mkdirSync(path.dirname(workflowPath), { recursive: true });
  if (!existsSync(workflowPath)) writeFileSync(workflowPath, workflow, { flag: 'wx' });
  writeConfig(projectRoot, { ...readConfig(projectRoot), wordpressDeployment: settings });
  log.success(`Workflow: ${workflowPath}`);
  log.info('Review and commit the workflow with the website code. Build and test locally before publishing a release.');
  outro('Deployment setup complete.\nPublishing a release starts production deployment. Verify the first Actions run and the public website.');
}
