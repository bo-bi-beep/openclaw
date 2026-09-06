import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = "scripts/resolve-fs-safe-native-contract.mjs";
const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function commitSource(version: string, defaults: string, extraSource?: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-fs-safe-contract-"));
  tempDirectories.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@openclaw.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OpenClaw test"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ dependencies: { "@openclaw/fs-safe": version } })}\n`,
  );
  const defaultsPath = join(root, "src/infra/fs-safe-defaults.ts");
  mkdirSync(dirname(defaultsPath), { recursive: true });
  writeFileSync(defaultsPath, defaults);
  if (extraSource) {
    const sourcePath = join(root, "packages/example/native.ts");
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, extraSource);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return {
    root,
    ref: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

function resolveContract(
  root: string,
  ref: string,
  allowFrozenSource = true,
  workflowSha = "f".repeat(40),
) {
  return execFileSync(
    process.execPath,
    [
      SCRIPT,
      "--repository",
      root,
      "--ref",
      ref,
      "--workflow-sha",
      workflowSha,
      "--allow-frozen-source",
      allowFrozenSource ? "1" : "0",
    ],
    {
      encoding: "utf8",
    },
  ).trim();
}

const legacyDefaults = 'import { configureFsSafePython } from "@openclaw/fs-safe/config";\n';

describe("resolve-fs-safe-native-contract", () => {
  it("reports the actual 0.3 selected-source contract as not applicable when authorized", () => {
    const { root, ref } = commitSource("0.3.0", legacyDefaults);
    expect(resolveContract(root, ref)).toBe("not-applicable");
  });

  it("keeps the current native consumer contract strict", () => {
    const { root, ref } = commitSource(
      "0.8.1",
      'import { configureFsSafeNative } from "@openclaw/fs-safe/config";\n',
    );
    expect(resolveContract(root, ref)).toBe("required");
  });

  it("keeps current, unauthorized, or sibling-native source contracts strict", () => {
    const unauthorized = commitSource("0.3.0", legacyDefaults);
    expect(resolveContract(unauthorized.root, unauthorized.ref, false)).toBe("required");
    expect(resolveContract(unauthorized.root, unauthorized.ref, true, unauthorized.ref)).toBe(
      "required",
    );
    const sibling = commitSource(
      "0.3.0",
      legacyDefaults,
      'import { getNativeBinding } from "@openclaw/fs-safe/native";\n',
    );
    expect(resolveContract(sibling.root, sibling.ref)).toBe("required");
  });
});
