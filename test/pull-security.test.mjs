import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const cli = path.resolve(import.meta.dirname, '../bin/with-scripts.mjs');
test('pull finishes without bootstrapping imported config, core, plugins or themes', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'with-scripts-pull-security-')));
  const project = path.join(root, 'project');
  const production = path.join(root, 'production');
  const bin = path.join(root, 'bin');
  const marker = path.join(root, 'application-executed');
  const calls = path.join(root, 'calls.jsonl');
  try {
    for (const directory of [bin, path.join(project, '.ddev'), path.join(production, 'wp-content/themes/example-theme'), path.join(production, 'wp-content/plugins/example'), path.join(production,'wp-includes')]) mkdirSync(directory,{recursive:true});
    writeFileSync(path.join(project, '.ddev/config.yaml'), 'name: example\nproject_tld: local\n');
    const payload = `file_put_contents(${JSON.stringify(marker)}, 'unsafe');`;
    writeFileSync(path.join(production,'wp-config.php'), `<?php ${payload} define('DB_NAME','production'); define('DB_USER','production'); define('DB_PASSWORD','production'); define('DB_HOST','localhost'); $table_prefix='example_'; require 'wp-load.php';`);
    for(const name of ['wp-load.php','wp-settings.php','wp-includes/version.php','wp-content/themes/example-theme/functions.php','wp-content/plugins/example/plugin.php']) writeFileSync(path.join(production,name),`<?php ${payload}`);
    execFileSync('tar',['-czf',path.join(root,'files.tar.gz'),'-C',production,'.']);
    writeFileSync(path.join(root,'database.sql.gz'),gzipSync('fixture database'));
    writeFileSync(path.join(bin,'ssh'),`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const input=fs.readFileSync(0,'utf8');if(input.includes('-czf - .'))process.stdout.write(fs.readFileSync(path.join(process.env.TEST_ROOT,'files.tar.gz')));else if(input.includes('| gzip -c'))process.stdout.write(fs.readFileSync(path.join(process.env.TEST_ROOT,'database.sql.gz')));\n`,{mode:0o755});
    const php=execFileSync('which',['php'],{encoding:'utf8'}).trim();
    writeFileSync(path.join(bin,'ddev'),`#!${process.execPath}
const fs=require('node:fs');const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);const mode=a.includes('-r')?a[a.indexOf('-r')+2]:'';
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({mode,args:a.filter(value=>value.length<150),settings:mode==='replace'?JSON.parse(Buffer.from(a.at(-1),'base64').toString()):null})+'\\n');
if(a[0]==='start'||a[0]==='snapshot'||a.includes('import-db'))process.exit(0);
if(a.includes('wp')||a.some(value=>value.includes('/usr/local/bin/wp-cli')))throw new Error('Imported WordPress bootstrap attempted');
if(mode==='replace'||mode==='preflight')process.exit(0);
if(a.includes('php')){const result=spawnSync(${JSON.stringify(php)},a.slice(a.indexOf('php')+1),{stdio:'inherit'});process.exit(result.status??1);}
throw new Error('Unexpected DDEV command');
`,{mode:0o755});
    const child=spawn(process.execPath,[cli,'pull-wordpress'],{cwd:project,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_ROOT:root,TEST_CALLS:calls,CI:'1',NO_COLOR:'1'},stdio:['pipe','pipe','pipe'],timeout:30000});
    let output='';let error='';let index=0;
    const answers=[['SSH target','example-host'],['Remote WordPress root','/srv/example/httpdocs'],['Live URL','https://example.org'],['Local DDEV URL','https://example.local'],['Save these settings?','n'],['Delete local files that no longer exist on production?','n'],['Continue?','y']];
    child.stdout.on('data',chunk=>{output+=chunk;while(index<answers.length&&output.includes(answers[index][0])){child.stdin.write(answers[index][1]+'\n');index++;}});
    child.stderr.on('data',chunk=>{error+=chunk;});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0,output+error);
    assert.match(output,/Pull complete/);
    assert.equal(existsSync(marker),false);
    assert.doesNotMatch(readFileSync(path.join(project,'wp-config.php'),'utf8'),/application-executed|production/);
    const commands=readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(commands.filter(call=>call.mode).map(call=>call.mode),['config','replace','preflight']);
    for(const call of commands.filter(call=>call.mode||call.args.includes('import-db')))assert.ok(call.args.includes('--skip-hooks'));
    const settings=commands.find(call=>call.mode==='replace').settings;
    const replaced=execFileSync('php',['-r',`$s=json_decode(stream_get_contents(STDIN),true);echo preg_replace($s['pattern'],$s['replacement'],'<p>https://example.org/page</p>{"css":"https://example.org/css"}');`],{input:JSON.stringify(settings),encoding:'utf8'});
    assert.equal(replaced,'<p>https://example.local/page</p>{"css":"https://example.org/css"}');
  } finally {rmSync(root,{recursive:true,force:true});}
});
