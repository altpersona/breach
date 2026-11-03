// 5x7 bitmap font. Rows are 5-bit values packed as 2-digit hex, top row first.
(function () {
  'use strict';

  var SRC = {
    ' ': '00,00,00,00,00,00,00',
    A: '0E,11,11,1F,11,11,11',
    B: '1E,11,11,1E,11,11,1E',
    C: '0F,10,10,10,10,10,0F',
    D: '1E,11,11,11,11,11,1E',
    E: '1F,10,10,1E,10,10,1F',
    F: '1F,10,10,1E,10,10,10',
    G: '0F,10,10,17,11,11,0F',
    H: '11,11,11,1F,11,11,11',
    I: '0E,04,04,04,04,04,0E',
    J: '07,02,02,02,02,12,0C',
    K: '11,12,14,18,14,12,11',
    L: '10,10,10,10,10,10,1F',
    M: '11,1B,15,15,11,11,11',
    N: '11,19,15,13,11,11,11',
    O: '0E,11,11,11,11,11,0E',
    P: '1E,11,11,1E,10,10,10',
    Q: '0E,11,11,11,15,12,0D',
    R: '1E,11,11,1E,14,12,11',
    S: '0F,10,10,0E,01,01,1E',
    T: '1F,04,04,04,04,04,04',
    U: '11,11,11,11,11,11,0E',
    V: '11,11,11,11,11,0A,04',
    W: '11,11,11,15,15,1B,11',
    X: '11,11,0A,04,0A,11,11',
    Y: '11,11,0A,04,04,04,04',
    Z: '1F,01,02,04,08,10,1F',
    '0': '0E,11,13,15,19,11,0E',
    '1': '04,0C,04,04,04,04,0E',
    '2': '0E,11,01,02,04,08,1F',
    '3': '1F,02,04,02,01,11,0E',
    '4': '02,06,0A,12,1F,02,02',
    '5': '1F,10,1E,01,01,11,0E',
    '6': '06,08,10,1E,11,11,0E',
    '7': '1F,01,02,04,08,08,08',
    '8': '0E,11,11,0E,11,11,0E',
    '9': '0E,11,11,0F,01,02,0C',
    '.': '00,00,00,00,00,00,04',
    ',': '00,00,00,00,04,04,08',
    ':': '00,04,00,00,00,04,00',
    '!': '04,04,04,04,04,00,04',
    '?': '0E,11,01,02,04,00,04',
    '-': '00,00,00,0E,00,00,00',
    '+': '00,04,04,1F,04,04,00',
    '/': '01,01,02,04,08,10,10',
    '(': '02,04,08,08,08,04,02',
    ')': '08,04,02,02,02,04,08',
    "'": '04,04,00,00,00,00,00',
    '*': '00,0A,04,1F,04,0A,00',
    '%': '11,12,02,04,08,09,11',
    '<': '02,04,08,10,08,04,02',
    '>': '08,04,02,01,02,04,08',
    '=': '00,00,1F,00,1F,00,00',
    'x': '00,00,11,0A,04,0A,11',
    '_': '00,00,00,00,00,00,1F'
  };

  var FONT = {};
  for (var k in SRC) {
    if (!Object.prototype.hasOwnProperty.call(SRC, k)) continue;
    FONT[k] = SRC[k].split(',').map(function (h) { return parseInt(h, 16); });
  }

  var CW = 5, CH = 7, GAP = 1;

  function rowsFor(ch) {
    return FONT[ch] || FONT[ch.toUpperCase()] || FONT['?'];
  }

  function width(str, scale) {
    scale = scale || 1;
    if (!str || !str.length) return 0;
    return (str.length * (CW + GAP) - GAP) * scale;
  }

  // opts: {scale, color, align: 'left'|'center'|'right', shadow: color, alpha}
  function draw(ctx, str, x, y, opts) {
    opts = opts || {};
    var scale = opts.scale || 1;
    var color = opts.color || '#ffffff';
    var align = opts.align || 'left';
    str = String(str).toUpperCase();

    var w = width(str, scale);
    var ox = x;
    if (align === 'center') ox = Math.round(x - w / 2);
    else if (align === 'right') ox = Math.round(x - w);

    if (opts.shadow) {
      paint(ctx, str, ox + scale, y + scale, scale, opts.shadow);
    }
    paint(ctx, str, ox, y, scale, color);
    return w;
  }

  function paint(ctx, str, ox, oy, scale, color) {
    ctx.fillStyle = color;
    for (var i = 0; i < str.length; i++) {
      var rows = rowsFor(str[i]);
      var gx = ox + i * (CW + GAP) * scale;
      for (var r = 0; r < CH; r++) {
        var bits = rows[r];
        if (!bits) continue;
        var run = -1;
        for (var c = 0; c <= CW; c++) {
          var on = c < CW && (bits & (1 << (CW - 1 - c)));
          if (on && run < 0) run = c;
          if (!on && run >= 0) {
            ctx.fillRect(gx + run * scale, oy + r * scale, (c - run) * scale, scale);
            run = -1;
          }
        }
      }
    }
  }

  window.Pixel = { draw: draw, width: width, height: function (s) { return CH * (s || 1); } };
})();
