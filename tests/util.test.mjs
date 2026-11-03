import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { JSDOM } from "jsdom";

import * as Util from "../src/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const body = (html) => new JSDOM(html).window.document.body;

test("parseLabels trims, dedupes, and drops quotes and empties", () => {
  assert.deepEqual(Util.parseLabels(' eink, "long read" ,,eink, '), [
    "eink",
    "long read",
  ]);
  assert.deepEqual(Util.parseLabels(""), []);
});

test("isHttpUrl accepts only complete http and https URLs", () => {
  assert.equal(Util.isHttpUrl("https://readeck.example.com"), true);
  assert.equal(Util.isHttpUrl("http://192.168.0.31:8001/readeck"), true);
  assert.equal(Util.isHttpUrl("readeck.example.com"), false);
  assert.equal(Util.isHttpUrl("ftp://readeck.example.com"), false);
  assert.equal(Util.isHttpUrl("http://"), false);
});

test("normalizeText drops invisible characters and collapses whitespace", () => {
  assert.equal(Util.normalizeText("  a\u00ADb  c\n"), "ab c");
  assert.equal(Util.normalizeText("a \u00AD b"), "a b");
  assert.equal(Util.normalizeText("\uFEFF\u200Bx\t\ty\u2060 "), "x y");
  assert.equal(Util.normalizeText("\n\u00A0\n"), "");
});

test("excludeQuery builds an encoded Readeck label exclusion", () => {
  assert.equal(Util.excludeQuery([]), "");
  assert.equal(
    Util.excludeQuery(["skip", "long read"]),
    "-%22skip%22%20-%22long%20read%22",
  );
});

test("sanitizeFilename matches the firmware rules", () => {
  assert.equal(Util.sanitizeFilename('A/B: "C"?.epub'), "A_B_ _C__.epub");
  assert.equal(
    Util.sanitizeFilename("  ..Hidden title. .epub"),
    "Hidden title.epub",
  );
  assert.equal(Util.sanitizeFilename(".epub"), "epub");
  assert.equal(
    Util.sanitizeFilename("Tab\tand\nnewline.epub"),
    "Tabandnewline.epub",
  );

  const long = Util.sanitizeFilename("é".repeat(80) + ".epub");
  assert.ok(long.endsWith(".epub"));
  assert.ok(new TextEncoder().encode(long).length <= 100);
  assert.equal(long, "é".repeat(47) + ".epub"); // 47 * 2 bytes + 5 bytes <= 100
});

test("parseClippings reads the reader clippings file", () => {
  const file =
    "Electronic paper (en.wikipedia.org)\n- Your Highlight on Page 3 | History | Added on Monday, November 2, 2026, 09:15 AM\n\n" +
    "Electronic paper was first developed in the 1970s\n==========\n" +
    "Readability (Wikipedia)\n- Your Highlight on Page 1\n\nTwo\nlines\n==========\n" +
    "Broken entry\n==========\n";

  assert.deepEqual(Util.parseClippings(file), [
    {
      title: "Electronic paper",
      text: "Electronic paper was first developed in the 1970s",
    },
    { title: "Readability", text: "Two\nlines" },
  ]);
});

test(
  "selectorFor matches Readeck getSelector on its own fixture",
  { skip: !existsSync(fixturePath()) },
  () => {
    const doc = new JSDOM(readFileSync(fixturePath(), "utf8")).window.document;
    const root = doc.body;
    const text = (xpath) =>
      doc.evaluate(xpath, doc, null, 9, null).singleNodeValue;
    const cases = [
      ["/html/body/p[1]/text()[1]", 0, "p[1]", 0],
      ["/html/body/p[1]/text()[1]", 5, "p[1]", 5],
      ["/html/body/p[2]/text()[1]", 7, "p[2]", 7],
      ["/html/body/p[2]/text()[2]", 12, "p[2]", 30],
      [
        "/html/body/div[1]/p[2]/strong[1]/text()[2]",
        1,
        "div[1]/p[2]/strong[1]",
        27,
      ],
      ["/html/body/p[3]/text()[1]", 100, "p[3]", 100],
      ["/html/body/p[3]/text()[2]", 9, "p[3]", 182],
    ];

    for (const [xpath, offset, selector, expected] of cases) {
      assert.deepEqual(
        Util.selectorFor(root, text(xpath), offset),
        { selector, offset: expected },
        xpath,
      );
    }
  },
);

function fixturePath() {
  const src = process.env.READECK_SRC || path.join(here, "../../readeck");
  return path.join(src, "pkg/annotate/fixtures/test.html");
}

test("locateHighlight spans elements and ignores layout whitespace", () => {
  const root = body(
    "<section><h1>Title</h1><p>Hello <em>brave\n   new</em> world, it is soft­ware.</p><p>Again</p></section>",
  );

  assert.deepEqual(Util.locateHighlight(root, "brave new world"), {
    start_selector: "section[1]/p[1]/em[1]",
    start_offset: 0,
    end_selector: "section[1]/p[1]",
    end_offset: 24,
  });
  assert.deepEqual(Util.locateHighlight(root, "it is software"), {
    start_selector: "section[1]/p[1]",
    start_offset: 26,
    end_selector: "section[1]/p[1]",
    end_offset: 41,
  });
  assert.deepEqual(Util.locateHighlight(root, "AGAIN"), {
    start_selector: "section[1]/p[2]",
    start_offset: 0,
    end_selector: "section[1]/p[2]",
    end_offset: 5,
  });
  assert.equal(Util.locateHighlight(root, "not in the article"), null);
});

test("locateHighlight counts code points like Readeck", () => {
  const root = body("<p>Emoji 😀 then target text</p>");
  const r = Util.locateHighlight(root, "target");

  // "Emoji 😀 then " is 13 code points (14 UTF-16 units)
  assert.equal(r.start_offset, 13);
  assert.equal(r.end_offset, 19);
});

test("highlightKey ignores whitespace differences", () => {
  assert.equal(
    Util.highlightKey("abc", "one  two\nthree"),
    Util.highlightKey("abc", "one two three"),
  );
  assert.notEqual(
    Util.highlightKey("abc", "one"),
    Util.highlightKey("abd", "one"),
  );
});

test("device.json stays within the firmware manifest limit", () => {
  const raw = readFileSync(
    path.join(here, "../readeck.crosspoint-plugin/device.json"),
  );
  assert.ok(raw.length < 8192, "device.json is " + raw.length + " bytes");
  JSON.parse(raw);
});

test("manifest lists every payload file", () => {
  const dir = path.join(here, "../readeck.crosspoint-plugin");
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "manifest.json"), "utf8"),
  );

  assert.equal(manifest.name, "readeck");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  for (const f of manifest.files) {
    assert.ok(existsSync(path.join(dir, f)), f);
  }

  // Plugin Hub's MAX_DETAILS_SOURCE_BYTES
  assert.ok(readFileSync(path.join(dir, "DETAILS.md")).length <= 16 * 1024);
});
