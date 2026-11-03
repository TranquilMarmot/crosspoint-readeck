// Pure helpers for the Readeck plugin: no network or SD card access.

/** Directory that "books" are stored in when downloading them */
export const BOOK_DIR = "/Readeck";

/** When highlighting, they get saved here */
export const CLIPPINGS_PATH = "/My Clippings.txt";

/**
 * Trim the given URL, removing trailing slashes
 * @param {string} url
 * @returns {string}
 */
export function trimUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Whether a string is a complete http:// or https:// URL.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse a comma-separated list of labels into an array.
 * "a, b,,a" -> ["a", "b"]
 *
 * @param {string} labels
 * @returns {Array<string>}
 */
export function parseLabels(labels) {
  const parsed = labels
    .split(",")
    .map((label) => label.replace(/"/g, "").trim())
    .filter(Boolean);

  return [...new Set(parsed)];
}

/**
 * Readeck's labels filter takes search terms: -"x" excludes label x.
 * The result is already URL-encoded because device.json splices it into a query.
 *
 * @param {Array<string>} labels
 * @returns {string}
 */
export function excludeQuery(labels) {
  return encodeURIComponent(
    labels.map((label) => '-"' + label + '"').join(" "),
  );
}

/**
 * Get UTF-8 bytes of the given string
 * @param {string} s
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function utf8Bytes(s) {
  return new TextEncoder().encode(s);
}

/**
 * Base-64 encode the given string
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeBase64Utf8(value) {
  let binary = "";

  for (const byte of utf8Bytes(value)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * Mirrors the firmware's StringUtils::sanitizeFilenamePreservingExtension,
 * so a file synced here lands on the same path as one the device's catalog
 * downloads, and a second download replaces it instead of duplicating it.
 *
 * @param {string} name
 * @param {number} maxBytes
 * @returns {string}
 */
export function sanitizeFilename(name, maxBytes = 100) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const conventional =
    ext.length >= 2 && ext.length <= 16 && /^\.[A-Za-z0-9]+$/.test(ext);

  if (!conventional || ext.length >= maxBytes) {
    return sanitizeRange(name, maxBytes);
  }

  return sanitizeRange(name.slice(0, dot), maxBytes - ext.length) + ext;
}

/**
 * Sanitize a string up to the given number of bytes.
 *
 * @param {string} name
 * @param {number} maxBytes
 * @returns {string}
 */
export function sanitizeRange(name, maxBytes) {
  let s = name.replace(/^[ .]+/, "");
  let out = "";
  let bytes = 0;

  for (const ch of s) {
    const cp = ch.codePointAt(0);

    let piece;
    if ('/\\:*?"<>|'.includes(ch)) {
      piece = "_";
    } else if (cp >= 128 || (cp >= 32 && cp < 127)) {
      piece = ch;
    } else {
      // control characters are dropped
      continue;
    }

    const n = utf8Bytes(piece).length;

    if (bytes + n > maxBytes) {
      break;
    }

    out += piece;
    bytes += n;
  }

  out = out.replace(/[ .]+$/, "");

  return out || "book";
}

/**
 * Parses the Kindle-style "My Clippings.txt" the reader appends to:
 *    Title (Author)\n- Your Highlight on Page N | ...\n\ntext\n==========
 *
 * @param {string} text
 * @returns {Array<string>}
 */
export function parseClippings(text) {
  const out = [];

  let clipping = text.replace(/\r\n/g, "\n").split("\n==========\n");

  for (const block of clipping) {
    const lines = block
      .replace(/^\uFEFF/, "")
      .replace(/^\n+/, "")
      .split("\n");

    if (lines.length < 3 || !/^- /.test(lines[1])) {
      continue;
    }

    const head = lines[0];
    const open = head.lastIndexOf(" (");

    const title = open > 0 && head.endsWith(")") ? head.slice(0, open) : head;

    const body = lines
      .slice(2)
      .join("\n")
      .replace(/\n==========\s*$/, "")
      .trim();

    if (body) {
      out.push({ title: title.trim(), text: body });
    }
  }

  return out;
}

/**
 * Characters a reader drops or rewrites when it lays out text.
 * Soft hyphens and zero-width marks are removed.
 * Whitespace run becomes a space.
 */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/;
const SPACE = /\s/;
// The same characters for replace(). Kept separate because a regex with the
// g flag remembers its position between test() calls.
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "g");

/**
 * Drop invisible characters, collapse whitespace, trim ends.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  return String(s).replace(INVISIBLE_ALL, "").replace(/\s+/g, " ").trim();
}

/**
 * Text nodes under a node in document order (Readeck's getAllTextNodes).
 *
 * @param {Node} node
 * @returns {Array<Text>}
 */
export function textNodes(node) {
  // 4 is NodeFilter.SHOW_TEXT; Node.js, where the tests run, has no DOM globals.
  const walker = node.ownerDocument.createTreeWalker(node, 4);
  const out = [];

  while (walker.nextNode()) {
    out.push(walker.currentNode);
  }

  return out;
}

/**
 * Readeck's annotation selector for a text-node position.
 * The element path from root to the node's parent ("section[1]/p[3]"),
 * and the code-point offset counted over all text inside that parent (pkg/annotate getSelector).
 *
 * @param {Node} root
 * @param {Node} node
 * @param {number} offset
 * @returns {Object}
 */
export function selectorFor(root, node, offset) {
  const parts = [];

  for (
    let p = node.parentNode;
    p && p !== root && p.parentNode;
    p = p.parentNode
  ) {
    let i = 1;

    for (let s = p.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === p.localName) {
        i++;
      }
    }

    parts.unshift(p.localName + "[" + i + "]");
  }

  let before = 0;
  for (const t of textNodes(node.parentNode)) {
    if (t === node) {
      break;
    }

    // code points, as Readeck counts
    before += [...t.data].length;
  }

  return {
    selector: parts.join("/"),
    offset: before + offset,
  };
}

/**
 * Finds a clipping in the article and returns Readeck's annotation range, or null.
 * Matching ignores whitespace differences and invisible characters.
 * A case-insensitive pass catches small-caps or text-transform changes.
 *
 * @param {Node} root
 * @param {string} text
 * @returns {Object}
 */
export function locateHighlight(root, text) {
  const needle = Array.from(normalizeText(text));

  if (!needle.length) {
    return null;
  }

  const chars = [];
  const where = [];

  let space = false;
  for (const node of textNodes(root)) {
    let i = 0;
    for (const ch of node.data) {
      if (INVISIBLE.test(ch)) {
        i++;
        continue;
      }

      if (SPACE.test(ch)) {
        if (!space && chars.length) {
          chars.push(" ");
          where.push([node, i]);
        }

        space = true;
      } else {
        chars.push(ch);
        where.push([node, i]);

        space = false;
      }

      i++;
    }
  }

  const find = (fold) => {
    const f = fold ? (c) => c.toLowerCase() : (c) => c;
    const n = needle.map(f);
    const hay = fold ? chars.map(f) : chars;

    for (let i = 0; i + n.length <= hay.length; i++) {
      if (n.every((c, j) => hay[i + j] === c)) {
        return i;
      }
    }

    return -1;
  };

  let at = find(false);

  if (at < 0) {
    at = find(true);
  }

  if (at < 0) {
    return null;
  }

  const [startNode, startOff] = where[at];
  const [endNode, endOff] = where[at + needle.length - 1];
  const start = selectorFor(root, startNode, startOff);
  const end = selectorFor(root, endNode, endOff + 1);

  return {
    start_selector: start.selector,
    start_offset: start.offset,
    end_selector: end.selector,
    end_offset: end.offset,
  };
}

/**
 * Short stable key for "this highlight was already sent".
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 *
 * @param {string} id
 * @param {string} text
 * @returns {string}
 */
export function highlightKey(id, text) {
  let h = 0x811c9dc5;

  for (const b of utf8Bytes(normalizeText(text))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return id + ":" + h.toString(16);
}
