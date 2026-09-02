import assert from "node:assert/strict";
import { mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DataIntegrityError } from "../src/errors.js";
import { loadManifest } from "../src/manifest.js";

const paginationRoot = fileURLToPath(
  new URL("./fixtures/synthetic/pagination/", import.meta.url)
);

async function writeManifest(value) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-manifest-"));
  const manifestPath = path.join(root, "manifest.json");
  const contents = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(manifestPath, contents);
  return { root, manifestPath };
}

function manifestFor(method, overrides = {}) {
  return {
    schemaVersion: 1,
    format: "columns-data",
    completion: { method },
    pages: [{ path: "page.json" }],
    ...overrides
  };
}

async function assertManifestRejected(value, pattern, markers = []) {
  const { manifestPath } = await writeManifest(value);
  await assert.rejects(loadManifest(manifestPath), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, pattern);
    for (const marker of markers) assert.equal(error.message.includes(marker), false);
    return true;
  });
}

test("accepts the synthetic drained two-page token-chain fixture", async () => {
  const manifest = await loadManifest(path.join(paginationRoot, "manifest.json"));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.format, "columns-data");
  assert.equal(manifest.completion.method, "all-page-tokens-consumed");
  assert.deepEqual(manifest.pages.map((page) => page.path), [
    path.join(paginationRoot, "page-1.json"),
    path.join(paginationRoot, "page-2.json")
  ]);
});

test("accepts a single page with explicit null token evidence", async () => {
  const value = manifestFor("single-page-no-continuation", {
    format: "auto",
    pages: [{ path: "single.json", requestToken: null, nextPageToken: null }]
  });
  const { root, manifestPath } = await writeManifest(value);

  const manifest = await loadManifest(manifestPath);

  assert.equal(manifest.pages[0].path, path.join(root, "single.json"));
  assert.equal(manifest.format, "auto");
});

test("accepts trusted connector saved-result evidence only when explicitly true", async () => {
  const value = manifestFor("connector-complete-saved-result", {
    format: "google-ads-results",
    completion: {
      method: "connector-complete-saved-result",
      savedResultWasComplete: true
    }
  });
  const { manifestPath } = await writeManifest(value);

  const manifest = await loadManifest(manifestPath);

  assert.equal(manifest.completion.savedResultWasComplete, true);
  assert.equal(manifest.pages.length, 1);
});

test("rejects malformed JSON without exposing its contents or path", async () => {
  const marker = "SYNTHETIC-MANIFEST-SECRET";
  await assertManifestRejected(`{\"pages\": [\"${marker}\"]`, /readable valid JSON/, [marker]);
});

test("rejects duplicate decoded manifest members at root and nested levels", async () => {
  const valid = JSON.stringify(manifestFor("connector-complete-saved-result", {
    completion: {
      method: "connector-complete-saved-result",
      savedResultWasComplete: true
    }
  }));
  const cases = [
    valid.replace(
      '"format":"columns-data"',
      '"format":"auto","format":"columns-data"'
    ),
    valid.replace(
      '"savedResultWasComplete":true',
      '"savedResultWasComplete":false,"savedResultWasComplete":true'
    ),
    valid.replace(
      '"path":"page.json"',
      '"path":"shadow.json","p\\u0061th":"page.json"'
    )
  ];

  for (const source of cases) {
    await assertManifestRejected(source, /readable valid JSON/, ["shadow.json"]);
  }
});

test("rejects unsupported manifest roots, schema versions, formats, and methods", async () => {
  const cases = [
    [[], /structure/],
    [{ ...manifestFor("single-page-no-continuation"), schemaVersion: 2 }, /schema version/],
    [{ ...manifestFor("single-page-no-continuation"), format: "csv" }, /format/],
    [manifestFor("SYNTHETIC-METHOD-SECRET"), /completion method/]
  ];

  for (const [value, pattern] of cases) {
    await assertManifestRejected(value, pattern, ["SYNTHETIC-METHOD-SECRET"]);
  }
});

test("rejects bare complete assertions at every manifest level", async () => {
  const cases = [
    { ...manifestFor("single-page-no-continuation"), complete: true },
    {
      ...manifestFor("single-page-no-continuation"),
      completion: { method: "single-page-no-continuation", complete: true }
    },
    {
      ...manifestFor("single-page-no-continuation"),
      pages: [{ path: "page.json", complete: true }]
    }
  ];

  for (const value of cases) await assertManifestRejected(value, /fields/);
});

test("rejects an empty pages list and malformed page entries", async () => {
  await assertManifestRejected(
    manifestFor("single-page-no-continuation", { pages: [] }),
    /pages/
  );
  await assertManifestRejected(
    manifestFor("single-page-no-continuation", { pages: [null] }),
    /page 1.*fields/
  );
});

test("rejects absolute and manifest-directory-escaping page paths", async () => {
  const cases = [
    ["/private/SYNTHETIC-ABSOLUTE-SECRET.json", /page 1.*path/],
    ["C:\\private\\SYNTHETIC-WINDOWS-SECRET.json", /page 1.*path/],
    ["../SYNTHETIC-ESCAPE-SECRET.json", /page 1.*manifest directory/],
    ["inside/../../SYNTHETIC-NORMALIZED-ESCAPE.json", /page 1.*manifest directory/]
  ];

  for (const [pagePath, pattern] of cases) {
    await assertManifestRejected(
      manifestFor("single-page-no-continuation", { pages: [{ path: pagePath }] }),
      pattern,
      [pagePath]
    );
  }
});

test("rejects an existing page symlink that escapes the manifest directory", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "lsa-manifest-outside-"));
  const marker = "SYNTHETIC-SYMLINK-TARGET-SECRET";
  const outsidePage = path.join(outside, `${marker}.json`);
  await writeFile(outsidePage, "{}");
  const value = manifestFor("single-page-no-continuation", {
    pages: [{ path: "linked.json" }]
  });
  const { root, manifestPath } = await writeManifest(value);
  await symlink(outsidePage, path.join(root, "linked.json"));

  await assert.rejects(loadManifest(manifestPath), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, /page 1.*manifest directory/);
    assert.equal(error.message.includes(marker), false);
    return true;
  });
});

test("rejects two page aliases that resolve to one physical target", async () => {
  const value = manifestFor("all-page-tokens-consumed", {
    pages: [
      { path: "one.json", requestToken: null, nextPageToken: "SYNTHETIC-ALIAS-TOKEN" },
      { path: "two.json", requestToken: "SYNTHETIC-ALIAS-TOKEN", nextPageToken: null }
    ]
  });
  const { root, manifestPath } = await writeManifest(value);
  await writeFile(path.join(root, "physical.json"), "{}");
  await symlink("physical.json", path.join(root, "one.json"));
  await symlink("physical.json", path.join(root, "two.json"));

  await assert.rejects(loadManifest(manifestPath), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, /page 2.*duplicate/);
    assert.equal(error.message.includes("SYNTHETIC-ALIAS-TOKEN"), false);
    return true;
  });
});

test("binds validated page content so a later symlink swap cannot change the read", async () => {
  const insideMarker = "SYNTHETIC-VALIDATED-INSIDE";
  const outsideMarker = "SYNTHETIC-SWAPPED-OUTSIDE";
  const outside = await mkdtemp(path.join(os.tmpdir(), "lsa-manifest-swap-"));
  const outsidePage = path.join(outside, "outside.json");
  await writeFile(outsidePage, JSON.stringify({ marker: outsideMarker }));
  const value = manifestFor("single-page-no-continuation", {
    pages: [{ path: "page.json", requestToken: null, nextPageToken: null }]
  });
  const { root, manifestPath } = await writeManifest(value);
  await writeFile(path.join(root, "inside.json"), JSON.stringify({ marker: insideMarker }));
  await symlink("inside.json", path.join(root, "page.json"));

  const manifest = await loadManifest(manifestPath);
  await symlink(outsidePage, path.join(root, "replacement.json"));
  await rename(path.join(root, "replacement.json"), path.join(root, "page.json"));
  const manifestModule = await import("../src/manifest.js");

  assert.equal(typeof manifestModule.readValidatedPage, "function");
  const validatedText = manifestModule.readValidatedPage(manifest.pages[0], 1);
  assert.equal(validatedText.includes(insideMarker), true);
  assert.equal(validatedText.includes(outsideMarker), false);
  assert.equal(JSON.stringify(manifest).includes(insideMarker), false);
});

test("does not expose an untrusted page-position argument in validated-page errors", async () => {
  const marker = "SYNTHETIC-PAGE-POSITION-SECRET";
  const manifestModule = await import("../src/manifest.js");

  assert.throws(() => manifestModule.readValidatedPage({}, marker), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, /input is unreadable/);
    assert.equal(error.message.includes(marker), false);
    return true;
  });
});

test("rejects missing, blank, and non-string page paths", async () => {
  for (const page of [{}, { path: "" }, { path: 7 }]) {
    await assertManifestRejected(
      manifestFor("single-page-no-continuation", { pages: [page] }),
      /page 1.*path/
    );
  }
});

test("rejects duplicate paths after resolving dot segments", async () => {
  const value = manifestFor("all-page-tokens-consumed", {
    pages: [
      { path: "nested/../page.json", requestToken: null, nextPageToken: "TOKEN-2" },
      { path: "page.json", requestToken: "TOKEN-2", nextPageToken: null }
    ]
  });

  await assertManifestRejected(value, /page 2.*duplicate/);
});

test("rejects single-page completion with multiple pages or a continuation", async () => {
  const cases = [
    [
      { path: "one.json", requestToken: null, nextPageToken: null },
      { path: "two.json", requestToken: null, nextPageToken: null }
    ],
    [{ path: "one.json", requestToken: null, nextPageToken: "SYNTHETIC-TOKEN-SECRET" }],
    [{ path: "one.json", requestToken: "SYNTHETIC-TOKEN-SECRET", nextPageToken: null }]
  ];

  for (const pages of cases) {
    await assertManifestRejected(
      manifestFor("single-page-no-continuation", { pages }),
      /single-page completion/,
      ["SYNTHETIC-TOKEN-SECRET"]
    );
  }
});

test("rejects single-page completion missing its own request-token field", async () => {
  await assertManifestRejected(
    manifestFor("single-page-no-continuation", {
      pages: [{ path: "one.json", nextPageToken: null }]
    }),
    /single-page completion/
  );
});

test("rejects single-page completion missing its own next-token field", async () => {
  await assertManifestRejected(
    manifestFor("single-page-no-continuation", {
      pages: [{ path: "one.json", requestToken: null }]
    }),
    /single-page completion/
  );
});

test("rejects token chains that do not start with a null request token", async () => {
  const value = manifestFor("all-page-tokens-consumed", {
    pages: [{
      path: "one.json",
      requestToken: "SYNTHETIC-START-TOKEN",
      nextPageToken: null
    }]
  });

  await assertManifestRejected(value, /start without a request token/, ["SYNTHETIC-START-TOKEN"]);
});

test("rejects unresolved and broken continuation-token chains", async () => {
  const cases = [
    {
      pages: [{
        path: "one.json",
        requestToken: null,
        nextPageToken: "SYNTHETIC-UNRESOLVED-TOKEN"
      }],
      pattern: /continuation token was not consumed/
    },
    {
      pages: [
        { path: "one.json", requestToken: null, nextPageToken: "SYNTHETIC-NEXT-TOKEN" },
        { path: "two.json", requestToken: "SYNTHETIC-WRONG-TOKEN", nextPageToken: null }
      ],
      pattern: /page 1.*continuation token was not consumed/
    }
  ];

  for (const { pages, pattern } of cases) {
    await assertManifestRejected(
      manifestFor("all-page-tokens-consumed", { pages }),
      pattern,
      ["SYNTHETIC-UNRESOLVED-TOKEN", "SYNTHETIC-NEXT-TOKEN", "SYNTHETIC-WRONG-TOKEN"]
    );
  }
});

test("rejects repeated continuation tokens even when adjacent links match", async () => {
  const value = manifestFor("all-page-tokens-consumed", {
    pages: [
      { path: "one.json", requestToken: null, nextPageToken: "SYNTHETIC-REPEATED-TOKEN" },
      {
        path: "two.json",
        requestToken: "SYNTHETIC-REPEATED-TOKEN",
        nextPageToken: "SYNTHETIC-REPEATED-TOKEN"
      },
      { path: "three.json", requestToken: "SYNTHETIC-REPEATED-TOKEN", nextPageToken: null }
    ]
  });

  await assertManifestRejected(value, /repeated continuation token/, ["SYNTHETIC-REPEATED-TOKEN"]);
});

test("rejects missing and malformed token fields for token-chain completion", async () => {
  const cases = [
    [{ path: "one.json", nextPageToken: null }],
    [{ path: "one.json", requestToken: null }],
    [{ path: "one.json", requestToken: null, nextPageToken: 7 }],
    [{ path: "one.json", requestToken: null, nextPageToken: "" }]
  ];

  for (const pages of cases) {
    await assertManifestRejected(
      manifestFor("all-page-tokens-consumed", { pages }),
      /page 1.*token fields/
    );
  }
});

test("rejects saved-result completion without exactly one trusted page", async () => {
  const base = manifestFor("connector-complete-saved-result", {
    completion: {
      method: "connector-complete-saved-result",
      savedResultWasComplete: true
    }
  });
  const cases = [
    { ...base, completion: { ...base.completion, savedResultWasComplete: false } },
    { ...base, completion: { ...base.completion, savedResultWasComplete: "true" } },
    { ...base, pages: [{ path: "one.json" }, { path: "two.json" }] },
    { ...base, pages: [{ path: "one.json", requestToken: null, nextPageToken: null }] }
  ];

  for (const value of cases) {
    await assertManifestRejected(value, /saved-result completion|page 1.*fields/);
  }
});

test("rejects saved-result evidence on another completion method", async () => {
  const value = manifestFor("single-page-no-continuation", {
    completion: {
      method: "single-page-no-continuation",
      savedResultWasComplete: true
    }
  });

  await assertManifestRejected(value, /completion fields/);
});
