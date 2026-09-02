import assert from "node:assert/strict";
import test from "node:test";

import { parseStrictJson } from "../src/strict-json.js";

test("parses ordinary JSON without allowing __proto__ to mutate prototypes", () => {
  const parsed = parseStrictJson(
    '{"__proto__":{"polluted":true},"nested":[{"safe":1}]}'
  );

  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.deepEqual(parsed.__proto__, { polluted: true });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(parsed.nested, [{ safe: 1 }]);
});

test("rejects duplicate decoded member names at every nesting depth", () => {
  const cases = [
    '{"value":1,"value":2}',
    '{"outer":{"value":1,"value":2}}',
    '{"items":[{"value":1,"value":2}]}',
    '{"value":1,"\\u0076alue":2}'
  ];

  for (const source of cases) {
    assert.throws(() => parseStrictJson(source), SyntaxError);
  }
});

test("rejects malformed, appended, and non-string input", () => {
  for (const source of ['{"value":', '{"value":1} trailing', 7]) {
    assert.throws(() => parseStrictJson(source), SyntaxError);
  }
});
