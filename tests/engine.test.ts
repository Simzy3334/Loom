import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "../engine/parser";
import { lint } from "../engine/linter";
import { begin, choose, evaluate, next } from "../engine/interpreter";
import { explore } from "../engine/simulator";
import { deserialize, SaveError, serialize } from "../engine/saves";

const DEMO = readFileSync(new URL("../story/demo.loom", import.meta.url), "utf-8");

const tiny = (body: string) =>
  parse(`title "T"\nversion 1\nchar a "A" #fff\n${body}`);

// -------------------------------------------------------------------- parser
describe("parser", () => {
  it("parses the demo story without errors", () => {
    const { story, errors } = parse(DEMO);
    expect(errors).toEqual([]);
    expect(story.title).toBe("Transfer Student");
    expect(story.scenes.size).toBe(10);
    expect(story.characters.get("rei")?.name).toBe("Rei Ayame");
  });

  it("distinguishes dialogue from narration with colons", () => {
    const { story } = tiny(`:: s\na: hello there\nThe clock reads 3:15 exactly.\n@ending "E"`);
    const steps = story.scenes.get("s")!.steps;
    expect(steps[0].kind).toBe("dialogue");
    expect(steps[1].kind).toBe("narration");
  });

  it("attaches choice effects and conditions", () => {
    const { story } = tiny(
      `:: s\n$ x = 0\n* {x >= 0} "go" -> t\n    $ x += 2\n:: t\n@ending "E"`
    );
    const choices = story.scenes.get("s")!.steps.find((s) => s.kind === "choices");
    expect(choices?.kind).toBe("choices");
    if (choices?.kind === "choices") {
      expect(choices.options[0].condition).toBe("x >= 0");
      expect(choices.options[0].effects[0]).toMatchObject({ kind: "set", op: "+=" });
    }
  });

  it("keeps color literals out of comments", () => {
    const { story } = parse(`title "T"\nchar a "A" #d98a6a  # trailing comment\n:: s\n@ending "E"`);
    expect(story.characters.get("a")?.color).toBe("#d98a6a");
  });

  it("reports duplicate scenes and unknown directives", () => {
    const { errors } = tiny(`:: s\n@warp somewhere\n@ending "E"\n:: s\n@ending "F"`);
    expect(errors.some((e) => e.message.includes("declared twice"))).toBe(true);
    expect(errors.some((e) => e.message.includes("unknown directive"))).toBe(true);
  });
});

// ---------------------------------------------------------------- expressions
describe("expression evaluator", () => {
  const vars = { trust: 3, name: "Rei", flag: true };
  it.each([
    ["trust >= 3", true],
    ["trust + 2 * 2", 7],
    ["(trust + 2) * 2", 10],
    ["!flag || trust > 10", false],
    ['name == "Rei" && flag', true],
    ["missing + 1", 1], // undefined reads as 0 at runtime
  ])("%s", (expr, expected) => {
    expect(evaluate(expr, vars)).toBe(expected);
  });
});

// -------------------------------------------------------------------- linter
describe("linter", () => {
  it("passes the demo story clean", () => {
    const { story } = parse(DEMO);
    expect(lint(story).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("catches broken jumps", () => {
    const { story } = tiny(`:: s\n-> nowhere`);
    expect(lint(story).some((i) => i.rule === "broken-jump")).toBe(true);
  });

  it("catches unreachable scenes", () => {
    const { story } = tiny(`:: s\n@ending "E"\n:: island\n@ending "F"`);
    expect(lint(story).some((i) => i.rule === "unreachable-scene")).toBe(true);
  });

  it("catches variables read but never set", () => {
    const { story } = tiny(`:: s\n@if ghost > 2 -> s\n@ending "E"`);
    expect(lint(story).some((i) => i.rule === "unset-variable")).toBe(true);
  });

  it("warns on variables set but never read", () => {
    const { story } = tiny(`:: s\n$ orphan = 1\n@ending "E"`);
    expect(lint(story).some((i) => i.rule === "unused-variable")).toBe(true);
  });

  it("catches fallthrough scenes", () => {
    const { story } = tiny(`:: s\na: hello`);
    expect(lint(story).some((i) => i.rule === "fallthrough")).toBe(true);
  });

  it("flags narration that looks like dialogue from an undeclared speaker", () => {
    const { story } = parse(`title "T"\n:: s\nghost: boo\n@ending "E"`);
    expect(lint(story).some((i) => i.rule === "possible-undeclared-speaker")).toBe(true);
  });

  it("catches @show of an undeclared character", () => {
    const { story } = parse(`title "T"\n:: s\n@show ghost happy\n@ending "E"`);
    expect(lint(story).some((i) => i.rule === "unknown-character")).toBe(true);
  });

  it("warns when every choice is condition-locked", () => {
    const { story } = tiny(`:: s\n$ x = 0\n* {x > 5} "a" -> s\n* {x > 9} "b" -> s`);
    expect(lint(story).some((i) => i.rule === "lockable-choice")).toBe(true);
  });

  it("requires a reachable ending", () => {
    const { story } = tiny(`:: s\n-> s`);
    expect(lint(story).some((i) => i.rule === "no-ending")).toBe(true);
  });
});

// --------------------------------------------------------------- interpreter
describe("interpreter", () => {
  it("plays a full scripted route to the expected ending", () => {
    const { story } = parse(DEMO);
    let state = begin(story);

    // advance to the first choice
    let view;
    for (;;) {
      ({ state, view } = next(story, state));
      if (view.kind === "choices") break;
    }
    // "That's... comforting?" (+1 trust)
    state = choose(story, state, 0);
    for (;;) {
      ({ state, view } = next(story, state));
      if (view.kind === "choices") break;
    }
    // "Follow Rei to the roof" (+2 trust -> 3 -> rei_end)
    state = choose(story, state, 1);
    for (;;) {
      ({ state, view } = next(story, state));
      if (view.kind === "ending") break;
    }
    expect(view).toMatchObject({ kind: "ending", title: "Rooftop Promise" });
    expect(state.vars.trust_rei).toBe(3);
  });

  it("tracks visuals through show/hide and expressions", () => {
    const { story } = parse(DEMO);
    let state = begin(story);
    const { state: after } = next(story, state);
    expect(after.visuals.bg).toBe("classroom");
    expect(after.visuals.music).toBe("morning");
  });

  it("filters condition-locked choices from the view", () => {
    const { story } = parse(DEMO);
    let state = begin(story);
    let view;
    for (;;) {
      ({ state, view } = next(story, state));
      if (view.kind === "choices") break;
    }
    state = choose(story, state, 1); // polite: trust_rei = 0
    for (;;) {
      ({ state, view } = next(story, state));
      if (view.kind === "choices") break;
    }
    // third option requires trust_rei >= 1 - must be hidden
    expect(view.kind === "choices" && view.options.length).toBe(2);
  });

  it("throws a clear error when the player would be stuck", () => {
    const { story } = tiny(`:: s\n$ x = 0\n* {x > 5} "a" -> s`);
    const state = begin(story);
    expect(() => next(story, state)).toThrow(/stuck/);
  });
});

// --------------------------------------------------------------------- saves
describe("saves", () => {
  it("roundtrips through serialize/deserialize", () => {
    const { story } = parse(DEMO);
    let state = begin(story);
    ({ state } = next(story, state));
    ({ state } = next(story, state));
    const file = serialize(story, state);
    const restored = deserialize(story, JSON.parse(JSON.stringify(file)));
    expect(restored.scene).toBe(state.scene);
    expect(restored.index).toBe(state.index);
    expect(restored.vars).toEqual(state.vars);
  });

  it("rejects saves from a newer story version", () => {
    const { story } = parse(DEMO);
    const file = { ...serialize(story, begin(story)), storyVersion: 99 };
    expect(() => deserialize(story, file)).toThrow(SaveError);
  });

  it("migrates old saves forward", () => {
    const v2 = parse(DEMO.replace("version 1", "version 2"));
    const v1file = { ...serialize(v2.story, begin(v2.story)), storyVersion: 1 };
    v1file.vars = { old_trust: 3 };
    const restored = deserialize(v2.story, v1file, {
      1: (save) => ({ ...save, vars: { trust_rei: Number(save.vars.old_trust) } }),
    });
    expect(restored.vars.trust_rei).toBe(3);
  });

  it("fails loudly when a save points at a deleted scene", () => {
    const { story } = parse(DEMO);
    const file = { ...serialize(story, begin(story)), scene: "deleted_scene" };
    expect(() => deserialize(story, file)).toThrow(/no longer exists/);
  });

  it("rejects malformed saves", () => {
    const { story } = parse(DEMO);
    expect(() => deserialize(story, { loom: 1 })).toThrow(SaveError);
    expect(() => deserialize(story, "corrupt")).toThrow(SaveError);
  });
});

// ----------------------------------------------------------------- simulator
describe("simulator", () => {
  it("finds all three demo endings with full scene coverage", () => {
    const { story } = parse(DEMO);
    const report = explore(story);
    const titles = report.endings.map((e) => e.title).sort();
    expect(titles).toEqual(["A Slow Beginning", "Found Your People", "Rooftop Promise"]);
    expect(report.sceneCoverage).toBe(1);
    expect(report.stuck).toEqual([]);
  });

  it("provides an example path to each ending", () => {
    const { story } = parse(DEMO);
    const report = explore(story);
    const rooftop = report.endings.find((e) => e.title === "Rooftop Promise")!;
    expect(rooftop.examplePath.length).toBeGreaterThan(0);
  });

  it("detects an ending made unreachable by a flag change (regression guard)", () => {
    // sabotage: the rooftop route now requires trust_rei >= 30
    const broken = DEMO.replace("@if trust_rei >= 3 -> rei_end", "@if trust_rei >= 30 -> rei_end");
    const { story } = parse(broken);
    const report = explore(story);
    expect(report.endings.map((e) => e.title)).not.toContain("Rooftop Promise");
  });
});
