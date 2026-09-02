import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const cliPath = fileURLToPath(
  new URL("../../bin/lsa-responsiveness.js", import.meta.url)
);
const cliModuleUrl = new URL("../../src/cli.js", import.meta.url).href;
const outputWriterModuleUrl = new URL(
  "../../src/write-output.js",
  import.meta.url
).href;

function runRestrictiveUmaskSource(source, options = {}) {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `process.umask(0o777);\n${source}`
  ], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 20_000
  });
  if (result.error) throw result.error;
  return result;
}

export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 20_000
  });
  if (result.error) throw result.error;
  return result;
}

export function runCliWithRestrictiveUmask(args, options = {}) {
  return runRestrictiveUmaskSource(
    `const { main } = await import(${JSON.stringify(cliModuleUrl)});\n` +
      `process.exitCode = await main(${JSON.stringify(args)});`,
    options
  );
}

export function runDemoWithRestrictiveUmaskAudit(args, options = {}) {
  const auditSource = [
    'const fsPromises = (await import("node:fs/promises")).default;',
    'const path = (await import("node:path")).default;',
    'const { syncBuiltinESMExports } = await import("node:module");',
    "const originalRm = fsPromises.rm;",
    "fsPromises.rm = async (candidate, rmOptions) => {",
    "  if (path.basename(candidate).startsWith(\"lsa-responsiveness-demo-\")) {",
    "    const modes = { directory: (await fsPromises.stat(candidate)).mode & 0o777, files: {} };",
    "    for (const name of (await fsPromises.readdir(candidate)).sort()) {",
    "      modes.files[name] = (await fsPromises.stat(path.join(candidate, name))).mode & 0o777;",
    "    }",
    "    process.stdout.write(`UMASK-AUDIT ${JSON.stringify(modes)}\\n`);",
    "  }",
    "  return originalRm(candidate, rmOptions);",
    "};",
    "syncBuiltinESMExports();",
    `const { main } = await import(${JSON.stringify(cliModuleUrl)});`,
    `process.exitCode = await main(${JSON.stringify(args)});`
  ].join("\n");
  return runRestrictiveUmaskSource(auditSource, options);
}

export function runOutputWriterWithRestrictiveUmask(
  destination,
  reportModel,
  options = {}
) {
  return runRestrictiveUmaskSource(
    `const { writeOutputBundle } = await import(${JSON.stringify(outputWriterModuleUrl)});\n` +
      `await writeOutputBundle(${JSON.stringify(destination)}, ` +
      `${JSON.stringify(reportModel)});`,
    options
  );
}
