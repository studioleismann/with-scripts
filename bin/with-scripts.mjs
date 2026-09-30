#!/usr/bin/env node

import process from 'node:process';
import { cancel, intro, isCancel, log, select } from '@clack/prompts';
import color from 'picocolors';
import { interactive } from '../src/cli.mjs';
import { configureWordPress } from '../src/configure-wordpress.mjs';
import { inspectWordPress } from '../src/inspect-wordpress.mjs';
import { pushWordPress } from '../src/push-wordpress.mjs';
import { pullWordPress } from '../src/pull-wordpress.mjs';
import { setupWordPress } from '../src/setup-wordpress.mjs';
import { setupTheme } from '../src/setup-theme.mjs';
import { setupDeployment } from '../src/setup-deployment.mjs';
import { syncTools } from '../src/sync-tools.mjs';

const commands = new Map([
  [
    'push-wordpress',
    {
      description: 'Overwrite a remote WordPress site with a local DDEV site after backup and review.',
      options: ['--ssh=<host>', '--root=<path>', '--url=<https-url>', '--php=<path>', '--dry-run', '--prepare-only'],
      run: pushWordPress,
    },
  ],
  [
    'configure-wordpress',
    {
      description: 'Configure the current local DDEV WordPress installation.',
      options: ['--profile=standard', '--dry-run', '--check'],
      run: configureWordPress,
    },
  ],
  [
    'inspect-wordpress',
    {
      description: 'Inspect a remote WordPress environment without changing it.',
      options: [],
      run: inspectWordPress,
    },
  ],
  [
    'pull-wordpress',
    {
      description: 'Pull a remote WordPress site into the current DDEV project.',
      options: [],
      run: pullWordPress,
    },
  ],
  [
    'setup-theme',
    {
      description: 'Create a customer theme from a local With Base starter directory.',
      options: ['--name=<name>', '--slug=<slug>', '--source=<path>', '--patterns-source=<path>', '--theme-tools-source=<path>', '--site-tools-source=<path>', '--replace-existing', '--dry-run', '--yes'],
      run: setupTheme,
    },
  ],
  [
    'setup-deployment',
    {
      description: 'Prepare a release workflow and guide SSH and GitHub secret setup.',
      options: ['--theme=<slug>', '--plugin=<slug|none>', '--root=<path>', '--temp=<path>', '--url=<https-url>', '--host=<hostname>', '--user=<username>', '--port=<port>', '--key-file=<path>', '--hosting-url=<https-url>', '--plugin-main=<file>', '--plugin-health=<build-file>', '--dry-run', '--demo (interactive walkthrough with example values; works in an empty folder)'],
      run: setupDeployment,
    },
  ],
  [
    'setup-wordpress',
    {
      description: 'Inspect production and create a matching local DDEV project.',
      options: [],
      run: setupWordPress,
    },
  ],
  [
    'sync-tools',
    {
      description: 'Synchronize Patterns, Theme Tools, and Site Tools.',
      options: ['--slug=<slug>', '--patterns-source=<path>', '--theme-tools-source=<path>', '--site-tools-source=<path>', '--dry-run'],
      run: syncTools,
    },
  ],
]);

let command = process.argv[2] || 'help';
let args = process.argv.slice(3);

if (interactive) {
  if (process.stdout.columns >= 60) {
    console.log([
      '',
      color.cyan('  ╭─╴') + color.dim('─'.repeat(50)) + color.cyan('╶─╮'),
      color.cyan('  │') + ' '.repeat(54) + color.cyan('│'),
      ...[
        ' __          __  _____   _______   _    _',
        ' \\ \\        / / |_   _| |__   __| | |  | |',
        '  \\ \\  /\\  / /    | |      | |    | |__| |',
        '   \\ \\/  \\/ /     | |      | |    |  __  |',
        '    \\  /\\  /     _| |_     | |    | |  | |',
        '     \\/  \\/     |_____|    |_|    |_|  |_|',
      ].map((line) => color.cyan('  │') + '     ' + color.bold(line.padEnd(44)) + '     ' + color.cyan('│')),
      color.cyan('  │') + ' '.repeat(54) + color.cyan('│'),
      color.cyan('  ╰─╴') + color.dim('─'.repeat(5)) + color.cyan('  S C R I P T S  ') + color.dim('─'.repeat(29)) + color.cyan('╶─╯'),
      '',
    ].join('\n'));
  } else {
    console.log(color.bold('\n  W I T H') + color.dim(' / scripts\n'));
  }
  intro(`${color.bgCyan(color.black(' with-scripts '))} ${color.dim('WordPress · DDEV · Deployment')}`);
}

if (!process.argv[2] && interactive) {
  const selection = await select({
    message: 'What would you like to do?',
    options: [
      { value: 'setup-wordpress', label: 'Set up local WordPress', hint: 'Match DDEV to an existing server' },
      { value: 'inspect-wordpress', label: 'Inspect a WordPress site', hint: 'Read the remote environment' },
      { value: 'pull-wordpress', label: 'Pull a site into DDEV', hint: 'Replace the local copy from production' },
      { value: 'configure-wordpress', label: 'Configure local WordPress', hint: 'Pages, settings, and plugins' },
      { value: 'setup-theme', label: 'Create a customer theme', hint: 'Start from With Base' },
      { value: 'sync-tools', label: 'Synchronize shared tools', hint: 'Patterns, Theme Tools, and Site Tools' },
      { value: 'setup-deployment', label: 'Set up release deployments', hint: 'SSH access and GitHub Actions' },
      { value: 'push-wordpress', label: 'Push a site to the server', hint: 'Replaces the target website after review' },
      { value: 'demo', label: 'Try the deployment wizard', hint: 'Simulated steps with example values' },
      { value: 'help', label: 'Show commands and help' },
    ],
    maxItems: 10,
  });
  if (isCancel(selection)) {
    cancel('Operation cancelled.');
    process.exit(130);
  }
  command = selection === 'demo' ? 'setup-deployment' : selection;
  if (selection === 'demo') args = ['--demo'];
}

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const selectedCommand = commands.get(command);

if (!selectedCommand) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

try {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`\nUsage: with-scripts ${command}${selectedCommand.options.length ? ' [options]' : ''}`);
    console.log(`\n${selectedCommand.description}`);
    console.log('\nOptions:');
    for (const option of [...selectedCommand.options, '--help, -h']) console.log(`  ${option}`);
    if (!selectedCommand.options.length) console.log('\nThis command collects its settings interactively.');
    console.log('');
  } else {
    if (!selectedCommand.options.length && args.length) {
      throw new Error(`Unknown option for ${command}: ${args[0]}. Run with-scripts ${command} --help.`);
    }
    if (interactive) log.step(color.bold(command));
    await selectedCommand.run(args);
  }
} catch (error) {
  if (error.code === 'WITH_SCRIPTS_CANCELLED') {
    cancel(error.message, { output: process.stderr });
    process.exitCode = 130;
  } else {
    if (interactive) cancel(`Error: ${error.message}`, { output: process.stderr });
    else console.error(`\nError: ${error.message}`);
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log('\nwith-scripts\n');
  console.log('Usage:');
  console.log('  with-scripts <command>\n');
  console.log('Commands:');

  for (const [name, { description }] of commands) {
    console.log(`  ${name.padEnd(20)} ${description}`);
  }

  console.log('');
}
