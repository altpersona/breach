// Headless harness: stubs just enough DOM/canvas to load the game in Node.
// Used by test/spec.js — not shipped to players.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeCtx2d() {
  const calls = { fillRect: 0, stroke: 0, fill: 0, arc: 0, moveTo: 0, lineTo: 0 };
  const ctx = {
    canvas: null,
    _calls: calls,
    // state that game code reads back
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    imageSmoothingEnabled: false,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, clip() {},
    moveTo() { calls.moveTo++; },
    lineTo() { calls.lineTo++; },
    arc() { calls.arc++; },
    fill() { calls.fill++; },
    stroke() { calls.stroke++; },
    fillRect(x, y, w, h) {
      calls.fillRect++;
      if (![x, y, w, h].every(Number.isFinite)) {
        throw new Error(`fillRect got non-finite args: ${x},${y},${w},${h}`);
      }
    },
    strokeRect() {},
    clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    measureText() { return { width: 0 }; },
    setTransform() {}, resetTransform() {},
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
    putImageData() {}
  };
  return ctx;
}

function makeElement(tag) {
  const el = {
    tagName: tag,
    width: 320,
    height: 320,
    style: {},
    listeners: {},
    clientWidth: 320,
    clientHeight: 320,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 320, right: 320, bottom: 320 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    getContext() { return this._ctx || (this._ctx = makeCtx2d()); },
    appendChild() {},
    querySelector() { return null; }
  };
  return el;
}

function makeWindow(search) {
  const listeners = {};
  const win = {
    innerWidth: 1280,
    innerHeight: 900,
    devicePixelRatio: 1,
    _listeners: listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    setTimeout: (fn) => 0,
    clearTimeout() {},
    location: { search: search || '' },
    navigator: { userAgent: 'node' },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k)
      };
    })()
  };
  win.window = win;
  win.self = win;
  return win;
}

function boot(opts) {
  opts = opts || {};
  const win = makeWindow(opts.search);
  const canvas = makeElement('canvas');
  const frame = makeElement('div');

  const doc = {
    getElementById(id) { return id === 'cv' ? canvas : frame; },
    createElement: makeElement,
    querySelector() { return null; },
    addEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html')
  };

  win.document = doc;
  win.AudioContext = undefined; // silence: Sound.ensure() bails out
  win.webkitAudioContext = undefined;
  win.URLSearchParams = URLSearchParams;

  const sandbox = {
    document: doc,
    location: win.location,
    navigator: win.navigator,
    localStorage: win.localStorage,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    console,
    Math,
    Date,
    URLSearchParams,
    performance: { now: () => Date.now() }
  };
  // In a browser the global object IS window, so `window.Foo = x` defines the
  // bare global `Foo`. Mirror that here or scripts silently lose their globals.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = win.innerWidth;
  sandbox.innerHeight = win.innerHeight;

  vm.createContext(sandbox);
  // Hoist the listener localStorage/win hooks so the game's EventTarget calls work.
  sandbox.localStorage = win.localStorage;
  sandbox.addEventListener = win.addEventListener.bind(win);

  win.addEventListener = sandbox.addEventListener;

  for (const file of ['src/font.js', 'src/audio.js', 'src/game.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }

  const dispatch = (type, ev) => {
    const ls = (win._listeners || {})[type] || [];
    for (const fn of ls) fn(ev);
  };

  // Synthetic key events need the same surface a real KeyboardEvent has.
  const key = (type, k) => dispatch(type, { key: k, preventDefault() {}, stopPropagation() {} });

  return { win, sandbox, canvas, doc, CS: sandbox.CS, dispatch, key };
}

module.exports = { boot, makeCtx2d };
