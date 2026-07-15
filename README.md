# 𝐋𝐨𝐨𝐦 — a visual novel engine with a compiler's brain

[![CI](https://github.com/Simzy3334/Loom/actions/workflows/ci.yml/badge.svg)](https://github.com/Simzy3334/Loom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Write your story in a five-minute script language. Loom **statically verifies the entire branching graph before anyone plays a frame** — broken jumps, unreachable scenes, flags read-but-never-set, choice dead-ends, endings nobody can reach — then simulates **every possible playthrough** in milliseconds and ships the game as a static website.

Ren'Py finds a missing label when the game boots. Loom finds the ending your last edit silently made unreachable — in CI, before you push.

```
 story/demo.loom ──► parser ──► story graph ──► linter        (9 static rules)
                                     │──────► simulator      (every playthrough)
                                     └──────► web runtime    (React, 53 KB gz)
```

## The script language

```loom
title "Transfer Student"
char rei "Rei Ayame" #d98a6a

:: intro
@bg classroom
@show rei neutral
Spring. A new city, a new school.
rei: You're the transfer student, right?
rei (grinning): Everyone gets lost on day one.
$ trust = 0
* "That's... comforting?" -> banter
    $ trust += 1
* "Sorry — I can move." -> polite

:: rooftop
@if trust >= 3 -> rei_end
-> quiet_end

:: rei_end
@ending "Rooftop Promise"
```

Scenes (`::`), dialogue (`name: text`, with `(expression)` sprite changes), narration (plain prose), state (`$ var += 1`), conditional choices (`* {trust >= 2} "..." -> scene`), conditional jumps (`@if`), and `@ending`. Diffs read like the story changed, not the code — writers can own the file.

## What the compiler catches (that Ren'Py can't)

```
$ npm run lint-story

  error   demo.loom:41  "lunch" jumps to "luch", which doesn't exist        [broken-jump]
  error   demo.loom:12  "affection" is read but never set — silently 0     [unset-variable]
  warning demo.loom:58  scene "secret_route" can never be reached          [unreachable-scene]
  warning demo.loom:23  every choice here is condition-locked              [lockable-choice]
```

Nine rules: broken jumps · unreachable scenes · unset variables · unused variables · fall-through scenes · lockable choice groups · undeclared speakers · dialogue-looking narration (the typo'd-name trap) · no reachable ending.

## The simulator: your story, exhaustively played

```
$ npm run explore

  states explored : 43
  scene coverage  : 100% (10/10)
  endings found   : 3

  ◆ Rooftop Promise     via: That's... comforting?  →  Follow Rei to the roof
  ◆ Found Your People   via: Sorry — I can move.    →  Go with Kaito to chess club
  ◆ A Slow Beginning    via: Sorry — I can move.    →  Follow Rei to the roof
```

`explore()` drives the **real interpreter** through every reachable choice combination (memoised on scene + variables), reporting endings with example paths, scene coverage, and stuck states. The test suite includes a regression guard that mutates a flag threshold and asserts the simulator notices the lost ending — that's a story bug caught by CI.

## Saves that survive updates

Ren'Py pickles live execution state; edit a released script and old saves break mysteriously. Loom saves are explicit data — `(story version, scene, index, vars, visuals)` — validated on load and **migrated forward** through registered per-version transforms:

```ts
deserialize(story, file, {
  1: (save) => ({ ...save, vars: { trust_rei: save.vars.old_trust } }), // v1 → v2
});
```

A save pointing at a deleted scene fails loudly *at load time* with instructions, not as a mystery crash mid-play.

## The runtime

Pure-function interpreter (`next(story, state) → { state, view }` — no IO, no globals, which is exactly why the simulator can drive it), wrapped in a React UI kit: title screen, typewriter text with skip-on-click, per-character nameplates and expression-aware sprite cards, choice menus, backlog, six save slots, rollback (Backspace), text-speed settings, painted-gradient scenes so the demo ships with **zero binary assets**. Dusk-ink & cream design, serif prose — a page, not a widget.

Deploying a game is `npm run build` → 53 KB gzipped static site → GitHub Pages. It runs on any phone.

## Quickstart

```bash
git clone https://github.com/Simzy3334/Loom.git && cd loom
npm install

npm run dev          # play the demo with hot reload
npm test             # 33 engine tests
npm run lint-story   # static analysis of story/demo.loom
npm run explore      # exhaustive playthrough simulation
npm run build        # ship it
```

Write your own game by editing `story/demo.loom` — the dev server hot-reloads on save, and the linter tells you the moment you break the graph.

## Project structure

```
loom/
├── engine/              # pure TypeScript, no DOM — fully unit-tested
│   ├── parser.ts        # .loom → story AST (line-based, writer-friendly)
│   ├── linter.ts        # 9 static rules over the story graph
│   ├── interpreter.ts   # expression evaluator + pure state machine
│   ├── simulator.ts     # exhaustive branch exploration, memoised
│   └── saves.ts         # versioned saves + migrations + validation
├── runtime/             # React UI kit (Game.tsx + styles)
├── story/demo.loom      # "Transfer Student" — 10 scenes, 3 endings
├── cli.ts               # lint / explore commands for CI
└── tests/               # 33 vitest tests incl. story-regression guard
```

## Design decisions worth asking me about

- **Why is the interpreter pure?** `next()` takes state, returns state — no clocks, no IO, no globals. That one decision buys the simulator (drive it programmatically), trivial saves (state *is* the save), free rollback (keep old states), and deterministic tests.
- **Why memoise the simulator on the *input* state?** Keying the output collided "arriving at a choice" with "presenting the choice" — a bug the demo exposed and the fix documents. Identical `(scene, index, vars)` have identical futures; the backlog doesn't affect reachability, so it's excluded from the key.
- **Why does unknown-speaker dialogue parse as narration, then get linted?** A hard parse error would make every colon in prose ambiguous. Instead the parser is charitable and the linter flags prose shaped like `name: text` from an undeclared name — catching the typo without breaking legitimate sentences.
- **Why line-based instead of a "real" grammar?** Writers diff, merge, and hand-edit these files. A line-oriented format means git conflicts stay human-sized and one bad line can't cascade into fifty parse errors.

## Roadmap

- [ ] Story-graph visualizer (scenes as nodes, endings highlighted)
- [ ] Hot reload with state preservation (stay on your line while editing)
- [ ] Localization: extract dialogue to per-language files keyed by scene+index
- [ ] Asset pipeline: real backgrounds/sprites/audio keyed by the same names
- [ ] VS Code extension: syntax highlighting + inline lint squiggles

## License

MIT
