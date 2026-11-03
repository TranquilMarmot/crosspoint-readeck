// SD card access through the device's web server,
// and the shared plugin context that holds the saved settings and token.
import { encodeBase64Utf8 } from "./util.js";

/**
 * @typedef {Object} Context
 * @property {Object} api Plugin host API (relay, writeFile, dir, ...)
 * @property {{config: string, token: string, state: string, articleTmp: string}} paths
 * @property {Object} config Saved settings (server, labels, archive flag)
 * @property {string} token Readeck access token, "" when signed out
 */

/**
 * Read a file from the SD card as text, or null if it cannot be read.
 *
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function readSd(path) {
  const r = await fetch("/download?path=" + encodeURIComponent(path));

  if (!r.ok) {
    return null;
  }

  return r.text();
}

/**
 * Read and parse a JSON file from the SD card, or null on any failure.
 *
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function readJson(path) {
  try {
    return JSON.parse(await readSd(path));
  } catch (e) {
    return null;
  }
}

/**
 * @param {Object} api
 * @param {string} path
 * @param {any} obj
 */
export function writeJson(api, path, obj) {
  return api.writeFile(path, encodeBase64Utf8(JSON.stringify(obj)));
}

/**
 * Build the context and load the saved settings and token.
 *
 * @param {Object} api
 * @returns {Promise<Context>}
 */
export async function createContext(api) {
  const ctx = {
    api,
    paths: {
      config: api.dir + "/config.json",
      token: api.dir + "/token.json",
      state: api.dir + "/state.json",
      articleTmp: api.dir + "/article.tmp.html",
    },
    config: {},
    token: "",
  };

  await reloadContext(ctx);

  return ctx;
}

/**
 * Re-read settings and token from the SD card. Another page (or the device)
 * may have changed them since this page loaded.
 *
 * @param {Context} ctx
 */
export async function reloadContext(ctx) {
  ctx.config = (await readJson(ctx.paths.config)) || ctx.config;
  ctx.token = ((await readJson(ctx.paths.token)) || {}).access_token || "";
}

/**
 * @param {Context} ctx
 * @param {Object} config
 * @returns {Promise<Object>} the saved config
 */
export async function saveConfig(ctx, config) {
  ctx.config = config;

  await writeJson(ctx.api, ctx.paths.config, config);

  return config;
}
