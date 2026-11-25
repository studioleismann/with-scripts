import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectWordPressProjectRoot,
  parseSetupThemeArgs,
  personalizeTheme,
  validateThemeIdentity,
} from '../src/setup-theme.mjs';

test('setup-theme parses its explicit command-line contract', () => {
  assert.deepEqual(
    parseSetupThemeArgs([
      '--name=Example Theme',
      '--slug=exampletheme',
      '--source=/tmp/with-art',
      '--replace-existing',
      '--dry-run',
      '--yes',
    ]),
    {
      name: 'Example Theme',
      slug: 'exampletheme',
      source: '/tmp/with-art',
      toolSources: {},
      replaceExisting: true,
      dryRun: true,
      yes: true,
    },
  );
  assert.throws(
    () => parseSetupThemeArgs(['--template-engine']),
    /Unknown option/,
  );
  assert.deepEqual(parseSetupThemeArgs([
    '--patterns-source=/tmp/example-patterns',
    '--theme-tools-source=/tmp/example-theme-tools',
    '--site-tools-source=/tmp/example-site-tools',
  ]).toolSources, {
    patterns: '/tmp/example-patterns',
    themeTools: '/tmp/example-theme-tools',
    siteTools: '/tmp/example-site-tools',
  });
  assert.throws(() => parseSetupThemeArgs(['--patterns-source=']), /Provide a local directory/);
});

test('theme identities require a customer name and safe WordPress slug', () => {
  assert.doesNotThrow(() => validateThemeIdentity('Example Theme', 'exampletheme'));
  assert.doesNotThrow(() => validateThemeIdentity('Example Portal', 'example-portal'));
  assert.throws(() => validateThemeIdentity('', 'customer'), /Theme name/);
  assert.throws(() => validateThemeIdentity('Customer', 'Customer Theme'), /Theme slug/);
  assert.throws(() => validateThemeIdentity('With Art', 'with-art'), /customer theme slug/);
});

test('WordPress project detection works from the project and theme roots', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'with-scripts-project-'));
  const theme = path.join(project, 'wp-content', 'themes', 'customer');
  try {
    mkdirSync(path.join(project, '.ddev'), { recursive: true });
    mkdirSync(theme, { recursive: true });
    writeFileSync(path.join(project, '.ddev', 'config.yaml'), 'name: customer\n');

    assert.equal(detectWordPressProjectRoot(project), project);
    assert.equal(detectWordPressProjectRoot(theme), project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('theme personalization replaces With Art identity but preserves shared tools', () => {
  const theme = mkdtempSync(path.join(tmpdir(), 'with-scripts-theme-'));
  try {
    mkdirSync(path.join(theme, 'inc', 'with-art'), { recursive: true });
    mkdirSync(
      path.join(theme, '.git', 'refs', 'heads', 'backup'),
      { recursive: true },
    );
    mkdirSync(path.join(theme, 'styles', 'typography'), { recursive: true });
    writeFileSync(
      path.join(theme, 'style.css'),
      `/*
Theme Name: with-art
Theme URI: https://example.com/with-art
Description: With Art is a flexible block theme.
Text Domain: with-art
*/
`,
    );
    writeFileSync(
      path.join(theme, 'package.json'),
      `${JSON.stringify({
        name: 'with-art',
        description: 'With Art',
        scripts: {
          start: 'WITH_ART_BS_PROXY=https://example-theme.local/ wp-scripts start --config webpack.dev.js',
        },
      })}\n`,
    );
    writeFileSync(
      path.join(theme, 'README.md'),
      '# with-art WordPress Block Theme\n\nwith-art is released under the [GPLv2](LICENSE).\n',
    );
    writeFileSync(
      path.join(theme, 'functions.php'),
      "<?php\nfunction with_art_setup() { load_theme_textdomain( 'with-art' ); }\nrequire 'packages/with-patterns/index.php';\n// with-theme-tools and with-site-tools stay independent.\n",
    );
    writeFileSync(
      path.join(theme, 'webpack.dev.js'),
      "export default { proxy: process.env.WITH_ART_BS_PROXY };\n",
    );
    writeFileSync(
      path.join(theme, 'inc', 'with-art', 'setup.php'),
      "<?php\nconst WITH_ART_VERSION = '1';\n",
    );
    writeFileSync(
      path.join(theme, 'styles', 'typography', 'with-art-fonts.json'),
      '{"slug":"with-art-fonts"}\n',
    );
    writeFileSync(
      path.join(theme, '.git', 'refs', 'heads', 'backup', 'pre-with-art-test'),
      '0123456789012345678901234567890123456789\n',
    );

    personalizeTheme(theme, {
      name: 'Example Theme',
      slug: 'exampletheme',
      localUrl: 'https://example-project.ddev.site',
    });

    assert.equal(existsSync(path.join(theme, 'inc', 'with-art')), false);
    assert.equal(existsSync(path.join(theme, 'inc', 'exampletheme')), true);
    assert.equal(
      existsSync(
        path.join(
          theme,
          '.git',
          'refs',
          'heads',
          'backup',
          'pre-with-art-test',
        ),
      ),
      true,
    );
    assert.equal(
      existsSync(path.join(theme, 'styles', 'typography', 'exampletheme-fonts.json')),
      true,
    );
    const functions = readFileSync(path.join(theme, 'functions.php'), 'utf8');
    assert.match(functions, /function exampletheme_setup/);
    assert.match(functions, /load_theme_textdomain\( 'exampletheme' \)/);
    assert.match(functions, /packages\/with-patterns/);
    assert.doesNotMatch(functions, /packages\/with-theme-tools/);
    assert.match(functions, /with-site-tools/);

    const style = readFileSync(path.join(theme, 'style.css'), 'utf8');
    assert.match(style, /Theme Name: Example Theme/);
    assert.match(style, /Text Domain: exampletheme/);
    assert.doesNotMatch(style, /Theme URI:/);

    const packageJson = JSON.parse(readFileSync(path.join(theme, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'exampletheme');
    assert.match(
      readFileSync(path.join(theme, 'inc', 'exampletheme', 'setup.php'), 'utf8'),
      /const EXAMPLETHEME_VERSION/,
    );
    assert.match(
      readFileSync(path.join(theme, 'webpack.dev.js'), 'utf8'),
      /process\.env\.EXAMPLETHEME_BS_PROXY/,
    );
    assert.equal(
      packageJson.scripts.start,
      'EXAMPLETHEME_BS_PROXY=https://example-project.ddev.site/ wp-scripts start --config webpack.dev.js',
    );
  } finally {
    rmSync(theme, { recursive: true, force: true });
  }
});
