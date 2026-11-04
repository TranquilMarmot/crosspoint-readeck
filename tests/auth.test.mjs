import { test } from "node:test";
import assert from "node:assert/strict";

import { DIR, fakeDevice, runTimers, signedIn } from "./fake-device.mjs";
import { createContext } from "../src/storage.js";
import * as Auth from "../src/auth.js";
import pkg from "../package.json" with { type: "json" };

const TOKEN_PATH = DIR + "/token.json";

async function setup(routes) {
  const dev = fakeDevice({ files: signedIn(), routes });
  return { dev, ctx: await createContext(dev.api) };
}

const deviceRoutes = (features = ["oauth"]) => ({
  "GET /info": { data: { features } },
  "POST /oauth/client": { data: { client_id: "cid" } },
  "POST /oauth/device": {
    data: {
      user_code: "ABCD1234",
      device_code: "dc",
      verification_uri: "https://readeck.test/device",
      interval: 1,
      expires_in: 300,
    },
  },
});

/** A device flow as startDeviceFlow returns it, for polling tests. */
const flow = (dev = {}) => ({
  clientId: "cid",
  dev: { device_code: "dc", interval: 5, expires_in: 300, ...dev },
});

/** Token endpoint that answers with each response in turn. */
function tokenReplies(...replies) {
  const times = [];
  const route = (req) => {
    times.push(Date.now());
    return replies[Math.min(times.length, replies.length) - 1](req);
  };
  return { route, times };
}

const pending = () => ({
  status: 400,
  data: { error: "authorization_pending" },
});

test("startDeviceFlow registers a client and formats the user code", async () => {
  const { dev, ctx } = await setup(deviceRoutes());

  const f = await Auth.startDeviceFlow(ctx);

  assert.equal(f.clientId, "cid");
  assert.equal(f.userCode, "ABCD-1234");
  assert.equal(f.dev.device_code, "dc");
  // Readeck rejects a client without software_version.
  assert.equal(
    dev.callsTo("POST", "/oauth/client")[0].body.software_version,
    pkg.version,
  );
  assert.equal(dev.callsTo("POST", "/oauth/device")[0].body.client_id, "cid");
  // The stored token belongs to another sign-in; none of these calls send it.
  assert.ok(dev.calls.every((c) => c.headers.Authorization === undefined));
});

test("startDeviceFlow stops when the server has no OAuth", async () => {
  const { dev, ctx } = await setup(deviceRoutes([]));

  await assert.rejects(Auth.startDeviceFlow(ctx), /no OAuth sign-in/);
  assert.equal(dev.callsTo("POST", "/oauth/client").length, 0);
});

test("pollForToken waits, slows down when asked, and returns the token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const replies = tokenReplies(
    pending,
    () => ({ status: 400, data: { error: "slow_down" } }),
    (req) => {
      assert.equal(req.body.device_code, "dc");
      assert.equal(req.body.client_id, "cid");
      return { data: { access_token: "new" } };
    },
  );
  const { ctx } = await setup({ "POST /oauth/token": replies.route });

  const token = await runTimers(
    t,
    Auth.pollForToken(ctx, flow({ interval: 1 }), () => false),
  );

  assert.equal(token, "new");
  // interval is at least 5 s; slow_down adds 5 s
  assert.deepEqual(replies.times, [5000, 10000, 20000]);
});

test("pollForToken reports a denied request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const replies = tokenReplies(() => ({
    status: 400,
    data: { error: "access_denied" },
  }));
  const { ctx } = await setup({ "POST /oauth/token": replies.route });

  await assert.rejects(
    runTimers(
      t,
      Auth.pollForToken(ctx, flow(), () => false),
    ),
    /denied/,
  );
});

test("pollForToken reports an expired code", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });

  const expired = tokenReplies(() => ({
    status: 400,
    data: { error: "expired_token" },
  }));
  const a = await setup({ "POST /oauth/token": expired.route });
  await assert.rejects(
    runTimers(
      t,
      Auth.pollForToken(a.ctx, flow(), () => false),
    ),
    /code expired/,
  );
  assert.equal(expired.times.length, 1);

  const forever = tokenReplies(pending);
  const b = await setup({ "POST /oauth/token": forever.route });
  await assert.rejects(
    runTimers(
      t,
      Auth.pollForToken(b.ctx, flow({ expires_in: 12 }), () => false),
    ),
    /code expired/,
  );
});

test("pollForToken stops quietly when cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let cancelled = false;
  const replies = tokenReplies(() => {
    cancelled = true;
    return pending();
  });
  const { ctx } = await setup({ "POST /oauth/token": replies.route });

  const token = await runTimers(
    t,
    Auth.pollForToken(ctx, flow(), () => cancelled),
  );

  assert.equal(token, "");
  assert.equal(replies.times.length, 1);
});

test("storeToken writes the token, and an empty token clears it", async () => {
  const { dev, ctx } = await setup({});

  await Auth.storeToken(ctx, "abc");
  assert.equal(ctx.token, "abc");
  assert.deepEqual(dev.json(TOKEN_PATH), { access_token: "abc" });

  await Auth.storeToken(ctx, "");
  assert.equal(ctx.token, "");
  assert.deepEqual(dev.json(TOKEN_PATH), {});
});

test("signOut revokes the token and forgets it", async () => {
  const { dev, ctx } = await setup({ "POST /oauth/revoke": { status: 200 } });

  await Auth.signOut(ctx);

  assert.deepEqual(dev.callsTo("POST", "/oauth/revoke")[0].body, {
    token: "tok",
  });
  assert.equal(ctx.token, "");
  assert.deepEqual(dev.json(TOKEN_PATH), {});
});

test("signOut forgets the token even when Readeck cannot be reached", async () => {
  const { dev, ctx } = await setup({});
  dev.api.relay = async () => {
    throw new Error("offline");
  };

  await Auth.signOut(ctx);

  assert.equal(ctx.token, "");
  assert.deepEqual(dev.json(TOKEN_PATH), {});
});
