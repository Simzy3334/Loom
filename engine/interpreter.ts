/**
 * The interpreter: a pure state machine.
 *
 * `begin(story)` gives the initial state; `next(story, state)` executes steps
 * until something the player must see (dialogue, narration, choices, ending)
 * and returns the new state plus a View. `choose(story, state, i)` applies a
 * choice. No IO, no globals, no clocks - which is exactly why the simulator
 * can drive thousands of playthroughs through it and why saves are trivial.
 */

import type { GameState, Story, Vars, View } from "./types";

// ------------------------------------------------------------- expressions
/**
 * A tiny recursive-descent evaluator for choice/jump conditions and $-sets.
 * Supports: numbers, strings, true/false, variables, + - * /, comparisons,
 * ! && ||, parentheses. Undefined variables read as 0 at runtime (the linter
 * flags them at compile time, which is where that bug belongs).
 */
export function evaluate(expr: string, vars: Vars): number | boolean | string {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function primary(): number | boolean | string {
    const token = take();
    if (token === undefined) throw new Error(`unexpected end of expression: ${expr}`);
    if (token === "(") {
      const value = or();
      if (take() !== ")") throw new Error(`missing ")" in: ${expr}`);
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token === "-") return -Number(primary());
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^"/.test(token)) return token.slice(1, -1);
    if (/^\d/.test(token)) return parseFloat(token);
    return vars[token] ?? 0; // variable
  }

  function mul(): number | boolean | string {
    let left = primary();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const right = primary();
      left = op === "*" ? Number(left) * Number(right) : Number(left) / Number(right);
    }
    return left;
  }

  function add(): number | boolean | string {
    let left = mul();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const right = mul();
      if (op === "+" && (typeof left === "string" || typeof right === "string")) {
        left = String(left) + String(right);
      } else {
        left = op === "+" ? Number(left) + Number(right) : Number(left) - Number(right);
      }
    }
    return left;
  }

  function compare(): number | boolean | string {
    let left = add();
    while (["==", "!=", ">=", "<=", ">", "<"].includes(peek() as string)) {
      const op = take();
      const right = add();
      switch (op) {
        case "==": left = left === right; break;
        case "!=": left = left !== right; break;
        case ">=": left = Number(left) >= Number(right); break;
        case "<=": left = Number(left) <= Number(right); break;
        case ">": left = Number(left) > Number(right); break;
        case "<": left = Number(left) < Number(right); break;
      }
    }
    return left;
  }

  function and(): number | boolean | string {
    let left = compare();
    while (peek() === "&&") {
      take();
      const right = compare();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  function or(): number | boolean | string {
    let left = and();
    while (peek() === "||") {
      take();
      const right = and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  const result = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens in: ${expr}`);
  return result;
}

export function truthy(value: number | boolean | string): boolean {
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

function tokenize(expr: string): string[] {
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|&&|\|\||==|!=|>=|<=|[()!<>+\-*/]|[A-Za-z_]\w*|\d+(?:\.\d+)?)/y;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const match = re.exec(expr);
    if (!match) throw new Error(`bad token at "${expr.slice(pos)}"`);
    out.push(match[1]);
    pos = re.lastIndex;
  }
  return out;
}

/** Variable names referenced by an expression (used by the linter). */
export function referencedVars(expr: string): string[] {
  try {
    return tokenize(expr).filter(
      (token) =>
        /^[A-Za-z_]\w*$/.test(token) && !["true", "false"].includes(token)
    );
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- execution

export function begin(story: Story): GameState {
  return {
    scene: story.start,
    index: 0,
    vars: {},
    visuals: { bg: null, sprites: [], music: null },
    seen: [],
  };
}

/**
 * Advance until a player-facing step. Mutates a *copy* of state; callers keep
 * the old one for rollback.
 */
export function next(story: Story, prev: GameState): { state: GameState; view: View } {
  const state: GameState = structuredClone(prev);
  let guard = 0;

  for (;;) {
    if (guard++ > 10_000) throw new Error("runaway story: >10k steps without player input");
    const scene = story.scenes.get(state.scene);
    if (!scene) throw new Error(`jump to unknown scene "${state.scene}"`);

    if (state.index >= scene.steps.length) {
      throw new Error(
        `scene "${scene.name}" fell off the end - every scene must finish with a jump, choices, or @ending`
      );
    }

    const step = scene.steps[state.index];
    switch (step.kind) {
      case "bg":
        state.visuals.bg = step.asset;
        state.index++;
        break;
      case "show": {
        const existing = state.visuals.sprites.find((s) => s.who === step.who);
        if (existing) existing.expression = step.expression;
        else state.visuals.sprites.push({ who: step.who, expression: step.expression });
        state.index++;
        break;
      }
      case "hide":
        state.visuals.sprites = state.visuals.sprites.filter((s) => s.who !== step.who);
        state.index++;
        break;
      case "music":
        state.visuals.music = step.asset;
        state.index++;
        break;
      case "sound":
        state.index++;
        break;
      case "set":
        applySet(state.vars, step.target, step.op, step.expr);
        state.index++;
        break;
      case "jump":
        state.scene = step.target;
        state.index = 0;
        break;
      case "condjump":
        if (truthy(evaluate(step.expr, state.vars))) {
          state.scene = step.target;
          state.index = 0;
        } else {
          state.index++;
        }
        break;
      case "dialogue": {
        if (step.expression) {
          const sprite = state.visuals.sprites.find((s) => s.who === step.who);
          if (sprite) sprite.expression = step.expression;
          else state.visuals.sprites.push({ who: step.who, expression: step.expression });
        }
        state.index++;
        state.seen.push({ who: step.who, text: step.text });
        const who = story.characters.get(step.who) ?? null;
        return {
          state,
          view: { kind: "dialogue", who, expression: step.expression, text: step.text },
        };
      }
      case "narration":
        state.index++;
        state.seen.push({ who: null, text: step.text });
        return {
          state,
          view: { kind: "dialogue", who: null, expression: null, text: step.text },
        };
      case "choices": {
        const options = step.options
          .map((option, index) => ({ option, index }))
          .filter(({ option }) => option.condition === null || truthy(evaluate(option.condition, state.vars)))
          .map(({ option, index }) => ({ text: option.text, index }));
        if (options.length === 0) {
          throw new Error(
            `all choices at ${state.scene}:${step.line} are condition-locked - the player is stuck`
          );
        }
        return { state, view: { kind: "choices", options } };
      }
      case "ending":
        return { state, view: { kind: "ending", title: step.title } };
    }
  }
}

/** Apply choice `optionIndex` (an index into the ORIGINAL options array). */
export function choose(story: Story, prev: GameState, optionIndex: number): GameState {
  const state: GameState = structuredClone(prev);
  const scene = story.scenes.get(state.scene);
  if (!scene) throw new Error(`unknown scene "${state.scene}"`);
  const step = scene.steps[state.index];
  if (step?.kind !== "choices") throw new Error("choose() called when not at a choice");
  const option = step.options[optionIndex];
  if (!option) throw new Error(`no choice #${optionIndex}`);

  state.seen.push({ who: null, text: `> ${option.text}` });
  for (const effect of option.effects) {
    if (effect.kind === "set") applySet(state.vars, effect.target, effect.op, effect.expr);
  }
  state.scene = option.target;
  state.index = 0;
  return state;
}

function applySet(vars: Vars, target: string, op: "=" | "+=" | "-=", expr: string): void {
  const value = evaluate(expr, vars);
  if (op === "=") {
    vars[target] = value;
  } else {
    const current = Number(vars[target] ?? 0);
    vars[target] = op === "+=" ? current + Number(value) : current - Number(value);
  }
}
