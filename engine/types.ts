/**
 * Loom's story model.
 *
 * A story compiles to a flat map of scenes, each a list of typed steps.
 * Everything the runtime, linter and simulator do operates on this one
 * structure - the DSL is just a friendly way to write it.
 */

export interface Character {
  id: string;
  name: string;
  color: string;
}

export type Expr = string; // parsed lazily by the evaluator; validated by the linter

export type Step =
  | { kind: "dialogue"; who: string; expression: string | null; text: string; line: number }
  | { kind: "narration"; text: string; line: number }
  | { kind: "bg"; asset: string; line: number }
  | { kind: "show"; who: string; expression: string; line: number }
  | { kind: "hide"; who: string; line: number }
  | { kind: "music"; asset: string | null; line: number }
  | { kind: "sound"; asset: string; line: number }
  | { kind: "set"; target: string; op: "=" | "+=" | "-="; expr: Expr; line: number }
  | { kind: "jump"; target: string; line: number }
  | { kind: "condjump"; expr: Expr; target: string; line: number }
  | { kind: "choices"; options: Choice[]; line: number }
  | { kind: "ending"; title: string; line: number };

export interface Choice {
  text: string;
  target: string;
  condition: Expr | null;
  effects: Step[]; // set-steps executed when the choice is taken
  line: number;
}

export interface Scene {
  name: string;
  steps: Step[];
  line: number;
}

export interface Story {
  title: string;
  version: number;
  start: string;
  characters: Map<string, Character>;
  scenes: Map<string, Scene>;
}

// ------------------------------------------------------------------ runtime

export type Vars = Record<string, number | boolean | string>;

export interface Visuals {
  bg: string | null;
  sprites: { who: string; expression: string }[];
  music: string | null;
}

export interface GameState {
  scene: string;
  index: number; // next step to execute within the scene
  vars: Vars;
  visuals: Visuals;
  /** [sceneName, stepIndex] history for the backlog / rollback */
  seen: { who: string | null; text: string }[];
}

/** What the UI must render right now. */
export type View =
  | { kind: "dialogue"; who: Character | null; expression: string | null; text: string }
  | { kind: "choices"; options: { text: string; index: number }[] }
  | { kind: "ending"; title: string };

export interface LintIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  line: number;
}

export interface ParseError {
  message: string;
  line: number;
}
