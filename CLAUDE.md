# CLAUDE.md

Guidance for Claude Code when working in this repository. See [README.md](README.md) for the full project pitch and script-language reference — this file only covers what the README doesn't.

## Commands

```bash
npm test             # vitest, engine/ unit tests (parser, linter, interpreter, saves, simulator)
npm run lint-story    # static analysis of story/demo.loom — must pass with zero errors
npm run explore        # exhaustive playthrough simulation over story/demo.loom
npm run dev             # Vite dev server for the React runtime
npm run build           # tsc typecheck + Vite production build
npx tsc --noEmit        # typecheck only, no build output
```

CI (`.github/workflows/ci.yml`) runs all of the above in sequence on every push/PR. A change that breaks any one of them will fail CI, not just tests.

## Architecture

- `engine/` is pure TypeScript with no DOM dependency — parser → linter/simulator → interpreter. Every function here should stay side-effect-free; the simulator's ability to exhaustively explore the story graph depends on `next(story, state) → { state, view }` being a pure function with no IO or globals. Don't add mutation, timers, or DOM access to anything under `engine/`.
- `runtime/` is the React UI (`Game.tsx` + `styles.css`) that consumes the engine. All game logic belongs in `engine/`, not here — `Game.tsx` should only manage UI state (overlays, typewriter animation, settings) and localStorage persistence (saves, settings).
- `story/demo.loom` is the sample script in Loom's line-based `.loom` format. When editing it, run `npm run lint-story` before considering the change done — the linter is the safety net that replaces manual playtesting for broken jumps/unreachable scenes/unset variables.
- `cli.ts` wires the lint/explore commands used by both `npm run lint-story`/`explore` and CI.

## Conventions

- No inline comments unless they explain a non-obvious *why*, not the *what* — the existing code follows this; match it.
- The `.loom` format is intentionally line-oriented so writers can diff/merge it by hand. Don't propose migrating it to a "real" grammar (YAML, JSON, etc.) — that tradeoff is deliberate (see README § Design decisions).
- Saves are versioned explicit data (`serialize`/`deserialize` in `engine/saves.ts`), not serialized live state. Any change to `GameState` shape needs a migration entry, not a silent break.
- When adding a new static rule to `engine/linter.ts`, add a corresponding case to `story/demo.loom`'s test fixtures and a regression test in `tests/engine.test.ts`, following the existing pattern (see the simulator regression guard that mutates a flag threshold and asserts an ending becomes unreachable).
