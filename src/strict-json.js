function invalid() {
  throw new SyntaxError("Invalid JSON.");
}

export function parseStrictJson(source) {
  if (typeof source !== "string") invalid();
  let position = 0;

  function skipWhitespace() {
    while (position < source.length && /[\u0009\u000a\u000d\u0020]/.test(
      source[position]
    )) {
      position += 1;
    }
  }

  function parseString() {
    if (source[position] !== '"') invalid();
    const start = position;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        try {
          return JSON.parse(source.slice(start, position));
        } catch {
          invalid();
        }
      }
      if (character === "\\") {
        position += 1;
        if (position >= source.length) invalid();
        const escape = source[position];
        if (escape === "u") {
          const hex = source.slice(position + 1, position + 5);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) invalid();
        position += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) invalid();
      position += 1;
    }
    invalid();
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(position)
    );
    if (match === null) invalid();
    position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid();
    return value;
  }

  function parseArray() {
    position += 1;
    const result = [];
    skipWhitespace();
    if (source[position] === "]") {
      position += 1;
      return result;
    }
    while (position < source.length) {
      result.push(parseValue());
      skipWhitespace();
      if (source[position] === "]") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") invalid();
      position += 1;
      skipWhitespace();
    }
    invalid();
  }

  function parseObject() {
    position += 1;
    const result = {};
    const keys = new Set();
    skipWhitespace();
    if (source[position] === "}") {
      position += 1;
      return result;
    }
    while (position < source.length) {
      const key = parseString();
      if (keys.has(key)) invalid();
      keys.add(key);
      skipWhitespace();
      if (source[position] !== ":") invalid();
      position += 1;
      const value = parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
      skipWhitespace();
      if (source[position] === "}") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") invalid();
      position += 1;
      skipWhitespace();
    }
    invalid();
  }

  function parseValue() {
    skipWhitespace();
    const character = source[position];
    if (character === '"') return parseString();
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === "-" || (character >= "0" && character <= "9")) {
      return parseNumber();
    }
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ]) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return value;
      }
    }
    invalid();
  }

  const value = parseValue();
  skipWhitespace();
  if (position !== source.length) invalid();
  return value;
}
