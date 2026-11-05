# AGENTS.md

Working rules for this repository. Read before changing anything.

`README.md` says *what* the game is. This file records the constraints that keep
it working. Several are counter-intuitive and are exactly what a well-meaning
change would break while still passing its own tests.

---

## Where this project lives

**Canonical remote: `github.com/altpersona/breach`.** That is the only correct
place for this project.

This machine can reach more than one Git host (two GitHub identities and a Gitea
instance). Do not push this repository anywhere else, and do not add a second
remote. If a push fails, fix credentials — do not "solve" it by pushing elsewhere.

- Play: `altpersona.github.io/breach/`
- Brand: **Standardvibeware** (`standardvibeware.click`), shown on the title
  screen. Keep that attribution.

---

## Versioning and releases (hard rules)

**Every code revision gets a standardised version bump. Every version bump gets a
matching GitHub release.** There are no exceptions and no "small change, skip it".

### Semver

`MAJOR.MINOR.PATCH`:

- **MAJOR** — a change that makes old runs/strategies invalid, or a design reset.
- **MINOR** — new player-facing capability (a weapon, an enemy, a control scheme).
- **PATCH** — fixes, tuning, refactors, tests, docs. Anything not adding capability.

While the game is pre-2.0, breaking *internals* is not a major bump; reserve it for
a change a player would have to relearn.

### The number lives in three places

1. `package.json` → `version` — **source of truth**, used for tagging.
2. `VERSION` in `src/game.js` — what a player sees on the title screen.
3. `README.md` → "Version" section and a `## Changelog` entry.

`test/version.js` fails the build if (1) and (2) disagree, or if the README omits
the current version. It is part of `npm run verify`, so drift cannot ship.

### Release procedure

```sh
# 1. bump all three places, add a changelog entry
npm run verify                 # must pass, including test/version.js
git add -A && git commit -m "Release vX.Y.Z: <summary>"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin master --follow-tags

# 2. the release must match the tag
gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag
```

Release notes summarise *player-visible* change, not a commit dump. If a release
adds a mechanic, say what it changes about how the game plays.

Verify afterwards:

```sh
git ls-remote --tags origin     # tag exists on the remote
gh release list                 # release exists
npm run test:live               # the deployed build actually runs
```

---

## Verify with the suites, not with reasoning

```sh
npm run verify
```

Syntax, 77 unit tests, version consistency, 31 browser tests, layout, audio. A
change is not done until this passes. Change behaviour → change or add a test in
the same commit.

Other probes, run when relevant:

```sh
npm run test:balance   # bot survival per wave
npm run test:live      # boots the PUBLISHED build from its real URL
npm run test:run       # continuous runs to game over
```

---

## Invariants

Each is load-bearing and was arrived at by measurement. They look like arbitrary
tuning numbers. They are not.

### `MAX_FIRING = 1` is not a difficulty knob

The arena is one-dimensional: the player blocks exactly one spoke. Two ships firing
from two different spokes is *mathematically* unwinnable, however well played.
Raising this cap makes the game impossible before it makes it harder.
`DUAL_FIRE_WAVE` (13) relaxes it to two shooters deliberately, when both rounds
are visible long enough to answer in sequence.

### Bullets must be slower than the player can circle

Enemy rounds cross the annulus at ~42 px/s — slower than the player's angular speed
covers the arc. **That reaction window is the entire game.** Speeding bullets up to
"feel snappier" deletes the core skill. A test asserts the relationship; if it
fails after your change, it is correct to fail.

### Hull capacity must stay ≥ one ring arc

`PLAYER_CAPACITY` (3) is deliberately larger than `SEG_CAPACITY` (2). The ring has
14 arcs to spread damage across; the ship is one thing. At parity, measurement
showed the ship caused *every* death (12/12 runs) and the ring — the subject of the
game — never mattered.

### Beams damage the ship

A beam is a *pulsed* lane (1.35s), not a permanent field, and it hurts the ship as
well as the ring. Do not make it non-damaging as a difficulty "fix": that was
tried, it made the most lethal thing on the field harmless, and it hid a tuning
problem instead of solving it. Fairness comes from the sweep being outrunnable.

### There is no repair drop

Ring repair is a **timed self-heal**: an arc left undamaged for `SEG_HEAL_TIME`
(22s) mends one point, once per quiet stretch. Deliberate, not unfinished. Do not
add a repair pickup. The long wait is the point.

### Navigation is left/right only

No mouse steering; it was added once and removed twice, because cursor-following
makes precision play mushy in a one-dimensional arena. Touch mirrors the same
scheme (hold a screen half to rotate, both to focus). Any new input must be
additive to left/right — never introduce a second analogue notion of position.

### Losing is watchable

A ring breach and losing the ship both enter a `dying` playout (`PLAYOUT_TIME`,
2.6s) where the battle keeps resolving before the summary. Do not collapse this
back to an instant menu.

**Test consequence:** loss is never `state === 'gameover'` immediately. Any loop or
assertion about failure must account for `'dying'`. Two probe bugs in this repo's
history came from missing exactly this, and both silently reported "0 deaths".

---

## Test conventions

- **The bot lives in `test/bot.js`.** Every probe uses it; do not copy it into a
  new file. Copies drifted once already and made the numbers incomparable.
- Read constants from `CS.consts` in tests, never hardcode them — a hardcoded
  `SEG_CAPACITY` silently stops testing the real rule.
- The bot flies into enemies and has no self-preservation, so its depth is a
  **floor**, not a difficulty forecast. A human improves between runs; the bot
  cannot represent that.
- When measuring "did this wave go well", distinguish **cleared**, **died** and
  **timed out**. Conflating them hides stalemates as ordinary difficulty.

---

## Style

- `src/game.js` is the whole game. Keep it dependency-free and openable from
  `file://` — no build step, no bundler, no imports.
- Plain ES5-style `var` and function declarations inside the IIFE. Deliberate: the
  file ships unbundled to browsers and the style is consistent.
- Comments explain **why**, not what. Do not narrate code, and do not record a
  development diary in comments — describe the code as it stands.
- Pixel art is string tables (`PLAYER_ART`, `ENEMY_ART`, `TOKEN_ART`).
  Draw at integer scales only; fractional scaling destroys the look.
- Don't gold-plate. A working fix now beats a perfect one later.

---

## After pushing

Run `npm run test:live`. A repo serving three separate script files can return 200
on `index.html` and still be completely broken; only the live check catches that.

Also confirm the deployed payload matches local, rather than trusting a green push:

```sh
sha256sum src/game.js
curl -sS https://altpersona.github.io/breach/src/game.js | sha256sum
```
