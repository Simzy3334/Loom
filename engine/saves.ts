/**
 * Saves that survive story updates.
 *
 * Ren'Py pickles live execution state, so editing a released script corrupts
 * old saves in ways players discover for you. Loom saves are explicit data:
 * (story version, scene, step index, variables, visuals) - nothing else.
 *
 * When the story's `version N` bumps, registered migrations transform old
 * saves forward one version at a time (rename a flag, re-point a deleted
 * scene). Loading also *validates* against the current story: an unknown
 * scene fails loudly at load time, not as a mystery crash mid-play.
 */

import type { GameState, Story, Vars, Visuals } from "./types";

export interface SaveFile {
  loom: 1; // save format version (the engine's, not the story's)
  storyVersion: number;
  savedAt: string;
  label: string; // e.g. the last line of dialogue, for the save/load UI
  scene: string;
  index: number;
  vars: Vars;
  visuals: Visuals;
}

export type Migration = (save: SaveFile) => SaveFile;

export class SaveError extends Error {}

export function serialize(story: Story, state: GameState): SaveFile {
  const lastSeen = state.seen[state.seen.length - 1];
  return {
    loom: 1,
    storyVersion: story.version,
    savedAt: new Date().toISOString(),
    label: lastSeen ? lastSeen.text.slice(0, 60) : "the beginning",
    scene: state.scene,
    index: state.index,
    vars: { ...state.vars },
    visuals: structuredClone(state.visuals),
  };
}

/**
 * Turn a SaveFile back into a GameState, applying migrations as needed.
 * `migrations` maps FROM-version -> transform (a save at version 2 passes
 * through migrations[2], then migrations[3], ... up to story.version).
 */
export function deserialize(
  story: Story,
  raw: unknown,
  migrations: Record<number, Migration> = {}
): GameState {
  const save = validateShape(raw);

  if (save.storyVersion > story.version) {
    throw new SaveError(
      `save is from story version ${save.storyVersion}, newer than this build (${story.version})`
    );
  }

  let migrated = save;
  for (let from = save.storyVersion; from < story.version; from++) {
    const step = migrations[from];
    if (!step) {
      throw new SaveError(
        `save is from story version ${from} and no migration to ${from + 1} is registered`
      );
    }
    migrated = step(structuredClone(migrated));
    migrated.storyVersion = from + 1;
  }

  if (!story.scenes.has(migrated.scene)) {
    throw new SaveError(
      `save points at scene "${migrated.scene}", which no longer exists - add a migration that re-points it`
    );
  }
  const scene = story.scenes.get(migrated.scene)!;
  const index = Math.min(migrated.index, Math.max(scene.steps.length - 1, 0));

  return {
    scene: migrated.scene,
    index,
    vars: { ...migrated.vars },
    visuals: structuredClone(migrated.visuals),
    seen: [{ who: null, text: `— loaded: ${migrated.label} —` }],
  };
}

function validateShape(raw: unknown): SaveFile {
  if (typeof raw !== "object" || raw === null) throw new SaveError("save is not an object");
  const save = raw as Partial<SaveFile>;
  if (save.loom !== 1) throw new SaveError("not a Loom save file");
  if (typeof save.scene !== "string" || typeof save.index !== "number") {
    throw new SaveError("save is missing scene position");
  }
  if (typeof save.storyVersion !== "number") throw new SaveError("save has no story version");
  if (typeof save.vars !== "object" || save.vars === null) throw new SaveError("save has no variables");
  const visuals = save.visuals;
  if (
    typeof visuals !== "object" ||
    visuals === null ||
    !Array.isArray((visuals as Visuals).sprites)
  ) {
    throw new SaveError("save has no visuals");
  }
  return save as SaveFile;
}
