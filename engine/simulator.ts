/**
 * The playthrough simulator: Loom's answer to "did I break the story?"
 *
 * Drives the real interpreter through EVERY reachable combination of choices
 * (memoised on scene + variables, so shared branches aren't re-explored) and
 * reports which endings exist, how they're reached, and coverage. Runs in
 * milliseconds for typical VN sizes and belongs in CI:
 *
 *   const report = explore(story);
 *   expect(report.endings.map(e => e.title)).toContain("True Ending");
 */

import { begin, choose, next } from "./interpreter";
import type { GameState, Story } from "./types";

export interface EndingReport {
  title: string;
  /** one example path of choice texts that reaches it */
  examplePath: string[];
  /** number of distinct explored states that arrived here */
  hits: number;
}

export interface ExploreReport {
  endings: EndingReport[];
  scenesVisited: Set<string>;
  sceneCoverage: number; // visited / total
  statesExplored: number;
  stuck: { scene: string; error: string }[];
}

export function explore(story: Story, maxStates = 50_000): ExploreReport {
  const endings = new Map<string, EndingReport>();
  const scenesVisited = new Set<string>();
  const stuck: { scene: string; error: string }[] = [];
  const visited = new Set<string>();
  let statesExplored = 0;

  interface Work {
    state: GameState;
    path: string[];
  }
  const stack: Work[] = [{ state: begin(story), path: [] }];

  while (stack.length > 0) {
    if (statesExplored >= maxStates) break;
    const { state, path } = stack.pop()!;

    // memoise on the INPUT state: identical (scene, index, vars) have
    // identical futures. Keying the output instead would collide the state
    // that *arrives at* a choice with the one *presenting* it.
    const key = stateKey(state);
    if (visited.has(key)) continue;
    visited.add(key);

    let advanced;
    try {
      advanced = next(story, state);
    } catch (error) {
      stuck.push({ scene: state.scene, error: String(error) });
      continue;
    }
    statesExplored++;
    scenesVisited.add(advanced.state.scene);

    const { view } = advanced;
    if (view.kind === "ending") {
      const existing = endings.get(view.title);
      if (existing) existing.hits++;
      else endings.set(view.title, { title: view.title, examplePath: path, hits: 1 });
      continue;
    }
    if (view.kind === "choices") {
      for (const option of view.options) {
        const chosen = choose(story, advanced.state, option.index);
        stack.push({ state: chosen, path: [...path, option.text] });
      }
      continue;
    }
    // dialogue/narration: keep advancing
    stack.push({ state: advanced.state, path });
  }

  return {
    endings: [...endings.values()],
    scenesVisited,
    sceneCoverage: scenesVisited.size / Math.max(story.scenes.size, 1),
    statesExplored,
    stuck,
  };
}

/** Scene + step + vars uniquely determine future play; backlog doesn't. */
function stateKey(state: GameState): string {
  const vars = Object.keys(state.vars)
    .sort()
    .map((key) => `${key}=${state.vars[key]}`)
    .join(",");
  return `${state.scene}:${state.index}|${vars}`;
}
