// Tiny chiptune synth: square/triangle/noise voices via WebAudio, no assets.
(function () {
  'use strict';

  var ctx = null, master = null, muted = false, unlocked = false;
  var WAVE = {};

  // No AudioContext is created until a real user gesture unlocks it. Creating
  // one at load gets the context suspended and spams autoplay warnings.
  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.18;
    master.connect(ctx.destination);

    // 4-bit-ish pulse waves built from PeriodicWave for a hard 8-bit edge.
    WAVE.p25 = pulse(0.25);
    WAVE.p12 = pulse(0.125);
    return ctx;
  }

  function pulse(duty) {
    var n = 32, real = new Float32Array(n), imag = new Float32Array(n);
    for (var i = 1; i < n; i++) {
      real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  }

  function noiseBuffer(ctx2) {
    var len = Math.floor(ctx2.sampleRate * 1.2);
    var buf = ctx2.createBuffer(1, len, ctx2.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      // Sample-and-hold keeps it crunchy rather than hissy.
      if (i % 3 === 0) last = Math.random() * 2 - 1;
      d[i] = last;
    }
    return buf;
  }

  var NOISE = null;

  // opts: {freq, endFreq, dur, type:'p25'|'p12'|'tri'|'noise', gain, delay, vibrato}
  function blip(opts) {
    if (muted || !unlocked) return;
    var c = ensure();
    if (!c) return;
    if (c.state === 'suspended') c.resume();

    var t0 = c.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.08;
    var g = c.createGain();
    var peak = opts.gain == null ? 0.5 : opts.gain;

    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    g.connect(master);

    var src;
    if (opts.type === 'noise') {
      NOISE = NOISE || noiseBuffer(c);
      src = c.createBufferSource();
      src.buffer = NOISE;
      src.playbackRate.value = opts.rate || 1;
      if (opts.endFreq && opts.freq) src.playbackRate.linearRampToValueAtTime(opts.endFreq / opts.freq, t0 + dur);
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(opts.freq || 900, t0);
      bp.frequency.exponentialRampToValueAtTime(Math.max(80, opts.endFreq || 200), t0 + dur);
      bp.Q.value = opts.q || 1.2;
      src.connect(bp);
      bp.connect(g);
    } else {
      src = c.createOscillator();
      if (opts.type === 'tri') src.type = 'triangle';
      else src.setPeriodicWave(WAVE[opts.type] || WAVE.p25);
      src.frequency.setValueAtTime(opts.freq, t0);
      if (opts.endFreq) src.frequency.exponentialRampToValueAtTime(opts.endFreq, t0 + dur);
      if (opts.vibrato) {
        var lfo = c.createOscillator();
        var lg = c.createGain();
        lfo.frequency.value = opts.vibrato;
        lg.gain.value = opts.freq * 0.06;
        lfo.connect(lg);
        lg.connect(src.frequency);
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.02);
      }
      src.connect(g);
    }

    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  var SFX = {
    shoot: function () { blip({ freq: 880, endFreq: 420, dur: 0.055, type: 'p25', gain: 0.22 }); },
    hit: function () { blip({ freq: 1600, endFreq: 700, dur: 0.03, type: 'noise', gain: 0.2, q: 2 }); },
    kill: function () {
      blip({ freq: 320, endFreq: 90, dur: 0.16, type: 'noise', gain: 0.42, endFreq: 120 });
      blip({ freq: 440, endFreq: 180, dur: 0.1, type: 'p12', gain: 0.16, delay: 0.01 });
    },
    breach: function () {
      blip({ freq: 200, endFreq: 60, dur: 0.3, type: 'noise', gain: 0.6, q: 0.8 });
      blip({ freq: 150, endFreq: 55, dur: 0.24, type: 'p25', gain: 0.3 });
    },
    hurt: function () { blip({ freq: 520, endFreq: 260, dur: 0.07, type: 'p12', gain: 0.14, vibrato: 40 }); },
    wave: function () {
      [523, 659, 784, 1046].forEach(function (f, i) {
        blip({ freq: f, dur: 0.1, type: 'p25', gain: 0.26, delay: i * 0.075 });
      });
    },
    clear: function () {
      [659, 784, 988, 1318, 1568].forEach(function (f, i) {
        blip({ freq: f, dur: 0.14, type: 'p25', gain: 0.24, delay: i * 0.06 });
      });
    },
    over: function () {
      [440, 392, 330, 262, 196].forEach(function (f, i) {
        blip({ freq: f, dur: 0.26, type: 'tri', gain: 0.3, delay: i * 0.13 });
      });
    },
    start: function () { blip({ freq: 660, endFreq: 1320, dur: 0.14, type: 'p12', gain: 0.24 }); },
    ui: function () { blip({ freq: 1200, dur: 0.04, type: 'p12', gain: 0.16 }); },
    pickup: function () {
      blip({ freq: 1320, endFreq: 1760, dur: 0.07, type: 'p12', gain: 0.2 });
    },
    upgrade: function () {
      [784, 988, 1175, 1568].forEach(function (f, i) {
        blip({ freq: f, dur: 0.11, type: 'p25', gain: 0.24, delay: i * 0.055 });
      });
    },
    repair: function () {
      [523, 659, 784].forEach(function (f, i) {
        blip({ freq: f, dur: 0.16, type: 'tri', gain: 0.26, delay: i * 0.07 });
      });
    },
    tokenLost: function () {
      blip({ freq: 420, endFreq: 240, dur: 0.1, type: 'p12', gain: 0.1 });
    },
    charge: function () { blip({ freq: 220, endFreq: 880, dur: 0.4, type: 'p12', gain: 0.2, vibrato: 18 }); },
    bomb: function () {
      blip({ freq: 700, endFreq: 90, dur: 0.5, type: 'noise', gain: 0.6, q: 0.6 });
      blip({ freq: 180, endFreq: 60, dur: 0.42, type: 'tri', gain: 0.35 });
    }
  };

  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.value = muted ? 0 : 0.18;
  }

  function unlock() {
    unlocked = true;
    var c = ensure();
    if (c && c.state === 'suspended') c.resume();
  }

  window.Sound = {
    sfx: SFX,
    setMuted: setMuted,
    isMuted: function () { return muted; },
    isUnlocked: function () { return unlocked; },
    toggleMute: function () { setMuted(!muted); return muted; },
    unlock: unlock
  };
})();
