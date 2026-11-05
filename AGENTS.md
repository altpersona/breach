# AGENTS.md

Working rules for this repository. Read this before changing `src/game.js`.

`README.md` explains *what* the game is. This file records the constraints that
make it work, because several of them are counter-intuitive and are the exact
things a well-meaning change would break while still passing its own tests.

---

## The two rules that matter most

**1. Verify with the suites, not with reasoning.**

```sh
npm run verify     # syntax + 77 unit tests + 31 browser tests + layout + audio
```

A change is not done until this passes. If you change behaviour, change or add a
test in the same commit — the suites are the only thing standing between this
design and silent erosion. There is also `npm run test:balance` (bot survival per
wave) and `npm run test:live` (boots the *published* build from its real URL).

**2. Do not "improve" the invariants below without reading why they exist.**

Each one is a load-bearing design decision that was arrived at by measurement.
Most of them look like arbitrary tuning numbers. They are not.

---

## Invariants

### `MAX_FIRING = 1` — not a difficulty knob

The arena is one-dimensional: the player blocks exactly one spoke. Two ships
firing from two different spokes is therefore *mathematically* unwinnable, however
well it is played. This cap is what keeps the game fair, and raising it makes
the game impossible long before it makes it harder.

`DUAL_FIRE_WAVE` (13) relaxes it to two shooters deliberately — late-game, when
both rounds are visible for seconds and can be answered in sequence.

### Bullets must be slower than the player can circle

Enemy rounds cross the annulus at ~42 px/s. That is deliberately slower than the
player's angular speed can cover the arc. **That reaction window is the entire
game** — it is what makes a chase winnable. Speeding up bullets to "feel snappier"
deletes the core skill. `test/spec.js` asserts this relationship; if you change
bullet speed, expect that test to fail, and it is correct to fail.

### Hull capacity must stay ≥ one ring arc

`PLAYER_CAPACITY` (3) is deliberately larger than `SEG_CAPACITY` (2). The ring has
14 arcs and can spread damage; the ship is one thing. At parity, measurement
showed the ship caused *every* death (12/12 runs) and the ring — the thing the
game is about — never mattered. The hull is also the only reason ramming costs
anything.

### Beams damage the ship

A beam is a *pulsed* lane (1.35 s), not a permanent field, and it hurts the ship
as well as the ring. It must not be made non-damaging as a "fix" for difficulty:
that was tried, it made the most lethal thing on the field harmless, and it hid
a tuning problem instead of solving it. Fairness comes from the sweep being slow
enough to outrun.

### There is no repair drop

Ring repair is a **timed self-heal**: an arc left undamaged for `SEG_HEAL_TIME`
(22 s) mends one point, once per quiet stretch. This is a deliberate design, not
an unfinished feature. Do not add a PATCH/repair pickup. The long wait is the
point — it rewards leaving a damaged arc alone rather than hoping for luck.

### Navigation is left/right only

No mouse steering, no free 2-D movement. It was added once and removed twice
because the arena is one-dimensional and cursor-following makes precision play
mushy. Touch mirrors the same scheme: hold a screen half to rotate, both halves
to focus. Keep any new input additive to left/right; do not introduce a second
analogue notion of position.

### Losing is watchable

Both a ring breach and losing the ship enter a `dying` playout (`PLAYOUT_TIME`,
2.6 s) where the battle keeps resolving before the summary appears. Do not
collapse this back to an instant menu.

**Consequence for tests:** loss is never `state === 'gameover'` immediately. Any
loop or assertion about failure must account for `'dying'`. Two probe bugs in
this repo's history came from missing exactly this, and both silently reported
"0 deaths".

---

## Test conventions

- **The bot lives in `test/bot.js`.** Every probe uses it. Do not copy it into a
  new file — the copies had already drifted once, which made their numbers
  incomparable.
- Read tuning constants from `CS.consts` in tests, never hardcode them. A test
  that hardcodes `SEG_CAPACITY` will silently stop testing the real rule.
- The bot flies into enemies and has no self-preservation, so its depth is a
  **floor**, not a difficulty forecast. A human improves between runs; the bot
  cannot.
- When a probe measures "did this wave go well", distinguish **cleared**, **died**
  and **timed out**. Conflating them hides stalemates as ordinary difficulty.

---

## Style

- `src/game.js` is the whole game. Keep it dependency-free and openable from
  `file://` — no build step, no bundler, no imports.
- Plain ES5-style `var` and function declarations inside the IIFE. This is
  deliberate: the file ships unbundled to browsers, and the style is consistent.
- Comments explain **why**, not what. Do not narrate the code, and do not record
  a development diary in comments — describe the code as it stands.
- Pixel art is built from string tables (`PLAYER_ART`, `ENEMY_ART`, `TOKEN_ART`).
  Draw at integer scales only; fractional scaling destroys the look.

---

## Publishing

- Repo: `github.com/altpersona/breach`, Pages at `altpersona.github.io/breach/`.
- Brand: **Standardvibeware** (`standardvibeware.click`). Attribution lives on the
  title screen; keep it there.
- After pushing, `npm run test:live` — a repo serving three separate script files
  can return 200 on `index.html` and still be completely broken. Only the live
  check catches that.
