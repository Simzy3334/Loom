/**
 * The .loom script parser.
 *
 * Line-based, indentation-light, designed so a writer can learn it in five
 * minutes and a diff reads like the story changed, not the code:
 *
 *   title  "Transfer Student"
 *   char rei  "Rei Ayame"  #d98a6a
 *
 *   :: intro
 *   @bg classroom
 *   @show rei happy
 *   The classroom hums with morning chatter.
 *   rei: You're the transfer student, right?
 *   rei (grinning): Everyone gets lost on day one.
 *   $ trust = 0
 *   * "Follow her" -> tour
 *       $ trust += 1
 *   * {trust >= 5} "Ask her out" -> confession
 *
 *   :: tour
 *   @if trust >= 1 -> good_route
 *   -> neutral_route
 */

import type { Character, Choice, ParseError, Scene, Story } from "./types";

const SCENE_RE = /^::\s*([A-Za-z_][\w-]*)\s*$/;
const CHAR_RE = /^char\s+([A-Za-z_]\w*)\s+"([^"]+)"\s*(#[0-9a-fA-F]{3,8})?\s*$/;
const TITLE_RE = /^title\s+"([^"]+)"\s*$/;
const VERSION_RE = /^version\s+(\d+)\s*$/;
const DIRECTIVE_RE = /^@(\w+)\s*(.*)$/;
const SET_RE = /^\$\s*([A-Za-z_]\w*)\s*(\+=|-=|=)\s*(.+)$/;
const CHOICE_RE = /^\*\s*(?:\{([^}]+)\}\s*)?"([^"]+)"\s*->\s*([A-Za-z_][\w-]*)\s*$/;
const JUMP_RE = /^->\s*([A-Za-z_][\w-]*)\s*$/;
const DIALOGUE_RE = /^([A-Za-z_]\w*)\s*(?:\(([^)]+)\))?\s*:\s*(.+)$/;

export function parse(source: string): { story: Story; errors: ParseError[] } {
  const errors: ParseError[] = [];
  const characters = new Map<string, Character>();
  const scenes = new Map<string, Scene>();
  let title = "Untitled";
  let version = 1;
  let start: string | null = null;
  let current: Scene | null = null;
  let pendingChoices: Choice[] | null = null;
  let choicesLine = 0;

  const flushChoices = () => {
    if (pendingChoices && current) {
      current.steps.push({ kind: "choices", options: pendingChoices, line: choicesLine });
    }
    pendingChoices = null;
  };

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const indented = /^\s+\S/.test(raw);
    const line = stripComment(raw).trim();
    if (!line) continue;

    // ---- indented lines belong to the most recent choice (its effects)
    if (indented && pendingChoices && pendingChoices.length > 0) {
      const setMatch = line.match(SET_RE);
      if (setMatch) {
        pendingChoices[pendingChoices.length - 1].effects.push({
          kind: "set",
          target: setMatch[1],
          op: setMatch[2] as "=" | "+=" | "-=",
          expr: setMatch[3].trim(),
          line: lineNo,
        });
      } else {
        errors.push({
          message: `only "$ var = value" effects may be nested under a choice`,
          line: lineNo,
        });
      }
      continue;
    }

    // ---- header statements (before or between scenes)
    const titleMatch = line.match(TITLE_RE);
    if (titleMatch) {
      title = titleMatch[1];
      continue;
    }
    const versionMatch = line.match(VERSION_RE);
    if (versionMatch) {
      version = parseInt(versionMatch[1], 10);
      continue;
    }
    const charMatch = line.match(CHAR_RE);
    if (charMatch) {
      const [, id, name, color] = charMatch;
      if (characters.has(id)) {
        errors.push({ message: `character "${id}" declared twice`, line: lineNo });
      }
      characters.set(id, { id, name, color: color ?? "#e0a458" });
      continue;
    }

    // ---- scene boundary
    const sceneMatch = line.match(SCENE_RE);
    if (sceneMatch) {
      flushChoices();
      const name = sceneMatch[1];
      if (scenes.has(name)) {
        errors.push({ message: `scene "${name}" declared twice`, line: lineNo });
      }
      current = { name, steps: [], line: lineNo };
      scenes.set(name, current);
      if (start === null) start = name;
      continue;
    }

    if (!current) {
      errors.push({ message: `content before the first ":: scene"`, line: lineNo });
      continue;
    }

    // ---- choices accumulate until a non-choice line
    const choiceMatch = line.match(CHOICE_RE);
    if (choiceMatch) {
      if (!pendingChoices) {
        pendingChoices = [];
        choicesLine = lineNo;
      }
      pendingChoices.push({
        condition: choiceMatch[1]?.trim() ?? null,
        text: choiceMatch[2],
        target: choiceMatch[3],
        effects: [],
        line: lineNo,
      });
      continue;
    }
    flushChoices();

    // ---- directives
    const directiveMatch = line.match(DIRECTIVE_RE);
    if (directiveMatch) {
      const [, word, rest] = directiveMatch;
      const arg = rest.trim();
      switch (word) {
        case "bg":
          current.steps.push({ kind: "bg", asset: arg, line: lineNo });
          break;
        case "show": {
          const [who, expression = "neutral"] = arg.split(/\s+/);
          current.steps.push({ kind: "show", who, expression, line: lineNo });
          break;
        }
        case "hide":
          current.steps.push({ kind: "hide", who: arg, line: lineNo });
          break;
        case "music":
          current.steps.push({
            kind: "music",
            asset: arg === "stop" || arg === "" ? null : arg,
            line: lineNo,
          });
          break;
        case "sound":
          current.steps.push({ kind: "sound", asset: arg, line: lineNo });
          break;
        case "ending":
          current.steps.push({
            kind: "ending",
            title: arg.replace(/^"|"$/g, "") || current.name,
            line: lineNo,
          });
          break;
        case "if": {
          const ifMatch = arg.match(/^(.+?)\s*->\s*([A-Za-z_][\w-]*)$/);
          if (ifMatch) {
            current.steps.push({
              kind: "condjump",
              expr: ifMatch[1].trim(),
              target: ifMatch[2],
              line: lineNo,
            });
          } else {
            errors.push({ message: `@if expects "@if <expr> -> scene"`, line: lineNo });
          }
          break;
        }
        default:
          errors.push({ message: `unknown directive "@${word}"`, line: lineNo });
      }
      continue;
    }

    // ---- state
    const setMatch = line.match(SET_RE);
    if (setMatch) {
      current.steps.push({
        kind: "set",
        target: setMatch[1],
        op: setMatch[2] as "=" | "+=" | "-=",
        expr: setMatch[3].trim(),
        line: lineNo,
      });
      continue;
    }

    // ---- jump
    const jumpMatch = line.match(JUMP_RE);
    if (jumpMatch) {
      current.steps.push({ kind: "jump", target: jumpMatch[1], line: lineNo });
      continue;
    }

    // ---- dialogue (only for declared characters - anything else is prose)
    const dialogueMatch = line.match(DIALOGUE_RE);
    if (dialogueMatch && characters.has(dialogueMatch[1])) {
      current.steps.push({
        kind: "dialogue",
        who: dialogueMatch[1],
        expression: dialogueMatch[2]?.trim() ?? null,
        text: dialogueMatch[3].trim(),
        line: lineNo,
      });
      continue;
    }

    // ---- narration
    current.steps.push({ kind: "narration", text: line, line: lineNo });
  }
  flushChoices();

  if (!start) {
    errors.push({ message: "story has no scenes", line: 1 });
    start = "__missing__";
  }

  return {
    story: { title, version, start, characters, scenes },
    errors,
  };
}

function stripComment(line: string): string {
  // '#' starts a comment unless inside quotes or part of a color literal
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "#" && !inQuotes) {
      // color literals: '#' followed by 3-8 hex digits then end/space
      const tail = line.slice(i + 1);
      if (/^[0-9a-fA-F]{3,8}(\s|$)/.test(tail)) continue;
      return line.slice(0, i);
    }
  }
  return line;
}
