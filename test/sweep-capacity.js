// Sweeps a tuning constant and reports how the game behaves at each value, so
// balance decisions are measured rather than picked. Temporarily rewrites the
// constant in src/game.js and always restores the file afterwards.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'game.js');
const ORIGINAL = fs.readFileSync(FILE, 'utf8');

function restore() {
  fs.writeFileSync(FILE, ORIGINAL);
}

function withConstant(pattern, value, fn) {
  // A function replacer keeps the capture (the declaration's leading text) and
  // avoids "$1" being interpreted as a special string pattern.
  const patched = ORIGINAL.replace(pattern, (m, prefix) => prefix + value);
  if (patched === ORIGINAL && !pattern.test(ORIGINAL)) {
    throw new Error('constant not found: ' + pattern);
  }
  fs.writeFileSync(FILE, patched);
  try {
    return fn();
  } finally {
    restore();
  }
}

function probe(runs) {
  // Re-read the patched source.
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.sep + 'test' + path.sep)) delete require.cache[k];
  }
  const { boot } = require('./harness');
  const { playRun } = require('./bot');

  const depths = [];
  const byShip = { ship: 0, ring: 0 };
  for (let i = 0; i < runs; i++) {
    const env = boot({ search: '?selftest=1' });
    const CS = env.CS;
    CS.newGame();
    const r = playRun(env, CS, { maxSeconds: 480 });
    depths.push(r.wave);
    byShip[r.byShip ? 'ship' : 'ring']++;
  }
  return {
    avg: depths.reduce((a, b) => a + b, 0) / depths.length,
    max: Math.max(...depths),
    byShip
  };
}

// Each entry: [label, patch-pattern, replacement, runs]
// Match just the number so trailing comments survive the patch.
const CANDS = [
  ['SEG_CAPACITY 2', /(var SEG_CAPACITY = )\d+/, '2'],
  ['SEG_CAPACITY 3', /(var SEG_CAPACITY = )\d+/, '3'],
  ['PLAYER_CAPACITY 2', /(var PLAYER_CAPACITY = )\d+/, '2'],
  ['PLAYER_CAPACITY 3', /(var PLAYER_CAPACITY = )\d+/, '3'],
  ['PLAYER_CAPACITY 4', /(var PLAYER_CAPACITY = )\d+/, '4'],
  ['SEG_HEAL_TIME 14', /(var SEG_HEAL_TIME = )\d+/, '14'],
  ['SEG_HEAL_TIME 22', /(var SEG_HEAL_TIME = )\d+/, '22']
];

const RUNS = Number(process.argv[2] || 4);

console.log('\n=== tuning sweep (' + RUNS + ' runs each) ===\n');
console.log('variant                | avg wave | max | ship deaths | ring deaths');
console.log('-----------------------|----------|-----|-------------|------------');

const results = [];
try {
  for (const [label, pattern, replacement] of CANDS) {
    const r = withConstant(pattern, replacement, () => probe(RUNS));
    results.push({ label, ...r });
    console.log(
      label.padEnd(22) + ' | ' + r.avg.toFixed(1).padStart(8) + ' | ' +
      String(r.max).padStart(3) + ' | ' + String(r.byShip.ship).padStart(11) +
      ' | ' + String(r.byShip.ring).padStart(11)
    );
  }
} finally {
  restore();
}

console.log('\nsource restored:', fs.readFileSync(FILE, 'utf8') === ORIGINAL);
