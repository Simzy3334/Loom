/**
 * The story linter - Loom's reason to exist.
 *
 * Ren'Py tells you a label is missing when the game boots. Loom tells you,
 * before anyone plays a frame:
 *   - which scenes can never be reached
 *   - which jumps point nowhere
 *   - which flags are read but never set (the classic silent-zero bug)
 *   - which variables are set but never used (dead weight / typos)
 *   - which choice groups can dead-end the player
 *   - which characters speak without being declared
 *   - whether the story even has a reachable ending
 *   - scenes that fall off the end with no jump/choices/@ending
 */

import { referencedVars } from "./interpreter";
import type { LintIssue, Story } from "./types";

export function lint(story: Story): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (severity: "error" | "warning", rule: string, message: string, line: number) =>
    issues.push({ severity, rule, message, line });

  // ------------------------------------------------ collect graph + var use
  const jumpTargets: { from: string; target: string; line: number }[] = [];
  const varsWritten = new Set<string>();
  const varsRead = new Map<string, number>(); // name -> first line read
  let endingCount = 0;

  const noteReads = (expr: string, line: number) => {
    for (const name of referencedVars(expr)) {
      if (!varsRead.has(name)) varsRead.set(name, line);
    }
  };

  for (const scene of story.scenes.values()) {
    let terminated = false;
    for (const step of scene.steps) {
      if (terminated) {
        push("warning", "dead-code", `unreachable step after the scene already ended`, step.line);
      }
      switch (step.kind) {
        case "jump":
          jumpTargets.push({ from: scene.name, target: step.target, line: step.line });
          terminated = true;
          break;
        case "condjump":
          jumpTargets.push({ from: scene.name, target: step.target, line: step.line });
          noteReads(step.expr, step.line);
          break;
        case "choices": {
          let allConditional = true;
          for (const option of step.options) {
            jumpTargets.push({ from: scene.name, target: option.target, line: option.line });
            if (option.condition) noteReads(option.condition, option.line);
            else allConditional = false;
            for (const effect of option.effects) {
              if (effect.kind === "set") {
                varsWritten.add(effect.target);
                noteReads(effect.expr, effect.line);
              }
            }
          }
          if (allConditional && step.options.length > 0) {
            push(
              "warning",
              "lockable-choice",
              `every choice here is condition-locked - if all conditions are false the player is stuck`,
              step.line
            );
          }
          terminated = true;
          break;
        }
        case "set":
          varsWritten.add(step.target);
          noteReads(step.expr, step.line);
          break;
        case "ending":
          endingCount++;
          terminated = true;
          break;
        case "dialogue":
          if (!story.characters.has(step.who)) {
            push(
              "error",
              "unknown-character",
              `"${step.who}" speaks but was never declared with 'char ${step.who} "Name"'`,
              step.line
            );
          }
          break;
        case "narration": {
          // A typo'd speaker name silently parses as narration - the worst
          // kind of bug, because the game still "works". Flag prose that
          // looks exactly like a dialogue line.
          const match = step.text.match(/^([a-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*\S/);
          if (match && !story.characters.has(match[1])) {
            push(
              "warning",
              "possible-undeclared-speaker",
              `this narration looks like dialogue from "${match[1]}" - declare the character or rephrase`,
              step.line
            );
          }
          break;
        }
        case "show":
        case "hide":
          if (!story.characters.has(step.who)) {
            push("error", "unknown-character", `@${step.kind} references undeclared character "${step.who}"`, step.line);
          }
          break;
        default:
          break;
      }
    }
    if (!terminated) {
      push(
        "error",
        "fallthrough",
        `scene "${scene.name}" has no jump, choices, or @ending - play falls off the end`,
        scene.line
      );
    }
  }

  // ------------------------------------------------------- broken jumps
  for (const { from, target, line } of jumpTargets) {
    if (!story.scenes.has(target)) {
      push("error", "broken-jump", `"${from}" jumps to "${target}", which doesn't exist`, line);
    }
  }

  // ------------------------------------------------------- reachability
  const reachable = new Set<string>();
  const queue = [story.start];
  while (queue.length) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const edge of jumpTargets) {
      if (edge.from === name && story.scenes.has(edge.target) && !reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }
  for (const scene of story.scenes.values()) {
    if (!reachable.has(scene.name)) {
      push("warning", "unreachable-scene", `scene "${scene.name}" can never be reached`, scene.line);
    }
  }

  // ------------------------------------------------------------ variables
  for (const [name, line] of varsRead) {
    if (!varsWritten.has(name)) {
      push(
        "error",
        "unset-variable",
        `"${name}" is read but never set - it will silently evaluate as 0`,
        line
      );
    }
  }
  for (const name of varsWritten) {
    if (!varsRead.has(name)) {
      push("warning", "unused-variable", `"${name}" is set but never read`, 0);
    }
  }

  // -------------------------------------------------------------- endings
  if (endingCount === 0) {
    push("error", "no-ending", `story has no @ending - it cannot conclude`, 0);
  } else {
    const endingReachable = [...story.scenes.values()].some(
      (scene) => reachable.has(scene.name) && scene.steps.some((s) => s.kind === "ending")
    );
    if (!endingReachable) {
      push("error", "no-reachable-ending", `no @ending is reachable from "${story.start}"`, 0);
    }
  }

  return issues.sort((a, b) => a.line - b.line);
}
