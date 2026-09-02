import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const installer = path.join(packageRoot, "scripts/install-skill.mjs");
const sourceSkill = path.join(
  packageRoot,
  ".agents/skills/lsa-responsiveness-tracker"
);
const skillName = "lsa-responsiveness-tracker";
const payloads = [
  "SKILL.md",
  "references/connector-contract.md",
  "references/runbook.md"
];

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-skill-installer-"));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { mode: 0o700 });
  await mkdir(project, { mode: 0o700 });
  return { root, home, project };
}

function runInstaller(args, area) {
  const result = spawnSync(process.execPath, [installer, ...args], {
    cwd: area.project,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: area.home,
      USERPROFILE: area.home
    },
    timeout: 20_000
  });
  if (result.error) throw result.error;
  return result;
}

function projectDestination(project, platform) {
  const prefix = platform === "claude" ? ".claude" : ".agents";
  return path.join(project, prefix, "skills", skillName);
}

function userDestination(home, platform) {
  if (platform === "codex") return path.join(home, ".codex/skills", skillName);
  if (platform === "claude") return path.join(home, ".claude/skills", skillName);
  return path.join(home, ".config/opencode/skills", skillName);
}

async function pathIsAbsent(target) {
  await assert.rejects(lstat(target), { code: "ENOENT" });
}

async function installedFiles(destination) {
  const root = (await readdir(destination)).sort();
  const references = (await readdir(path.join(destination, "references"))).sort();
  return { root, references };
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function assertReceipt(destination) {
  const receipt = JSON.parse(await readFile(
    path.join(destination, "installation.json"),
    "utf8"
  ));
  assert.deepEqual(Object.keys(receipt).sort(), [
    "cliEntry", "files", "product", "schemaVersion", "sourceSkill", "version"
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.product, "lsa-responsiveness-tracker");
  assert.equal(receipt.version, "1.0.0");
  assert.equal(path.isAbsolute(receipt.cliEntry), true);
  assert.equal(path.isAbsolute(receipt.sourceSkill), true);
  assert.equal(receipt.sourceSkill, sourceSkill);
  assert.deepEqual(receipt.files.map(({ path: relative }) => relative), payloads);
  for (const record of receipt.files) {
    assert.deepEqual(Object.keys(record).sort(), ["path", "sha256"]);
    assert.equal(record.sha256, await sha256(path.join(destination, record.path)));
    assert.equal(record.sha256, await sha256(path.join(sourceSkill, record.path)));
  }
  assert.equal(JSON.stringify(receipt).includes("customerId"), false);
  assert.equal(JSON.stringify(receipt).includes("query"), false);
}

test("install dry-run performs complete preflight without mutation", async (t) => {
  const area = await workspace(t);
  const destination = projectDestination(area.project, "codex");
  const result = runInstaller([
    "install", "--platform", "codex", "--scope", "project",
    "--project", area.project, "--dry-run"
  ], area);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Skill installation preflight passed; no files written.\n");
  assert.equal(result.stderr, "");
  await pathIsAbsent(destination);
  assert.deepEqual(await readdir(area.project), []);
});

test("all supported project mappings install only canonical payloads and receipt", async (t) => {
  const area = await workspace(t);
  for (const platform of ["agents", "codex", "cursor", "opencode", "gemini", "claude"]) {
    const project = path.join(area.root, `project-${platform}`);
    await mkdir(project, { mode: 0o700 });
    const result = runInstaller([
      "install", "--platform", platform, "--scope", "project",
      "--project", project
    ], area);
    const destination = projectDestination(project, platform);
    assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
    assert.equal(result.stdout, "Skill installed.\n");
    assert.deepEqual(await installedFiles(destination), {
      root: ["SKILL.md", "installation.json", "references"],
      references: ["connector-contract.md", "runbook.md"]
    });
    await assertReceipt(destination);
  }
});

test("supported user mappings stay inside the supplied fake home", async (t) => {
  const area = await workspace(t);
  for (const platform of ["codex", "claude", "opencode"]) {
    const result = runInstaller([
      "install", "--platform", platform, "--scope", "user"
    ], area);
    const destination = userDestination(area.home, platform);
    assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
    await assertReceipt(destination);
  }

  for (const platform of ["agents", "cursor", "gemini"]) {
    const before = await readdir(area.home, { recursive: true });
    const result = runInstaller([
      "install", "--platform", platform, "--scope", "user"
    ], area);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unsupported platform and scope combination.\n");
    assert.deepEqual(await readdir(area.home, { recursive: true }), before);
  }
});

test("argument and collision preflight failures mutate nothing and reveal no paths", async (t) => {
  const area = await workspace(t);
  const malformed = runInstaller([
    "install", "--platform", "codex", "--scope", "project"
  ], area);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stderr.includes(area.root), false);
  assert.deepEqual(await readdir(area.project), []);

  const destination = projectDestination(area.project, "codex");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const marker = path.join(destination, "unrelated.txt");
  await writeFile(marker, "SYNTHETIC UNRELATED INSTALL COLLISION\n", { mode: 0o600 });
  const collision = runInstaller([
    "install", "--platform", "codex", "--scope", "project",
    "--project", area.project
  ], area);
  assert.equal(collision.status, 5);
  assert.equal(collision.stdout, "");
  assert.equal(collision.stderr, "Skill installation target is not empty.\n");
  assert.equal(collision.stderr.includes(area.root), false);
  assert.equal(
    await readFile(marker, "utf8"),
    "SYNTHETIC UNRELATED INSTALL COLLISION\n"
  );
  await pathIsAbsent(path.join(destination, "installation.json"));
});

test("uninstall dry-run is inert and ordinary uninstall removes an unchanged receipt", async (t) => {
  const area = await workspace(t);
  const args = [
    "--platform", "codex", "--scope", "project", "--project", area.project
  ];
  assert.equal(runInstaller(["install", ...args], area).status, 0);
  const destination = projectDestination(area.project, "codex");
  const before = await readFile(path.join(destination, "installation.json"));

  const dryRun = runInstaller(["uninstall", ...args, "--dry-run"], area);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.stdout, "Skill removal preflight passed; no files removed.\n");
  assert.deepEqual(
    await readFile(path.join(destination, "installation.json")),
    before
  );

  const removed = runInstaller(["uninstall", ...args], area);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout, "Skill uninstalled.\n");
  await pathIsAbsent(destination);
});

test("uninstall preserves modified payloads unless force removal is explicit", async (t) => {
  const area = await workspace(t);
  const args = [
    "--platform", "claude", "--scope", "project", "--project", area.project
  ];
  assert.equal(runInstaller(["install", ...args], area).status, 0);
  const destination = projectDestination(area.project, "claude");
  const skillPath = path.join(destination, "SKILL.md");
  const modified = "SYNTHETIC LOCALLY MODIFIED SKILL\n";
  await writeFile(skillPath, modified, { mode: 0o600 });

  const refused = runInstaller(["uninstall", ...args], area);
  assert.equal(refused.status, 5);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "Installed skill files were modified; removal refused.\n");
  assert.equal(refused.stderr.includes(area.root), false);
  assert.equal(await readFile(skillPath, "utf8"), modified);
  assert.equal((await stat(path.join(destination, "installation.json"))).isFile(), true);

  const forced = runInstaller([
    "uninstall", ...args, "--force-remove-modified"
  ], area);
  assert.equal(forced.status, 0, forced.stderr);
  await pathIsAbsent(destination);
});

test("uninstall is receipt-scoped and preserves unrelated destination files", async (t) => {
  const area = await workspace(t);
  const args = [
    "--platform", "opencode", "--scope", "project", "--project", area.project
  ];
  assert.equal(runInstaller(["install", ...args], area).status, 0);
  const destination = projectDestination(area.project, "opencode");
  const rootExtra = path.join(destination, "local-notes.md");
  const referenceExtra = path.join(destination, "references", "local-reference.md");
  await writeFile(rootExtra, "SYNTHETIC UNRELATED ROOT FILE\n", { mode: 0o600 });
  await writeFile(referenceExtra, "SYNTHETIC UNRELATED REFERENCE\n", { mode: 0o600 });

  const removed = runInstaller(["uninstall", ...args], area);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(await readFile(rootExtra, "utf8"), "SYNTHETIC UNRELATED ROOT FILE\n");
  assert.equal(
    await readFile(referenceExtra, "utf8"),
    "SYNTHETIC UNRELATED REFERENCE\n"
  );
  for (const relative of [...payloads, "installation.json"]) {
    await pathIsAbsent(path.join(destination, relative));
  }
});
