// Copies the compiled guard (out/npm-guard/{cli,core,install}.js) into cli/dist/, the only files the
// package ships. Run `npm run compile` first; `npm run build:cli` does both.
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'out', 'npm-guard');
const to = path.join(__dirname, 'dist');
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of ['cli.js', 'core.js', 'install.js']) {
  const src = path.join(from, f);
  if (!fs.existsSync(src)) throw new Error(`${src} is missing: run "npm run compile" first`);
  fs.copyFileSync(src, path.join(to, f));
}
console.log('npm-guard cli built in', to);
