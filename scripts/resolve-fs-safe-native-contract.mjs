import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const LEGACY_DEFAULTS_IMPORT = 'import { configureFsSafePython } from "@openclaw/fs-safe/config";';
const NATIVE_CONSUMER_PATTERN =
  /\b(?:configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\b|@openclaw\/fs-safe\/native/u;

function parseArgs(argv) {
  let ref;
  let repository = process.cwd();
  let allowFrozenSource = false;
  let workflowSha;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--ref") {
      ref = value;
    } else if (key === "--repository") {
      repository = value;
    } else if (key === "--allow-frozen-source") {
      if (value !== "0" && value !== "1") {
        throw new Error("--allow-frozen-source must be 0 or 1");
      }
      allowFrozenSource = value === "1";
    } else if (key === "--workflow-sha") {
      workflowSha = value;
    } else {
      throw new Error(`unknown argument: ${key ?? ""}`);
    }
  }
  assert.match(ref ?? "", /^[0-9a-f]{40}$/u, "--ref must be a full lowercase commit SHA");
  assert.match(
    workflowSha ?? "",
    /^[0-9a-f]{40}$/u,
    "--workflow-sha must be a full lowercase commit SHA",
  );
  return { allowFrozenSource, ref, repository, workflowSha };
}

function readTreeFile(repository, ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function listNativeConsumers(repository, ref) {
  try {
    return execFileSync(
      "git",
      [
        "grep",
        "-lE",
        "\\b(configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\\b|@openclaw/fs-safe/native",
        ref,
        "--",
        "src",
        "packages",
        "extensions",
      ],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch (error) {
    // git grep uses status 1 for no matches; any other malformed/unknown source
    // must keep the modern package proof required rather than silently omitting it.
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return "";
    }
    return undefined;
  }
}

export function resolveFsSafeNativeContract({ allowFrozenSource, ref, repository, workflowSha }) {
  const defaults = readTreeFile(repository, ref, "src/infra/fs-safe-defaults.ts");
  if (!allowFrozenSource || ref === workflowSha || !defaults) {
    return "required";
  }

  // A frozen source may omit this proof only when its canonical owner still
  // configures Python and its full product tree has no native fs-safe consumer.
  // Any current, unknown, or changed source keeps strict package verification.
  if (!defaults.includes(LEGACY_DEFAULTS_IMPORT) || NATIVE_CONSUMER_PATTERN.test(defaults)) {
    return "required";
  }

  return listNativeConsumers(repository, ref) === "" ? "not-applicable" : "required";
}

const options = parseArgs(process.argv.slice(2));
process.stdout.write(`${resolveFsSafeNativeContract(options)}\n`);
