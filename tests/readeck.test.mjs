import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeDevice, signedIn } from "./fake-device.mjs";
import { createContext } from "../src/storage.js";
import * as Readeck from "../src/readeck.js";

async function setup(routes) {
  const dev = fakeDevice({ files: signedIn(), routes });
  return { dev, ctx: await createContext(dev.api) };
}

test("call sends the stored token, or the token in opts", async () => {
  const { dev, ctx } = await setup({ "GET /info": { data: {} } });

  await Readeck.call(ctx, "GET", "/info");
  await Readeck.call(ctx, "GET", "/info", undefined, { token: "other" });
  await Readeck.call(ctx, "GET", "/info", undefined, { token: "" });

  const auth = dev.calls.map((c) => c.headers.Authorization);
  assert.deepEqual(auth, ["Bearer tok", "Bearer other", undefined]);
});

test("call sends a JSON body only when there is one", async () => {
  const { dev, ctx } = await setup({ "POST /x": { data: { ok: true } } });

  const r = await Readeck.call(ctx, "POST", "/x", { a: 1 });

  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(dev.calls[0].body, { a: 1 });
  assert.equal(dev.calls[0].headers["Content-Type"], "application/json");
});

test("call turns error statuses into readable errors", async () => {
  const { ctx } = await setup({
    "GET /401": { status: 401 },
    "GET /500": { status: 500, data: { message: "boom" } },
    "GET /302": { status: 302, headers: { location: "https://new.test" } },
  });

  await assert.rejects(Readeck.call(ctx, "GET", "/401"), /Sign in again/);
  await assert.rejects(Readeck.call(ctx, "GET", "/500"), /HTTP 500: boom/);
  await assert.rejects(Readeck.call(ctx, "GET", "/302"), /https:\/\/new\.test/);

  const r = await Readeck.call(ctx, "GET", "/500", undefined, {
    allowError: true,
  });
  assert.equal(r.status, 500);
});

test("profileName returns the user name, or an empty string", async () => {
  const { ctx } = await setup({
    "GET /profile": (req) =>
      req.headers.Authorization === "Bearer good"
        ? { data: { user: { username: "nate" } } }
        : { status: 401 },
  });

  assert.equal(await Readeck.profileName(ctx, "good"), "nate");
  assert.equal(await Readeck.profileName(ctx, "bad"), "");
});

test("listBookmarks fetches pages until a short page", async () => {
  const total = 11;
  const { dev, ctx } = await setup({
    "GET /bookmarks": (req) => {
      const offset = Number(req.query.get("offset"));
      const limit = Number(req.query.get("limit"));
      const n = Math.max(0, Math.min(limit, total - offset));
      return {
        data: Array.from({ length: n }, (_, i) => ({ id: offset + i })),
      };
    },
  });

  const all = await Readeck.listBookmarks(ctx, "type=article");

  assert.deepEqual(
    all.map((b) => b.id),
    Array.from({ length: total }, (_, i) => i),
  );
  assert.deepEqual(
    dev.calls.map((c) => c.query.get("offset")),
    ["0", "8"],
  );
  assert.equal(dev.calls[0].query.get("type"), "article");
});

test("bookmarksById asks for at most five ids per request", async () => {
  const { dev, ctx } = await setup({
    "GET /bookmarks": (req) => ({
      data: req.query.getAll("id").map((id) => ({ id })),
    }),
  });

  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const out = await Readeck.bookmarksById(ctx, ids, "&is_archived=false");

  assert.deepEqual(
    out.map((b) => b.id),
    ids,
  );
  assert.deepEqual(
    dev.calls.map((c) => c.query.getAll("id")),
    [
      ["a", "b", "c", "d", "e"],
      ["f", "g"],
    ],
  );
  assert.ok(dev.calls.every((c) => c.query.get("is_archived") === "false"));
});
