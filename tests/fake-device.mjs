// A fake device for module tests: an in-memory SD card, the plugin host API,
// and the device web server endpoints the plugin fetches.
import { JSDOM } from "jsdom";

export const DIR = "/plugins/readeck";
export const SERVER = "https://readeck.test";

globalThis.DOMParser ??= new JSDOM("").window.DOMParser;

/**
 * @param {Object} opts
 * @param {Object} opts.files SD card path -> string, or an object stored as JSON
 * @param {Object} opts.routes "METHOD /path" (no query) -> response, or a
 *   function of the request returning one. A response is { status, data, headers }.
 * @param {Object} opts.remote URL -> body that /api/fetch writes to the SD card
 */
export function fakeDevice({ files = {}, routes = {}, remote = {} } = {}) {
  const sd = new Map(
    Object.entries(files).map(([p, v]) => [
      p,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  const calls = [];
  const fetched = [];

  const api = {
    dir: DIR,

    async relay(method, url, headers, body) {
      const base = SERVER + "/api";
      if (!url.startsWith(base)) {
        throw new Error("relay to unexpected URL " + url);
      }

      const path = url.slice(base.length);
      const req = {
        method,
        path,
        query: new URLSearchParams(path.split("?")[1] || ""),
        headers,
        body: body ? JSON.parse(body) : undefined,
      };
      calls.push(req);

      const route = routes[method + " " + path.split("?")[0]];
      if (!route) {
        return { status: 404, body: "", headers: {} };
      }

      const res = typeof route === "function" ? route(req) : route;
      return {
        status: res.status ?? 200,
        body: res.data === undefined ? "" : JSON.stringify(res.data),
        headers: res.headers || {},
      };
    },

    async writeFile(path, base64) {
      sd.set(path, Buffer.from(base64, "base64").toString("utf8"));
    },

    registerAction() {},
  };

  globalThis.fetch = async (input, init) => {
    const url = new URL(input, "http://device");
    const p = url.searchParams.get("path");

    if (url.pathname === "/api/fetch") {
      const { url: remoteUrl, dest, headers } = JSON.parse(init.body);
      fetched.push({ url: remoteUrl, dest, headers });
      if (!(remoteUrl in remote)) {
        return Response.json(
          { error: "http status", status: 404, complete: false },
          { status: 200 },
        );
      }
      sd.set(dest, remote[remoteUrl]);
      return Response.json({ status: 200, complete: true });
    }

    if (url.pathname === "/download") {
      return sd.has(p)
        ? new Response(sd.get(p))
        : new Response("", { status: 404 });
    }

    if (url.pathname === "/api/files") {
      const entries = [...sd.keys()]
        .filter(
          (f) => f.startsWith(p + "/") && !f.slice(p.length + 1).includes("/"),
        )
        .map((f) => ({ name: f.slice(p.length + 1), isDirectory: false }));
      return Response.json(entries);
    }

    return new Response("", { status: 404 });
  };

  return {
    api,
    sd,
    calls,
    fetched,
    json: (path) => JSON.parse(sd.get(path)),
    callsTo: (method, path) =>
      calls.filter((c) => c.method === method && c.path.split("?")[0] === path),
  };
}

/** Settings and token files for a signed-in plugin. */
export function signedIn(config = {}) {
  return {
    [DIR + "/config.json"]: { server: SERVER, ...config },
    [DIR + "/token.json"]: { access_token: "tok" },
  };
}

/**
 * Run a promise to completion while advancing mocked timers.
 * Call t.mock.timers.enable({ apis: ["setTimeout", "Date"] }) first.
 *
 * @param {import("node:test").TestContext} t
 * @param {Promise} promise
 * @param {number} step Milliseconds per tick
 */
export async function runTimers(t, promise, step = 1000) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );

  for (let i = 0; !done; i++) {
    if (i > 10000) {
      throw new Error("promise never settled");
    }
    await new Promise((r) => setImmediate(r));
    if (!done) {
      t.mock.timers.tick(step);
    }
  }

  return promise;
}
