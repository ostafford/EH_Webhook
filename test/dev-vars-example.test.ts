/**
 * Issue #60: `.gitignore`'s `.dev.vars.*` once matched `.dev.vars.example`
 * too, so a fresh clone had no example to `cp` from. The examples must be
 * tracked; the real `.dev.vars` (secrets) must stay ignored.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
/** `git check-ignore` exits 0 when the path is ignored, 1 when it isn't. */
const ignored = (path: string): boolean => {
  try {
    git("check-ignore", "-q", "--no-index", path);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!existsSync(`${root}.git`))(".dev.vars examples (issue #60)", () => {
  const examples = [".dev.vars.example", "integrator-relay/.dev.vars.example"];

  it.each(examples)("%s is tracked, so a fresh clone has it", (path) => {
    expect(git("ls-files", "--", path).trim()).toBe(path);
  });

  it.each([".dev.vars", "integrator-relay/.dev.vars", ".dev.vars.local"])("%s stays ignored", (path) => {
    expect(ignored(path)).toBe(true);
  });
});
