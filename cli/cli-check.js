// Packs the CLI, installs the tarball into a temporary project and runs it from there.
// Run: npm run test:cli   (after `npm run build:cli`)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const npm = (args, cwd) => spawnSync(`npm ${args.join(' ')}`, { cwd, encoding: 'utf8', shell: true });
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `npm-guard-cli-${n}-`));

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
assert.strictEqual(pkg.dependencies, undefined, 'no runtime dependency');
assert.strictEqual(pkg.scripts, undefined, 'no install script: installing the package changes nothing');
assert.notStrictEqual(pkg.private, true, 'public: npm refuses to publish a private package');
assert.strictEqual(pkg.name, '@meetroj/npm-guard', 'scoped: the plain name is too close to an existing package');
assert.ok(pkg.bin['npm-guard']);

const out = tmp('pack');
const packed = npm(['pack', '--pack-destination', `"${out}"`, '--json'], __dirname);
assert.strictEqual(packed.status, 0, packed.stderr);
const info = JSON.parse(packed.stdout)[0];
const files = info.files.map((f) => f.path).sort();
assert.deepStrictEqual(files, ['README.md', 'dist/cli.js', 'dist/core.js', 'dist/install.js', 'package.json']);

const proj = tmp('proj');
fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"t","version":"1.0.0"}');
const added = npm(['install', '--offline', '--no-audit', '--no-fund', `"${path.join(out, info.filename)}"`], proj);
assert.strictEqual(added.status, 0, added.stderr);
const bin = path.join(proj, 'node_modules', '.bin', process.platform === 'win32' ? 'npm-guard.cmd' : 'npm-guard');
assert.ok(fs.existsSync(bin), 'the npm-guard command is linked');

const clean = tmp('clean');
fs.writeFileSync(path.join(clean, 'ok.js'), 'console.log(1);\n');
const cli = path.join(proj, 'node_modules', '@meetroj', 'npm-guard', 'dist', 'cli.js');
const scan = spawnSync(process.execPath, [cli, 'scan', clean], { encoding: 'utf8' });
assert.strictEqual(scan.status, 0);
assert.ok(scan.stdout.includes('No threats detected by the current rules.'));

console.log('npm-guard cli package: all checks passed');
