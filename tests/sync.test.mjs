import { test } from "node:test";
import assert from "node:assert/strict";

import { DIR, SERVER, fakeDevice, signedIn } from "./fake-device.mjs";
import { createContext } from "../src/storage.js";
import { sync as runSync } from "../src/sync.js";
import { CLIPPINGS_PATH, excludeQuery, highlightKey } from "../src/util.js";

const STATE_PATH = DIR + "/state.json";

/** One Readeck article already downloaded to the SD card. */
const onDevice = {
  "/Readeck/Article One.epub": "epub",
  "/Readeck/Article One.epub.meta.json": { readeck_id: "b1" },
};

const clipping = (title, text) =>
  title +
  " (example.com)\n- Your Highlight on Page 1 | Added on Monday\n\n" +
  text +
  "\n==========\n";

const ARTICLE = "<section><p>Hello brave new world, again.</p></section>";

async function setup({ config, files = {}, routes = {}, remote = {} } = {}) {
  const dev = fakeDevice({
    files: { ...signedIn(config), ...files },
    routes: {
      "GET /bookmarks": (req) =>
        req.query.getAll("id").includes("b1")
          ? { data: [{ id: "b1", title: "Article One" }] }
          : { data: [] },
      ...routes,
    },
    remote: { [SERVER + "/api/bookmarks/b1/article"]: ARTICLE, ...remote },
  });
  const ctx = await createContext(dev.api);
  const lines = [];
  return { dev, ctx, lines, sync: () => runSync(ctx, (l) => lines.push(l)) };
}

test("sync needs a server and a token", async () => {
  const dev = fakeDevice({
    files: { [DIR + "/config.json"]: { server: SERVER } },
  });

  await assert.rejects(
    runSync(await createContext(dev.api), () => {}),
    /sign in to Readeck first/,
  );
  assert.equal(dev.calls.length, 0);
});

test("sync downloads new, loaded articles with an auto label", async () => {
  const { dev, lines, sync } = await setup({
    config: { auto_labels: "eink", exclude_labels: excludeQuery(["skip"]) },
    files: onDevice,
    routes: {
      "GET /bookmarks": (req) => {
        if (!req.query.get("labels")) {
          return { data: [] };
        }
        return {
          data: [
            { id: "b1", title: "Article One", loaded: true },
            { id: "b2", title: "Still loading", loaded: false },
            { id: "b3", title: 'New: "one"', loaded: true },
          ],
        };
      },
    },
    remote: { [SERVER + "/api/bookmarks/b3/article.epub"]: "epub3" },
  });

  const r = await sync();

  assert.deepEqual(r, { downloaded: 1, highlights: 0, archived: 0 });
  assert.equal(
    dev.callsTo("GET", "/bookmarks")[0].query.get("labels"),
    '"eink" -"skip"',
  );
  assert.deepEqual(dev.fetched, [
    {
      url: SERVER + "/api/bookmarks/b3/article.epub",
      dest: "/Readeck/New_ _one_.epub",
      headers: { Authorization: "Bearer tok" },
    },
  ]);
  assert.deepEqual(dev.json("/Readeck/New_ _one_.epub.meta.json"), {
    readeck_id: "b3",
  });
  assert.deepEqual(lines, ['Downloaded New: "one"']);
});

test("sync sends a new highlight once", async () => {
  const posted = [];
  const { dev, sync } = await setup({
    files: {
      ...onDevice,
      [CLIPPINGS_PATH]: clipping("Article One", "brave new world"),
    },
    routes: {
      "GET /bookmarks/b1/annotations": { data: [] },
      "POST /bookmarks/b1/annotations": (req) => {
        posted.push(req.body);
        return { status: 201, data: {} };
      },
    },
  });

  assert.equal((await sync()).highlights, 1);
  assert.deepEqual(posted, [
    {
      start_selector: "section[1]/p[1]",
      start_offset: 6,
      end_selector: "section[1]/p[1]",
      end_offset: 21,
      color: "yellow",
    },
  ]);
  assert.deepEqual(dev.json(STATE_PATH), {
    sent: [highlightKey("b1", "brave new world")],
  });

  // The second sync finds the key in state.json and asks Readeck nothing.
  assert.equal((await sync()).highlights, 0);
  assert.equal(posted.length, 1);
  assert.equal(dev.callsTo("GET", "/bookmarks/b1/annotations").length, 1);
});

test("sync records highlights Readeck already has without sending them", async () => {
  const { dev, sync } = await setup({
    files: {
      ...onDevice,
      [CLIPPINGS_PATH]: clipping("Article One", "brave new world"),
    },
    routes: {
      "GET /bookmarks/b1/annotations": {
        data: [{ text: "brave  new\nworld" }],
      },
    },
  });

  assert.equal((await sync()).highlights, 0);
  assert.equal(dev.callsTo("POST", "/bookmarks/b1/annotations").length, 0);
  assert.deepEqual(dev.json(STATE_PATH), {
    sent: [highlightKey("b1", "brave new world")],
  });
});

test("sync skips highlights it cannot place or Readeck refuses", async () => {
  const { dev, lines, sync } = await setup({
    files: {
      ...onDevice,
      [CLIPPINGS_PATH]:
        clipping("Article One", "not in the article") +
        clipping("Article One", "Hello brave") +
        clipping("Some other book", "brave new world"),
    },
    routes: {
      "GET /bookmarks/b1/annotations": { data: [] },
      "POST /bookmarks/b1/annotations": {
        status: 422,
        data: { message: "bad range" },
      },
    },
  });

  assert.equal((await sync()).highlights, 0);
  assert.deepEqual(lines, [
    'Could not find a highlight from "Article One" in the article; skipped.',
    'Readeck refused a highlight from "Article One" (HTTP 422: bad range).',
  ]);
  // Nothing was sent, so both are tried again next time.
  assert.equal(dev.sd.has(STATE_PATH), false);
});

test("sync archives finished articles only when enabled", async () => {
  const routes = {
    "GET /bookmarks": (req) =>
      req.query.get("read_status") === "read"
        ? { data: [{ id: "b1", title: "Article One" }] }
        : { data: [] },
    "PATCH /bookmarks/b1": { status: 200 },
  };

  const off = await setup({
    config: { archive_finished: "0" },
    files: onDevice,
    routes,
  });
  assert.equal((await off.sync()).archived, 0);
  assert.equal(off.dev.callsTo("PATCH", "/bookmarks/b1").length, 0);

  const on = await setup({
    config: { archive_finished: "1" },
    files: onDevice,
    routes,
  });
  assert.equal((await on.sync()).archived, 1);
  const [get] = on.dev.callsTo("GET", "/bookmarks");
  assert.deepEqual(get.query.getAll("id"), ["b1"]);
  assert.equal(get.query.get("is_archived"), "false");
  assert.deepEqual(on.dev.callsTo("PATCH", "/bookmarks/b1")[0].body, {
    is_archived: true,
  });
  assert.deepEqual(on.lines, ["Archived Article One"]);
});

test("sync reads settings changed on the SD card since the page loaded", async () => {
  const { dev, ctx, sync } = await setup({ config: { archive_finished: "0" } });

  dev.sd.set(DIR + "/token.json", JSON.stringify({ access_token: "newer" }));
  dev.sd.set(
    DIR + "/config.json",
    JSON.stringify({ server: SERVER, auto_labels: "eink" }),
  );
  await sync();

  assert.equal(ctx.token, "newer");
  assert.equal(ctx.config.auto_labels, "eink");
  assert.equal(dev.calls[0].headers.Authorization, "Bearer newer");
});

test("sync stops when the SD card cannot be listed", async () => {
  const { dev, sync } = await setup({
    config: { auto_labels: "eink", exclude_labels: "" },
  });
  const deviceFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input).startsWith("/api/files")
      ? Promise.resolve(new Response("", { status: 500 }))
      : deviceFetch(input, init);

  await assert.rejects(sync(), /could not list \/Readeck/);
  assert.equal(dev.calls.length, 0);
  assert.deepEqual(dev.fetched, []);
});
