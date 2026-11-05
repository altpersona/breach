// Version consistency. Releases are tagged from package.json, but the string a
// player sees is the in-game constant — so these two must never drift, or a
// release would be labelled with a version nobody is running.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./harness');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const gameVersion = boot({ search: '?selftest=1' }).CS.version;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + '  -> ' + e.message);
    failures++;
  }
}

console.log('\n=== version consistency (package.json ' + pkg.version + ') ===\n');

check('package.json declares a semver version', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version),
    'expected MAJOR.MINOR.PATCH, got "' + pkg.version + '"');
});

check('the in-game version matches package.json', () => {
  assert.strictEqual(gameVersion, pkg.version,
    'src/game.js says ' + gameVersion + ' but package.json says ' + pkg.version);
});

check('README states the current version', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(pkg.version),
    'README.md does not mention ' + pkg.version);
});

check('every release tag matches a declared version format', () => {
  // Tags are created outside this script; if any exist they must be vX.Y.Z.
  const tags = process.env.BREACH_TAGS;
  if (tags === undefined) {
    console.log('       (skipped: BREACH_TAGS not provided, tag check needs git)');
    return;
  }
  for (const t of tags.split(/\s+/).filter(Boolean)) {
    assert.ok(/^v\d+\.\d+\.\d+$/.test(t), 'tag "' + t + '" is not vMAJOR.MINOR.PATCH');
  }
});

console.log('');
if (failures) {
  console.log(failures + ' FAILED\n');
  process.exit(1);
}
console.log('version is consistent: ' + pkg.version + '\n');
