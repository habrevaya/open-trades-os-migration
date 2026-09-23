import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY SOURCE FILE IS ACTUALLY IN THE REPOSITORY
 *
 * This repository has already been bitten by it once: `snapshot/` in
 * .gitignore, meant for the default output directory, matched at any depth
 * and swallowed src/snapshot. The fix anchored the pattern and nothing
 * stopped it happening again, so it did, in the platform repository, where a
 * bare `coverage/` swallowed the module that decides who is paying for a job.
 *
 * Nothing local notices. Typecheck, lint, tests and the build all pass
 * because the files are on disk. `git add -A` says nothing, because adding an
 * ignored file is not an error. CI is the first thing that sees it, and by
 * then it is several commits later.
 *
 * So this asks git directly. It is the one question a file on disk cannot
 * answer about itself.
 */
const ROOT = join(import.meta.dirname, "..");

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(ts|json|sql)$/.test(entry)) found.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, "src"));
  return found;
}

describe("the working tree and the repository agree", () => {
  it("finds source files at all", () => {
    // A walker that found none would make the check below pass by having
    // nothing to check.
    expect(sources().length).toBeGreaterThan(10);
  });

  it("has nothing under src that git is ignoring", () => {
    const files = sources();
    /**
     * `--no-index`, which is the difference between a test and a shape that
     * looks like one. Without it `git check-ignore` skips anything already
     * tracked, so the guard only sees a file that has never been committed:
     * re-introducing the pattern that caused this and pointing it at the
     * module it swallowed reports nothing at all.
     *
     * It exits 1 when nothing matches, which is the success case here, so a
     * non-zero exit is not an error to throw on.
     */
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
        cwd: ROOT, input: files.join("\n"), encoding: "utf8",
      });
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1) throw error;
      ignored = result.stdout ?? "";
    }

    expect(
      ignored.split("\n").filter(Boolean),
      "these source files are gitignored and will not reach CI",
    ).toEqual([]);
  });
});
