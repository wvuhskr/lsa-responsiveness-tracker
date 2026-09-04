import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { DataIntegrityError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";

const COMPLETION_METHODS = new Set([
  "single-page-no-continuation",
  "all-page-tokens-consumed",
  "connector-complete-saved-result"
]);
const FORMATS = new Set(["auto", "columns-data", "google-ads-results"]);
const MANIFEST_KEYS = new Set(["schemaVersion", "format", "completion", "pages", "source"]);
const TOKEN_PAGE_KEYS = new Set(["path", "requestToken", "nextPageToken"]);
const SAVED_RESULT_PAGE_KEYS = new Set(["path"]);
const VALIDATED_PAGE_CONTENTS = new WeakMap();

function fail(message) {
  throw new DataIntegrityError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function tokenIsValid(token) {
  return token === null || (typeof token === "string" && token.length > 0);
}

function resolvedPagePath(manifestDirectory, pagePath, pageNumber) {
  if (typeof pagePath !== "string" || pagePath.length === 0 ||
      pagePath.includes("\0") || path.isAbsolute(pagePath) ||
      path.win32.isAbsolute(pagePath)) {
    fail(`Manifest page ${pageNumber} path is invalid.`);
  }

  const resolved = path.resolve(manifestDirectory, pagePath);
  const relative = path.relative(manifestDirectory, resolved);
  if (relative === "" || relative === ".." ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Manifest page ${pageNumber} path must stay within the manifest directory.`);
  }
  return resolved;
}

function validateCompletionFields(completion, method) {
  const allowed = method === "connector-complete-saved-result"
    ? new Set(["method", "savedResultWasComplete"])
    : new Set(["method"]);
  if (!hasOnlyKeys(completion, allowed)) {
    fail("Manifest completion fields are invalid.");
  }
}

function normalizePages(rawPages, manifestDirectory, method) {
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    fail("Manifest pages are invalid.");
  }

  const allowedKeys = method === "connector-complete-saved-result"
    ? SAVED_RESULT_PAGE_KEYS
    : TOKEN_PAGE_KEYS;
  const seenPaths = new Set();
  return rawPages.map((page, index) => {
    const pageNumber = index + 1;
    if (!isRecord(page) || !hasOnlyKeys(page, allowedKeys)) {
      fail(`Manifest page ${pageNumber} fields are invalid.`);
    }

    const resolved = resolvedPagePath(manifestDirectory, page.path, pageNumber);
    if (seenPaths.has(resolved)) {
      fail(`Manifest page ${pageNumber} path is duplicated.`);
    }
    seenPaths.add(resolved);
    return { ...page, path: resolved };
  });
}

async function bindExistingPageTargets(pages, manifestDirectory) {
  let realManifestDirectory;
  try {
    realManifestDirectory = await realpath(manifestDirectory);
  } catch {
    fail("Manifest directory is invalid.");
  }

  const seenPhysicalTargets = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    const pageNumber = index + 1;
    const validatedPage = { pageNumber, text: undefined };
    VALIDATED_PAGE_CONTENTS.set(pages[index], validatedPage);
    let realPagePath;
    try {
      realPagePath = await realpath(pages[index].path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail(`Manifest page ${pageNumber} target is unreadable.`);
    }
    const relative = path.relative(realManifestDirectory, realPagePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
      fail(`Manifest page ${pageNumber} path must stay within the manifest directory.`);
    }

    let handle;
    try {
      handle = await open(realPagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat({ bigint: true });
      const physicalTarget = `${stats.dev}:${stats.ino}`;
      if (seenPhysicalTargets.has(physicalTarget)) {
        fail(`Manifest page ${pageNumber} physical target is duplicated.`);
      }
      seenPhysicalTargets.add(physicalTarget);
      validatedPage.text = await handle.readFile("utf8");
    } catch (error) {
      if (error instanceof DataIntegrityError) throw error;
      fail(`Manifest page ${pageNumber} target is unreadable.`);
    } finally {
      try {
        await handle?.close();
      } catch {
        // Never replace a sanitized validation result with a path-bearing close error.
      }
    }
  }
}

function validateSinglePage(pages) {
  if (pages.length !== 1 ||
      !Object.hasOwn(pages[0], "requestToken") ||
      !Object.hasOwn(pages[0], "nextPageToken") ||
      pages[0].requestToken !== null || pages[0].nextPageToken !== null) {
    fail("Manifest single-page completion is invalid.");
  }
}

function validateTokenChain(pages) {
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const pageNumber = index + 1;
    if (!Object.hasOwn(page, "requestToken") ||
        !Object.hasOwn(page, "nextPageToken") ||
        !tokenIsValid(page.requestToken) || !tokenIsValid(page.nextPageToken)) {
      fail(`Manifest page ${pageNumber} token fields are invalid.`);
    }
  }

  if (pages[0].requestToken !== null) {
    fail("Manifest token chain must start without a request token.");
  }

  const seenContinuationTokens = new Set();
  for (let index = 0; index < pages.length - 1; index += 1) {
    const token = pages[index].nextPageToken;
    if (token === null || token !== pages[index + 1].requestToken) {
      fail(`Manifest page ${index + 1} continuation token was not consumed.`);
    }
    if (seenContinuationTokens.has(token)) {
      fail(`Manifest page ${index + 1} has a repeated continuation token.`);
    }
    seenContinuationTokens.add(token);
  }

  if (pages.at(-1).nextPageToken !== null) {
    fail(`Manifest page ${pages.length} continuation token was not consumed.`);
  }
}

function validateSavedResult(completion, pages) {
  if (completion.savedResultWasComplete !== true || pages.length !== 1) {
    fail("Manifest saved-result completion is invalid.");
  }
}

export function readValidatedPage(page) {
  const validatedPage = VALIDATED_PAGE_CONTENTS.get(page);
  if (validatedPage?.text === undefined) {
    if (validatedPage) {
      fail(`Page ${validatedPage.pageNumber}: input is unreadable.`);
    }
    fail("Page input is unreadable.");
  }
  return validatedPage.text;
}

export async function loadManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  let raw;
  try {
    raw = parseStrictJson(await readFile(absoluteManifestPath, "utf8"));
  } catch {
    fail("Manifest must be readable valid JSON.");
  }

  if (!isRecord(raw)) fail("Manifest has an invalid structure.");
  if (!hasOnlyKeys(raw, MANIFEST_KEYS)) fail("Manifest fields are invalid.");
  if (raw.schemaVersion !== 1) fail("Manifest has an unsupported schema version.");
  if (!FORMATS.has(raw.format)) fail("Manifest has an unsupported format.");
  if (raw.source !== undefined && (!isRecord(raw.source) ||
      !hasOnlyKeys(raw.source, new Set(["customerId", "selectedFields"])) ||
      !/^\d{10}$/.test(raw.source.customerId ?? "") ||
      typeof raw.source.customerId !== "string" ||
      (raw.source.selectedFields !== undefined &&
        (!Array.isArray(raw.source.selectedFields) ||
         !raw.source.selectedFields.every((field) => typeof field === "string") ||
         new Set(raw.source.selectedFields).size !== raw.source.selectedFields.length)))) {
    fail("Manifest source evidence is invalid.");
  }
  if (!isRecord(raw.completion) ||
      !COMPLETION_METHODS.has(raw.completion.method)) {
    fail("Manifest completion method is invalid.");
  }

  const method = raw.completion.method;
  validateCompletionFields(raw.completion, method);
  const pages = normalizePages(
    raw.pages,
    path.dirname(absoluteManifestPath),
    method
  );
  await bindExistingPageTargets(pages, path.dirname(absoluteManifestPath));
  if (method === "single-page-no-continuation") validateSinglePage(pages);
  if (method === "all-page-tokens-consumed") validateTokenChain(pages);
  if (method === "connector-complete-saved-result") {
    validateSavedResult(raw.completion, pages);
  }

  return {
    schemaVersion: 1,
    format: raw.format,
    completion: { ...raw.completion },
    ...(raw.source === undefined ? {} : { source: raw.source }),
    pages
  };
}
