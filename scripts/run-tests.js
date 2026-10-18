// Runs the compiled test suite. Passing a directory to `node --test` is not
// portable: Node 22 treats it as a module path and fails with MODULE_NOT_FOUND,
// while newer versions accept it. Enumerate the compiled test files and pass
// them explicitly so `npm test` behaves the same on every supported Node.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'dist', 'tests');
const files = fs.existsSync(dir)
  ? fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => path.join(dir, name))
  : [];

if (files.length === 0) {
  console.error(`No compiled tests found in ${dir}. Run "npm run build" first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
