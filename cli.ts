/**
 * Loom CLI - the story compiler's front door. Made for CI:
 *
 *   npx tsx cli.ts lint story/demo.loom       # exit 1 on any error
 *   npx tsx cli.ts explore story/demo.loom    # exit 1 if any ending is lost
 */

import { readFileSync } from "node:fs";
import { parse } from "./engine/parser";
import { lint } from "./engine/linter";
import { explore } from "./engine/simulator";

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const [command, file] = process.argv.slice(2);
if (!command || !file) {
  console.log("usage: tsx cli.ts <lint|explore> <story.loom>");
  process.exit(2);
}

const source = readFileSync(file, "utf-8");
const { story, errors } = parse(source);

if (errors.length > 0) {
  for (const error of errors) {
    console.log(`${RED}parse error${RESET} ${DIM}${file}:${error.line}${RESET}  ${error.message}`);
  }
  process.exit(1);
}

if (command === "lint") {
  const issues = lint(story);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  console.log(`${BOLD}${story.title}${RESET} ${DIM}v${story.version} · ${story.scenes.size} scenes · ${story.characters.size} characters${RESET}\n`);
  for (const issue of issues) {
    const tint = issue.severity === "error" ? RED : YELLOW;
    console.log(
      `  ${tint}${issue.severity.padEnd(7)}${RESET} ${DIM}${file}:${issue.line}${RESET}  ${issue.message}  ${DIM}[${issue.rule}]${RESET}`
    );
  }
  if (issues.length === 0) {
    console.log(`  ${GREEN}clean${RESET} - no issues found`);
  }
  console.log(
    `\n${errorCount > 0 ? RED : GREEN}${errorCount} error(s)${RESET}, ${issues.length - errorCount} warning(s)`
  );
  process.exit(errorCount > 0 ? 1 : 0);
}

if (command === "explore") {
  const report = explore(story);
  console.log(`${BOLD}${story.title}${RESET} ${DIM}exhaustive playthrough simulation${RESET}\n`);
  console.log(`  states explored : ${report.statesExplored}`);
  console.log(`  scene coverage  : ${(report.sceneCoverage * 100).toFixed(0)}% (${report.scenesVisited.size}/${story.scenes.size})`);
  console.log(`  endings found   : ${report.endings.length}\n`);
  for (const ending of report.endings) {
    console.log(`  ${GREEN}◆${RESET} ${BOLD}${ending.title}${RESET}`);
    console.log(`    ${DIM}via: ${ending.examplePath.join("  →  ") || "(no choices needed)"}${RESET}`);
  }
  if (report.stuck.length > 0) {
    console.log(`\n  ${RED}stuck states:${RESET}`);
    for (const item of report.stuck.slice(0, 5)) {
      console.log(`    ${RED}✗${RESET} in "${item.scene}": ${item.error}`);
    }
  }
  const failed = report.endings.length === 0 || report.stuck.length > 0;
  process.exit(failed ? 1 : 0);
}

console.log(`unknown command "${command}"`);
process.exit(2);
