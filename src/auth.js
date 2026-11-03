// Readeck authentication.
// OAuth device flow, API tokens, and token storage.
import { writeJson } from "./storage.js";
import { call, profileName } from "./readeck.js";
import pkg from "../package.json" with { type: "json" };

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLIENT = {
  client_name: "CrossPoint Reader",
  client_uri: "https://github.com/crosspoint-reader/crosspoint-reader",
  software_id: "crosspoint-readeck",
  // required by Readeck
  software_version: pkg.version,
  grant_types: [DEVICE_GRANT],
};

const SCOPES = "bookmarks:read bookmarks:write profile:read";

/**
 * Store the given Readeck token on the SD card.
 * "" will delete it.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} t
 */
export async function storeToken(ctx, t) {
  ctx.token = t;
  await writeJson(ctx.api, ctx.paths.token, t ? { access_token: t } : {});
}

/**
 * Register a client and request a device code.
 *
 * @param {import("./storage.js").Context} ctx
 * @returns {Promise<{clientId: string, dev: Object, userCode: string}>}
 *   dev is Readeck's device authorization response; userCode is formatted for display.
 */
export async function startDeviceFlow(ctx) {
  const info = await call(ctx, "GET", "/info", undefined, { token: "" });

  const features = (info.data && info.data.features) || [];
  if (!features.includes("oauth")) {
    throw new Error(
      "this Readeck server has no OAuth sign-in. Use an API token instead.",
    );
  }

  const client = await call(ctx, "POST", "/oauth/client", CLIENT, {
    token: "",
  });
  const clientId = client.data.client_id;

  const dev = (
    await call(
      ctx,
      "POST",
      "/oauth/device",
      { client_id: clientId, scope: SCOPES },
      { token: "" },
    )
  ).data;

  const userCode =
    dev.user_code.length === 8
      ? dev.user_code.slice(0, 4) + "-" + dev.user_code.slice(4)
      : dev.user_code;

  return { clientId, dev, userCode };
}

/**
 * Poll until the user approves the device code.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {{clientId: string, dev: Object}} flow From startDeviceFlow
 * @param {() => boolean} isCancelled Checked before each request
 * @returns {Promise<string>} the access token, or "" if cancelled
 */
export async function pollForToken(ctx, flow, isCancelled) {
  const { clientId, dev } = flow;

  let wait = Math.max(5, dev.interval || 5) * 1000;
  const deadline = Date.now() + (dev.expires_in || 300) * 1000;
  while (!isCancelled() && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, wait));

    if (isCancelled()) {
      return "";
    }

    const r = await call(
      ctx,
      "POST",
      "/oauth/token",
      {
        grant_type: DEVICE_GRANT,
        client_id: clientId,
        device_code: dev.device_code,
      },
      { token: "", allowError: true },
    );

    const d = r.data || {};

    if (d.access_token) {
      return d.access_token;
    }

    if (d.error === "slow_down") {
      wait += 5000;
    } else if (d.error === "access_denied") {
      throw new Error("the request was denied in Readeck");
    } else if (d.error === "expired_token") {
      break;
    } else if (d.error !== "authorization_pending") {
      throw new Error(d.error || "HTTP " + r.status);
    }
  }

  if (!isCancelled()) {
    throw new Error("the code expired. Press Sign in to get a new one.");
  }

  return "";
}

/**
 * Check that Readeck accepts an API token.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} t
 * @returns {Promise<string>} the user name, or "" if unknown
 */
export async function checkToken(ctx, t) {
  const name = await profileName(ctx, t);
  const check = await call(ctx, "GET", "/bookmarks?limit=1", undefined, {
    token: t,
    allowError: true,
  });

  if (check.status !== 200) {
    throw new Error(
      "Readeck did not accept this token (HTTP " + check.status + ")",
    );
  }

  return name;
}

/**
 * Revoke the token in Readeck, if possible, and forget it locally.
 *
 * @param {import("./storage.js").Context} ctx
 */
export async function signOut(ctx) {
  const old = ctx.token;
  try {
    if (old && ctx.config.server) {
      await call(
        ctx,
        "POST",
        "/oauth/revoke",
        { token: old },
        { allowError: true },
      );
    }
  } catch (e) {
    /* token is forgotten locally either way */
  }

  await storeToken(ctx, "");
}
