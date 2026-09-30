import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { confirm, isCancel, log, spinner, text, updateSettings } from '@clack/prompts';

const CONFIG_FILE = '.with-scripts.json';
export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && process.env.TERM !== 'dumb');
updateSettings({ withGuide: interactive });

export function run(label, command, args, options = {}) {
  const started = Date.now();
  if (command === 'ddev' && args[0] === 'wp') {
    args = [
      'exec',
      '--raw',
      '--',
      'php',
      '-d',
      'error_reporting=24575',
      '/usr/local/bin/wp-cli',
      "--exec=WP_CLI::add_hook('after_wp_load', function () { error_reporting(E_ALL & ~E_DEPRECATED); });",
      ...args.slice(1),
    ];
  }
  log.step(label);
  const stdin = options.input ? 'pipe' : 'inherit';
  const result = spawnSync(command, args, {
    input: options.input,
    stdio: [stdin, options.stdout || 'inherit', 'inherit'],
  });
  assertSuccess(label, result, options.errorMessage);
  log.success(`${label} · ${duration(started)}`);
}

export function runCapture(label, command, args, input, printOutput = false, options = {}) {
  const started = Date.now();
  if (command === 'ddev' && args[0] === 'wp') {
    args = [
      'exec',
      '--raw',
      '--',
      'php',
      '-d',
      'error_reporting=24575',
      '/usr/local/bin/wp-cli',
      "--exec=WP_CLI::add_hook('after_wp_load', function () { error_reporting(E_ALL & ~E_DEPRECATED); });",
      ...args.slice(1),
    ];
  }
  log.step(label);
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  assertSuccess(label, result, options.errorMessage);
  if (printOutput && result.stdout) {
    process.stdout.write(result.stdout);
  }
  log.success(`${label} · ${duration(started)}`);
  return result.stdout;
}

export function runToFile(label, command, args, input, destination, options = {}) {
  const started = Date.now();
  if (!interactive) log.step(label);
  const file = openSync(destination, 'wx', 0o600);
  let child;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', file, 'pipe'],
    });
  } catch (error) {
    closeSync(file);
    rmSync(destination, { force: true });
    throw error;
  }
  closeSync(file);
  const indicator = interactive ? spinner() : null;
  indicator?.start(`${label}: waiting for first bytes`);

  const idleTimeoutMs = options.idleTimeoutMs || 90_000;
  const intervalMs = options.intervalMs || 250;
  const frames = ['|', '/', '-', '\\'];
  let frame = 0;
  let lastBytes = 0;
  let lastProgressAt = Date.now();
  let timedOut = false;
  let settled = false;
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const signals = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => child.kill(signal);
      signals.set(signal, handler);
      process.once(signal, handler);
    }

    const cleanup = () => {
      clearInterval(progressTimer);
      for (const [signal, handler] of signals) {
        process.off(signal, handler);
      }
      indicator?.clear();
    };

    const progressTimer = setInterval(() => {
      const bytes = existsSync(destination) ? statSync(destination).size : 0;
      if (bytes > lastBytes) {
        lastBytes = bytes;
        lastProgressAt = Date.now();
      }

      const progress = bytes > 0 ? `${formatBytes(bytes)} received` : 'waiting for first bytes';
      const message = `${frames[frame]} ${label}: ${progress} (${duration(started)})`;
      frame = (frame + 1) % frames.length;
      if (indicator) {
        indicator.message(`${label}: ${progress} (${duration(started)})`);
      } else if (frame === 0) {
        console.log(message);
      }

      if (!timedOut && Date.now() - lastProgressAt >= idleTimeoutMs) {
        timedOut = true;
        child.kill('SIGTERM');
      }
    }, intervalMs);

    child.stdin.on('error', () => {});
    child.stdin.end(input);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stderr) process.stderr.write(stderr);
      rmSync(destination, { force: true });
      reject(new Error(options.errorMessage || `${label} failed: ${error.message}`));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        if (stderr) process.stderr.write(stderr);
        rmSync(destination, { force: true });
        reject(new Error(
          options.idleError
          || `${label} stopped because no new data arrived for ${Math.round(idleTimeoutMs / 1000)} seconds.`,
        ));
        return;
      }
      if (code !== 0) {
        rmSync(destination, { force: true });
        if (options.changedFileError && /file changed as we read it/i.test(stderr)) {
          reject(new Error(options.changedFileError));
          return;
        }
        if (stderr) process.stderr.write(stderr);
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(options.errorMessage || `${label} failed with ${reason}.`));
        return;
      }
      if (stderr) process.stderr.write(stderr);
      lastBytes = existsSync(destination) ? statSync(destination).size : lastBytes;
      log.success(`${label} · ${formatBytes(lastBytes)} · ${duration(started)}`);
      resolve();
    });
  });
}

export function createPrompts() {
  if (interactive) return null;
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export async function ask(rl, label, defaultValue = '', required = false) {
  if (interactive) {
    const answer = await text({
      message: label,
      initialValue: defaultValue || undefined,
      validate: (value) => required && !value?.trim() ? `${label} is required.` : undefined,
    });
    if (isCancel(answer)) {
      const error = new Error('Operation cancelled.');
      error.code = 'WITH_SCRIPTS_CANCELLED';
      throw error;
    }
    return answer.trim() || defaultValue;
  }
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const controller = new AbortController();
  const onClose = () => controller.abort();
  rl.once('close', onClose);
  try {
    const answer = (await rl.question(`${label}${suffix}: `, { signal: controller.signal })).trim();
    return answer || defaultValue;
  } catch (error) {
    if (controller.signal.aborted || error.code === 'ERR_USE_AFTER_CLOSE') {
      throw new Error('Input closed. Run the command in an interactive terminal and complete its prompts.');
    }
    throw error;
  } finally {
    rl.off('close', onClose);
  }
}

export async function askRequired(rl, label, defaultValue = '') {
  while (true) {
    const answer = await ask(rl, label, defaultValue, true);
    if (answer) return answer;
    console.log(`${label} is required.`);
  }
}

export async function askYesNo(rl, label, defaultValue) {
  if (interactive) {
    const answer = await confirm({ message: label, initialValue: defaultValue });
    if (isCancel(answer)) {
      const error = new Error('Operation cancelled.');
      error.code = 'WITH_SCRIPTS_CANCELLED';
      throw error;
    }
    return answer;
  }
  while (true) {
    const answer = (await ask(rl, `${label} ${defaultValue ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
    if (!answer) return defaultValue;
    if (['y', 'yes', 'j', 'ja'].includes(answer)) return true;
    if (['n', 'no', 'nein'].includes(answer)) return false;
    console.log('Please answer yes or no.');
  }
}

export function readConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return {};
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`Invalid ${CONFIG_FILE}. Fix or remove the file before continuing.`);
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error(`Invalid ${CONFIG_FILE}. Fix or remove the file before continuing.`);
  }
  return config;
}

export function writeConfig(projectRoot, config) {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  log.success(`Saved settings to ${configPath}`);
}

function assertSuccess(label, result, errorMessage = '') {
  if (result.error) {
    throw new Error(errorMessage || `${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(errorMessage || `${label} failed with ${reason}.`);
  }
}

function duration(started) {
  const milliseconds = Date.now() - started;
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
