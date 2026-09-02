import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli.js";

function memoryIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      out: (line) => stdout.push(String(line)),
      err: (line) => stderr.push(String(line))
    }
  };
}

test("no command returns usage exit code 2", async () => {
  const capture = memoryIo();
  assert.equal(await main([], capture.io), 2);
  assert.match(capture.stderr.join("\n"), /Usage: lsa-responsiveness/);
});

test("unknown command returns usage exit code 2", async () => {
  const capture = memoryIo();
  assert.equal(await main(["unknown"], capture.io), 2);
  assert.doesNotMatch(capture.stderr.join("\n"), /undefined|null/);
});
