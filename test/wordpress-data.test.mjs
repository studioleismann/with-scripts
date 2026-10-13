import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildPushPreflightScript, CORE_PATHS, exportUrlPattern } from '../src/push-wordpress.mjs';

const script = path.resolve(import.meta.dirname, '../src/wordpress-data.php');
const parser = path.resolve(import.meta.dirname, '../src/wordpress-block-parser.php');
const remote = readFileSync(path.resolve(import.meta.dirname, '../src/push-remote.sh'), 'utf8');

test('configuration is tokenized without executing PHP, including escaped literal values', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-literal-')));
  try {
    const marker = path.join(root, 'executed');
    const values = [String.raw`a\'b\\c`, String.raw`a\\\'b`, String.raw`double\nline\$dollar\"quote\x21\101\q`];
    for (const [index, value] of values.entries()) {
      const literal = index === 2 ? `"${value}"` : `'${value}'`;
      const config = `<?php file_put_contents(${JSON.stringify(marker)}, 'unsafe'); define('DB_PASSWORD', ${literal}); $table_prefix='wp_'; require 'wp-load.php';`;
      writeFileSync(path.join(root, 'wp-config.php'), config);
      writeFileSync(path.join(root, 'wp-load.php'), `<?php file_put_contents(${JSON.stringify(marker)}, 'unsafe');`);
      const expected = execFileSync('php', ['-r', `echo ${literal};`], { encoding: 'utf8' });
      const actual = execFileSync('php', [script, 'config', root, 'DB_PASSWORD'], { encoding: 'utf8' });
      assert.equal(actual, expected);
      assert.equal(existsSync(marker), false);
    }
    for (const definition of ["define('DB_PASSWORD', getenv('PASSWORD'));", "define('DB_PASSWORD', 'a' . 'b');", "define('DB_PASSWORD', 'one'); define('DB_PASSWORD', 'two');"]) {
      writeFileSync(path.join(root, 'wp-config.php'), `<?php ${definition} $table_prefix='wp_';`);
      const result = spawnSync('php', [script, 'config', root, 'DB_PASSWORD'], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
    }
    rmSync(path.join(root, 'wp-config.php'));
    symlinkSync(path.join(root, 'wp-load.php'), path.join(root, 'wp-config.php'));
    assert.equal(spawnSync('php', [script, 'config', root, 'DB_PASSWORD']).status, 1);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('serialized URL replacement preserves lengths, references, objects and protected CSS without wakeup', () => {
  const pattern = `~${exportUrlPattern(['https://example.org'])}~`;
  const result = spawnSync('php', ['-r', `
    $settings=json_decode(stream_get_contents(STDIN),true);
    $argv=['fixture','library']; require $settings['script'];
    class ExamplePayload { public string $url='https://example.org/page'; public function __wakeup(){throw new RuntimeException('Object code executed');} }
    $value=['url'=>'https://example.org/page','nested'=>serialize(['url'=>'https://example.org/nested']),'object'=>new ExamplePayload(),'json'=>'{"style":{"css":"& { background: url(https://example.org/css); }"},"url":"https://example.org/json"}'];
    $value['ref']=&$value['url'];
    $serialized=serialize($value);
    $changed=with_scripts_replace_value($serialized,$settings['pattern'],'https://example.local');
    $safe=unserialize($changed,['allowed_classes'=>false]);
    if ($safe['url']!=='https://example.local/page' || $safe['ref']!==$safe['url'] || unserialize($safe['nested'])['url']!=='https://example.local/nested') exit(2);
    if (json_decode($safe['json'],true)['style']['css']!=='& { background: url(https://example.org/css); }') exit(3);
    if (serialize($safe)!==$changed) exit(4);
    echo $changed;
  `], { input: JSON.stringify({ script, pattern }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /example\.local\/page/);
  assert.match(result.stdout, /example\.org\/css/);
});

test('pull inventories stored Custom CSS classes and detects additions on blocks without CSS', () => {
  const css = '& { content: "\\\\"; }\n& a { color: red; }';
  const original = `<!-- wp:group {"className":"hero has-custom-css","style":{"css":${JSON.stringify(css)}}} -->
<!-- wp:paragraph {"className":"existing has-custom-css"} --><p>https://example.org/page</p><!-- /wp:paragraph -->
<!-- wp:paragraph {"className":"plain"} --><p>Unchanged</p><!-- /wp:paragraph -->
<!-- /wp:group -->`;
  const result = spawnSync('php', ['-r', `
    $settings=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
    $argv=['fixture','library']; require $settings['script']; require $settings['parser'];
    $parser=new WP_Block_Parser();
    $before=with_scripts_data_css($parser->parse($settings['content']),'',true);
    $changed=with_scripts_replace_value($settings['content'],$settings['pattern'],'https://example.local');
    if(with_scripts_data_css($parser->parse($changed),'',true)!==$before)exit(2);
    foreach(['"plain"'=>'"plain has-custom-css"','"existing has-custom-css"'=>'"existing"'] as $from=>$to) {
      if(with_scripts_data_css($parser->parse(str_replace($from,$to,$changed)),'',true)===$before)exit(3);
    }
    try { with_scripts_data_css($parser->parse($settings['content'])); exit(4); }
    catch(RuntimeException $error) { if(!str_contains($error->getMessage(),'has-custom-css'))exit(5); }
    echo json_encode($before,JSON_THROW_ON_ERROR);
  `], { input: JSON.stringify({ script, parser, content: original, pattern: `~${exportUrlPattern(['https://example.org'])}~` }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: '/0', className: 'hero has-custom-css', css },
    { path: '/0/0', className: 'existing has-custom-css' },
  ]);
});

const databaseScript = `
$s=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);
$db=new mysqli(getenv('WITH_SCRIPTS_TEST_DB'),'root',getenv('WITH_SCRIPTS_TEST_DB_PASSWORD'));
$db->set_charset('utf8mb4');
if(isset($s['database']))$db->select_db($s['database']);
if(isset($s['sql'])) { $db->multi_query($s['sql']); do {if($result=$db->store_result())$result->free();}while($db->more_results()&&$db->next_result()); }
if(isset($s['query']))echo json_encode($db->query($s['query'])->fetch_all(MYSQLI_ASSOC),JSON_THROW_ON_ERROR);
`;

for (const scenario of ['replacement', 'pull replacement', 'successful push', 'failed push']) {
  test(`database integration: ${scenario} leaves application PHP unexecuted`, { skip: !process.env.WITH_SCRIPTS_TEST_DB }, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-data-')));
    const site = path.join(root, 'httpdocs');
    const workspace = path.join(root, '.with-scripts-push.fixture');
    const staging = path.join(root, 'staging');
    const bin = path.join(root, 'bin');
    const database = 'with_scripts_' + randomBytes(8).toString('hex');
    const marker = path.join(root, 'application-executed');
    const prefix = scenario.endsWith('replacement') ? 'wp_' : 'old_';
    const original = scenario === 'pull replacement'
      ? '<!-- wp:group {"className":"hero has-custom-css","style":{"css":"& { background: url(https://example.org/css); }"}} --><!-- wp:paragraph {"className":"existing has-custom-css"} --><p>https://example.org/page</p><!-- /wp:paragraph --><!-- wp:paragraph {"className":"plain"} --><p>Unchanged</p><!-- /wp:paragraph --><!-- /wp:group -->'
      : '<!-- wp:group {"className":"hero","style":{"css":"& { background: url(https://example.org/css); }"}} --><p>https://example.org/page</p><!-- /wp:group -->';
    const columnSql = '(ID bigint PRIMARY KEY, post_parent bigint NOT NULL, post_type varchar(30) NOT NULL, post_status varchar(30) NOT NULL, post_modified_gmt datetime NOT NULL, post_content longtext NOT NULL, guid varchar(255) NOT NULL) ENGINE=InnoDB';
    const schema = `CREATE TABLE ${prefix}posts ${columnSql}; CREATE TABLE ${prefix}options (option_id bigint PRIMARY KEY, option_name varchar(100), option_value longtext) ENGINE=InnoDB; CREATE TABLE ${prefix}plugin_data (id bigint PRIMARY KEY, value longtext, updated_at timestamp(6) NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), touched_at datetime(6) NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB;`;
    const seed = `INSERT INTO ${prefix}posts VALUES (1,0,'page','publish','2026-10-08 00:00:00',CONVERT(0x${Buffer.from(original).toString('hex')} USING utf8mb4),'https://example.org/?p=1'),(2,1,'revision','inherit','2026-10-08 00:01:00',CONVERT(0x${Buffer.from(original+'latest revision').toString('hex')} USING utf8mb4),'https://example.org/?p=2'),(3,1,'revision','inherit','2026-10-08 00:02:00',CONVERT(0x${Buffer.from(original+'autosave').toString('hex')} USING utf8mb4),'https://example.org/?p=3'); INSERT INTO ${prefix}options VALUES (1,'home','https://example.org'),(2,'siteurl','https://example.org'),(3,'stylesheet','example-theme'),(4,'template','example-theme'),(5,'active_plugins','a:1:{i:0;s:18:"example/plugin.php";}'); INSERT INTO ${prefix}plugin_data VALUES (1,'a:1:{s:3:"url";s:24:"https://example.org/page";}','2020-01-02 03:04:05.123456','2019-02-03 04:05:06.654321'),(2,'https://example.org/nullable',NULL,NULL);`;
    try {
      execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ sql: `CREATE DATABASE ${database} CHARACTER SET utf8mb4; USE ${database}; ${schema} ${seed}` }) });
      for (const directory of [site, workspace, staging, bin, path.join(root, '.with-scripts-push.lock')]) mkdirSync(directory);
      const attack = `<?php file_put_contents(${JSON.stringify(marker)}, 'application PHP executed');`;
      const config = `<?php define('DB_HOST', '${process.env.WITH_SCRIPTS_TEST_DB}'); define('DB_NAME','${database}'); define('DB_USER','root'); define('DB_PASSWORD','${process.env.WITH_SCRIPTS_TEST_DB_PASSWORD}'); $table_prefix='${prefix}'; file_put_contents(${JSON.stringify(marker)}, 'config executed'); require 'wp-load.php';`;
      writeFileSync(path.join(site, 'wp-config.php'), config);
      for (const entry of CORE_PATHS) {
        if (['wp-admin', 'wp-includes'].includes(entry)) {
          mkdirSync(path.join(site, entry)); mkdirSync(path.join(staging, entry));
        } else { writeFileSync(path.join(site, entry), attack); writeFileSync(path.join(staging, entry), attack); }
      }
      for (const target of [site, staging]) {
        mkdirSync(path.join(target, 'wp-content/themes/example-theme'), { recursive: true });
        mkdirSync(path.join(target, 'wp-content/plugins/example'), { recursive: true });
        writeFileSync(path.join(target, 'wp-content/themes/example-theme/style.css'), '/* Example Theme */');
        writeFileSync(path.join(target, 'wp-content/themes/example-theme/functions.php'), attack);
        writeFileSync(path.join(target, 'wp-content/plugins/example/plugin.php'), attack);
        writeFileSync(path.join(target, 'wp-includes/version.php'), `${attack} $wp_version='7.1.2';`);
      }
      const preflight = spawnSync('bash', ['-s', '--', site, 'https://example.org', 'php'], { input: buildPushPreflightScript(), encoding: 'utf8' });
      assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
      assert.equal(JSON.parse(preflight.stdout).prefix, prefix);
      assert.equal(existsSync(marker), false);
      if (scenario === 'pull replacement') {
        const strict = spawnSync('php', [script, 'inspect', site], { encoding: 'utf8' });
        assert.equal(strict.status, 1, strict.stdout + strict.stderr);
        assert.match(strict.stderr, /has-custom-css must not be stored in className/);
      }
      const inventoryScript = `
        $argv=['fixture','library'];require $s['script'];require $s['parser'];
        $parser=new WP_Block_Parser();$posts=[];
        foreach($db->query('SELECT * FROM wp_posts ORDER BY ID')->fetch_all(MYSQLI_ASSOC) as $post) {
          $post['before']=hash('sha256',$post['post_content']);
          $post['css']=with_scripts_data_css($parser->parse($post['post_content']),'',true);$posts[]=$post;
        }
        echo json_encode(['posts'=>$posts],JSON_THROW_ON_ERROR);
      `;
      const pullInventory = () => JSON.parse(execFileSync('php', ['-r', databaseScript + inventoryScript], { input: JSON.stringify({ database, script, parser }), encoding: 'utf8' }));
      const before = scenario === 'pull replacement'
        ? { ...JSON.parse(execFileSync('php', [script, 'pull-preflight', site, 'https://example.org'], { encoding: 'utf8' })), ...pullInventory() }
        : JSON.parse(execFileSync('php', [script, 'inspect', site], { encoding: 'utf8' }));
      assert.equal(before.posts.length, 3);
      assert.equal(before.posts[0].css[0].path, '/0');
      assert.equal(before.posts[0].css[0].className, scenario === 'pull replacement' ? 'hero has-custom-css' : 'hero');
      if (scenario.endsWith('replacement')) {
        const settings = Buffer.from(JSON.stringify({ pattern: `~${exportUrlPattern(['https://example.org'])}~`, replacement: 'https://example.local' })).toString('base64');
        const mode = scenario === 'pull replacement' ? 'pull-replace' : 'replace';
        if (scenario === 'pull replacement') {
          // A second site's malformed values, nontransactional tables and views are outside the pull scope.
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: `CREATE TABLE other_options (id int PRIMARY KEY, value longtext) ENGINE=MyISAM; INSERT INTO other_options VALUES (1,'s:1:"https://example.org/other";'); CREATE VIEW other_view AS SELECT * FROM other_options;` }) });
          for (const strictMode of ['preflight', 'replace']) {
            const strict = spawnSync('php', [script, strictMode, site, strictMode === 'replace' ? settings : 'https://example.org'], { encoding: 'utf8' });
            assert.equal(strict.status, 1, strict.stdout + strict.stderr);
            assert.match(strict.stderr, /Shared databases are unsupported/);
          }
          writeFileSync(path.join(site, 'wp-config.php'), config.replace("$table_prefix='wp_'", "$table_prefix='missing_'"));
          const missing = spawnSync('php', [script, mode, site, settings], { encoding: 'utf8' });
          writeFileSync(path.join(site, 'wp-config.php'), config);
          assert.equal(missing.status, 1, missing.stdout + missing.stderr);
          assert.match(missing.stderr, /tables are missing for prefix "missing_"/);
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: 'CREATE VIEW wp_view AS SELECT * FROM wp_options;' }) });
          const view = spawnSync('php', [script, mode, site, settings], { encoding: 'utf8' });
          assert.equal(view.status, 1, view.stdout + view.stderr);
          assert.match(view.stderr, /Review view: wp_view/);
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: 'DROP VIEW wp_view; CREATE TABLE wp_legacy (id int PRIMARY KEY, value longtext) ENGINE=MyISAM;' }) });
          const engine = spawnSync('php', [script, mode, site, settings], { encoding: 'utf8' });
          assert.equal(engine.status, 1, engine.stdout + engine.stderr);
          assert.match(engine.stderr, /Use InnoDB.*wp_legacy/);
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: 'DROP TABLE wp_legacy;' }) });
          const unchanged = JSON.parse(execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, query: 'SELECT post_content FROM wp_posts ORDER BY ID' }), encoding: 'utf8' }));
          assert.deepEqual(unchanged.map(row => row.post_content), [original, original + 'latest revision', original + 'autosave']);
          const addedClass = spawnSync('php', [script, mode, site, Buffer.from(JSON.stringify({ pattern: '~plain~', replacement: 'plain has-custom-css' })).toString('base64')], { encoding: 'utf8' });
          assert.equal(addedClass.status, 1, addedClass.stdout + addedClass.stderr);
          assert.match(addedClass.stderr, /would change protected Custom CSS or className/);
          assert.deepEqual(pullInventory(), { posts: before.posts });
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: `CREATE TRIGGER inject_class BEFORE UPDATE ON wp_posts FOR EACH ROW SET NEW.post_content=REPLACE(NEW.post_content,'"plain"','"plain has-custom-css"');` }) });
          const injectedClass = spawnSync('php', [script, mode, site, settings], { encoding: 'utf8' });
          assert.equal(injectedClass.status, 1, injectedClass.stdout + injectedClass.stderr);
          assert.match(injectedClass.stderr, /URL replacement verification failed; changes rolled back/);
          assert.deepEqual(pullInventory(), { posts: before.posts });
          const rolledBackOptions = JSON.parse(execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, query: "SELECT option_value FROM wp_options WHERE option_name IN ('home','siteurl') ORDER BY option_id" }), encoding: 'utf8' }));
          assert.deepEqual(rolledBackOptions.map(row => row.option_value), ['https://example.org', 'https://example.org']);
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: 'DROP TRIGGER inject_class;' }) });
        }
        const result = spawnSync('php', [script, mode, site, settings], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        if (scenario === 'pull replacement') {
          const checked = JSON.parse(execFileSync('php', [script, 'pull-preflight', site, 'https://example.local'], { encoding: 'utf8' }));
          assert.deepEqual(checked.tables, before.tables);
          const foreign = JSON.parse(execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, query: 'SELECT * FROM other_view' }), encoding: 'utf8' }));
          assert.equal(foreign[0].value, 's:1:"https://example.org/other";');
          execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: 'DROP VIEW other_view; DROP TABLE other_options;' }) });
        }
        const after = scenario === 'pull replacement' ? pullInventory() : JSON.parse(execFileSync('php', [script, 'inspect', site], { encoding: 'utf8' }));
        for (let index = 0; index < before.posts.length; index++) {
          assert.deepEqual(after.posts[index].css, before.posts[index].css);
          assert.notEqual(after.posts[index].before, before.posts[index].before);
        }
        const rows = JSON.parse(execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, query: 'SELECT * FROM wp_plugin_data' }), encoding: 'utf8' }));
        assert.equal(rows[0].value, 'a:1:{s:3:"url";s:26:"https://example.local/page";}');
        assert.equal(rows[0].updated_at, '2020-01-02 03:04:05.123456');
        assert.equal(rows[0].touched_at, '2019-02-03 04:05:06.654321');
        assert.equal(rows[1].value, 'https://example.local/nullable');
        assert.equal(rows[1].updated_at, null);
        assert.equal(rows[1].touched_at, null);
        const posts = JSON.parse(execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, query: 'SELECT * FROM wp_posts ORDER BY ID' }), encoding: 'utf8' }));
        assert.equal(posts[0].post_content, original.replace('<p>https://example.org/page', '<p>https://example.local/page'));
        assert.equal(posts[0].guid, 'https://example.org/?p=1');
        // A malformed serialized value must fail during planning, before any row changes.
        execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ database, sql: `UPDATE wp_plugin_data SET value='s:1:"https://example.local/bad";';` }) });
        const failed = spawnSync('php', [script, mode, site, Buffer.from(JSON.stringify({ pattern: `~${exportUrlPattern(['https://example.local'])}~`, replacement: 'https://example-next.local' })).toString('base64')], { encoding: 'utf8' });
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.deepEqual(scenario === 'pull replacement' ? pullInventory() : JSON.parse(execFileSync('php', [script, 'inspect', site], { encoding: 'utf8' })), after);
      } else {
        const sourcePrefix = 'source_';
        const sourceSql = `SET NAMES utf8mb4; ${schema.replaceAll('old_', sourcePrefix)} ${seed.replaceAll('old_', sourcePrefix)}`;
        const manifest = { ...structuredClone(before), tables: before.tables.map(name => name.replace('old_', sourcePrefix)), tableRows: Object.fromEntries(Object.entries(before.tableRows).map(([name,count]) => [name.replace('old_',sourcePrefix),count])), theme:'example-theme', template:'example-theme', plugins:['example/plugin.php'] };
        if (scenario === 'failed push') manifest.posts[0].after = '0'.repeat(64);
        copyFileSync(script, path.join(workspace, 'wordpress-data.php'));
        copyFileSync(parser, path.join(workspace, 'wordpress-block-parser.php'));
        writeFileSync(path.join(workspace, 'content.json'), JSON.stringify(manifest));
        writeFileSync(path.join(workspace, 'preflight.sh'), buildPushPreflightScript());
        writeFileSync(path.join(workspace, 'managed-paths'), [...CORE_PATHS, 'wp-content', 'wp-config.php', 'index.html'].join('\n')+'\n');
        writeFileSync(path.join(workspace, 'source-tables'), manifest.tables.join('\n')+'\n');
        writeFileSync(path.join(workspace, 'target-tables'), before.tables.join('\n')+'\n');
        writeFileSync(path.join(workspace, 'database.sql.gz'), gzipSync(sourceSql));
        execFileSync('tar', ['-czf', path.join(workspace, 'files.tar.gz'), '-C', staging, '.']);
        const uploads = ['wordpress-data.php','wordpress-block-parser.php','content.json','preflight.sh','managed-paths','source-tables','target-tables','database.sql.gz','files.tar.gz'];
        writeFileSync(path.join(workspace, 'SHA256SUMS'), uploads.map(name => `${createHash('sha256').update(readFileSync(path.join(workspace,name))).digest('hex')}  ${name}`).join('\n')+'\n');
        writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2); if(!args.includes('--output')) process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(site)},new URL(args.at(-1)).pathname))); else {fs.writeFileSync(args[args.indexOf('--output')+1],'<html>Fixture</html>');process.stdout.write('200');}\n`, { mode:0o755 });
        for (const [command, executable] of [['mysql', process.env.WITH_SCRIPTS_TEST_MYSQL], ['mysqldump', process.env.WITH_SCRIPTS_TEST_MYSQLDUMP]]) {
          if (executable) writeFileSync(path.join(bin, command), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(executable)},['--skip-ssl-verify-server-cert',...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
        }
        const result = spawnSync('bash', ['-s', '--', site, workspace, 'https://example.org', sourcePrefix, '7.1.2', 'php'], { input:remote, encoding:'utf8', env:{...process.env,PATH:`${bin}:${process.env.PATH}`}, timeout:30000 });
        assert.equal(result.status, scenario==='successful push'?0:1, result.stdout+result.stderr);
        assert.equal(readFileSync(path.join(workspace,'status'),'utf8').trim(), scenario==='successful push'?'VERIFIED':'ROLLED_BACK', result.stdout+result.stderr);
        if(scenario==='failed push') assert.deepEqual(JSON.parse(execFileSync('php',[script,'inspect',site],{encoding:'utf8'})),before);
      }
      assert.equal(existsSync(marker), false, 'Application-controlled config/core/plugin/theme PHP must never run as the deployment user.');
    } finally {
      execFileSync('php', ['-r', databaseScript], { input: JSON.stringify({ sql: `DROP DATABASE IF EXISTS ${database}` }) });
      rmSync(root, { recursive:true,force:true });
    }
  });
}
