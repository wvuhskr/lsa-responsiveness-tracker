import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = path.join(
  packageRoot,
  ".agents/skills/lsa-responsiveness-tracker"
);
const expectedSkillFiles = [
  "SKILL.md",
  "references/connector-contract.md",
  "references/runbook.md"
];

async function relativeFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await relativeFiles(root, absolute));
    } else {
      files.push(path.relative(root, absolute));
    }
  }
  return files.sort();
}

function frontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(match, "skill frontmatter must be the first block");
  const entries = match[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  });
  return Object.fromEntries(entries);
}

function assertOrdered(source, patterns) {
  let previous = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    assert.ok(match, `missing ordered workflow concept ${pattern}`);
    assert.ok(match.index > previous, `${pattern} is out of order`);
    previous = match.index;
  }
}

test("portable skill layout and frontmatter are canonical", async () => {
  assert.deepEqual(await relativeFiles(skillRoot), expectedSkillFiles);
  const source = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const metadata = frontmatter(source);
  assert.deepEqual(Object.keys(metadata).sort(), ["description", "name"]);
  assert.equal(metadata.name, "lsa-responsiveness-tracker");
  assert.match(metadata.description, /^Use when\b/);
  assert.ok(metadata.description.length < 240);
});

test("skill is provider-neutral, public, and routes to both references", async () => {
  const sources = await Promise.all(expectedSkillFiles.map((file) =>
    readFile(path.join(skillRoot, file), "utf8")));
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /google-ads-download-report|mcp__|TrueClicks/i);
  assert.doesNotMatch(combined, /\/Users\/|[A-Z]:\\Users\\|\b(?:cron|RRULE)\b/i);
  assert.doesNotMatch(combined, /\b\d{10}\b/);

  const entrypoint = sources[0];
  assert.match(entrypoint, /references\/connector-contract\.md/);
  assert.match(entrypoint, /references\/runbook\.md/);
  assert.match(entrypoint, /aggregation-only[^.]*unsupported/i);
});

test("skill preserves the required fail-closed workflow ordering", async () => {
  const source = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assertOrdered(source, [
    /discover[^\n]*capabilit/i,
    /inspect[^\n]*schema/i,
    /(?:list|identify)[^\n]*account/i,
    /access probe/i,
    /field probe/i,
    /(?:drain|complete saved result)/i,
    /\bprobe\b[^\n]*CLI/i,
    /\breport\b[^\n]*CLI/i
  ]);
  assert.match(source, /never calculate[^.]*fallback/i);
  assert.match(source, /never[^.]*real rows[^.]*chat/i);
  assert.match(source, /never[^.]*credentials/i);
  assert.match(source, /stop[^.]*incomplete|incomplete[^.]*stop/i);
  assert.match(source, /proxy[^.]*not[^.]*official/i);
  assert.match(source, /phone[^.]*approximate/i);
});

test("connector contract matches the frozen ingestion boundary", async () => {
  const source = await readFile(
    path.join(skillRoot, "references/connector-contract.md"),
    "utf8"
  );
  const requiredFields = [
    "local_services_lead.id",
    "local_services_lead.lead_type",
    "local_services_lead_conversation.participant_type",
    "local_services_lead_conversation.conversation_channel",
    "local_services_lead_conversation.phone_call_details.call_duration_millis",
    "local_services_lead_conversation.event_date_time"
  ];
  for (const field of requiredFields) {
    assert.equal(source.includes(`\`${field}\``), true, `missing ${field}`);
  }
  assert.match(
    source,
    /`local_services_lead_conversation\.message_details\.text`[^\n]*optional/i
  );
  for (const envelope of ["columns-data", "google-ads-results"]) {
    assert.match(source, new RegExp(`\\b${envelope}\\b`));
  }
  for (const method of [
    "single-page-no-continuation",
    "all-page-tokens-consumed",
    "connector-complete-saved-result"
  ]) {
    assert.match(source, new RegExp(method));
  }
  assert.match(source, /returned `columns`[^.]*dynamically/i);
  assert.match(source, /manifest[^.]*trust boundary/i);
  assert.match(source, /final[^.]*nextPageToken[^.]*null/i);
  assert.match(source, /savedResultWasComplete[^.]*true/);
});

test("runbook defines CLI resolution, private handling, exits, and recovery", async () => {
  const source = await readFile(
    path.join(skillRoot, "references/runbook.md"),
    "utf8"
  );
  assert.match(source, /installation\.json/);
  assert.match(source, /\.\.\/\.\.\/\.\.\/bin\/lsa-responsiveness\.js/);
  assert.match(source, /mode `0700`/);
  assert.match(source, /mode `0600`/);
  for (const code of [0, 1, 2, 3, 4, 5]) {
    assert.match(source, new RegExp(`\\| ${code} \\|`));
  }
  assert.match(source, /exit `3`[^.]*different connector|different connector[^.]*exit `3`/i);
  assert.match(source, /exit `4`[^.]*re-export|re-export[^.]*exit `4`/i);
  assert.match(source, /do not continue|stop/i);
});

test("README, examples, and package metadata advertise only real release behavior", async () => {
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  const license = await readFile(path.join(packageRoot, "LICENSE"), "utf8");
  const security = await readFile(path.join(packageRoot, "SECURITY.md"), "utf8");
  const changelog = await readFile(path.join(packageRoot, "CHANGELOG.md"), "utf8");
  assert.match(readme, /any[^.]*raw GAQL/i);
  assert.match(readme, /aggregation-only[^.]*unsupported/i);
  assert.match(readme, /Node\.js[^\n]*20/i);
  assert.match(readme, /node \.\/bin\/lsa-responsiveness\.js demo --output-dir/);
  assert.match(readme, /node \.\/bin\/lsa-responsiveness\.js probe --input/);
  assert.match(readme, /node \.\/bin\/lsa-responsiveness\.js report --config/);
  assert.match(readme, /node \.\/scripts\/install-skill\.mjs install --platform/);
  assert.match(readme, /Performance Max[^.]*pay-per-lead/i);
  assert.match(readme, /expected to continue working/i);
  assert.match(readme, /not a guarantee[^.]*compatibility/i);
  assert.match(readme, /not yet been validated[^.]*confirmed migrated account/i);
  assert.doesNotMatch(readme, /\b(?:will|won't|will not) be unaffected\b/i);
  assert.match(readme, /same-user[^.]*pathname race/i);
  assert.match(readme, /not cryptographic proof/i);
  assert.match(readme, /Node 24[^.]*Node 20[^.]*CI/i);
  assert.match(readme, /Scheduling[^.]*not included/i);
  assert.match(readme, /github\.com\/wvuhskr\/lsa-responsiveness-tracker/);
  assert.match(readme, /Current release[^\n]*1\.0\.0/);
  assert.match(readme, /\[SECURITY\.md\]\(SECURITY\.md\)/);
  assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/);
  assert.doesNotMatch(readme, /publication[^.]*deferred/i);
  assert.match(readme, /MIT\. Copyright \(c\) 2026 Alex Murtha/);
  assert.doesNotMatch(readme, /\/Users\/|Winter Haven|TrueClicks/i);

  assert.match(license, /^MIT License\n\n/);
  assert.match(license, /Copyright \(c\) 2026 Alex Murtha/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.doesNotMatch(license, /Iceberg Cooling/);

  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /Do not open a public issue/i);
  assert.match(security, /synthetic fixtures/i);
  assert.doesNotMatch(security, /\/Users\/|Winter Haven|TrueClicks|\b\d{10}\b/i);

  assert.match(changelog, /\[1\.0\.0\] - 2026-09-01/);
  assert.match(changelog, /lsa-responsiveness\/v1/);
  assert.doesNotMatch(changelog, /\/Users\/|Winter Haven|TrueClicks|\b\d{10}\b/i);

  const config = JSON.parse(await readFile(
    path.join(packageRoot, "examples/config.example.json"),
    "utf8"
  ));
  assert.equal(config.privacy.includeLeadIds, false);
  assert.equal(config.privacy.includeMessageText, false);
  assert.equal(config.accounts.length, 1);
  assert.match(config.accounts[0].name, /^Example\b/);

  const packageJson = JSON.parse(await readFile(
    path.join(packageRoot, "package.json"),
    "utf8"
  ));
  for (const target of Object.values(packageJson.bin)) {
    assert.equal((await stat(path.join(packageRoot, target))).isFile(), true);
  }
  for (const command of Object.values(packageJson.scripts)) {
    const match = /^node ([^ ]+)/.exec(command);
    if (match && !match[1].startsWith("-")) {
      assert.equal((await stat(path.join(packageRoot, match[1]))).isFile(), true);
    }
  }
  assert.ok(packageJson.files.includes(".agents/"));
  assert.ok(packageJson.files.includes("docs/"));
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.ok(packageJson.files.includes("LICENSE"));
  assert.ok(packageJson.files.includes("SECURITY.md"));
  assert.ok(packageJson.files.includes("scripts/install-skill.mjs"));
  assert.equal(packageJson.author, "Alex Murtha");
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/wvuhskr/lsa-responsiveness-tracker.git"
  );
  assert.equal(
    packageJson.homepage,
    "https://github.com/wvuhskr/lsa-responsiveness-tracker#readme"
  );
  assert.equal(
    packageJson.bugs.url,
    "https://github.com/wvuhskr/lsa-responsiveness-tracker/issues"
  );
  assert.equal((await stat(path.join(
    packageRoot, "docs/LSA-MIGRATION.md"
  ))).isFile(), true);
  assert.equal((await stat(path.join(packageRoot, "LICENSE"))).isFile(), true);
  assert.equal((await stat(path.join(packageRoot, "CHANGELOG.md"))).isFile(), true);
  assert.equal((await stat(path.join(packageRoot, "README.md"))).isFile(), true);
  assert.equal((await stat(path.join(packageRoot, "SECURITY.md"))).isFile(), true);
});
