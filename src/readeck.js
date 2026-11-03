// Readeck API calls, sent through the device's relay.

// keeps a page of bookmark JSON under the relay's 32KB cap
const PAGE_SIZE = 8;
const BOOKMARKS_BY_ID_BATCH_SIZE = 5;

/**
 * Make a call to Readeck's API through the device.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} method HTTP method
 * @param {string} path Path to endpoint
 * @param {Object} body Body to include
 * @param {Object} opts Options: token (overrides ctx.token), allowError
 * @returns {Promise<Object>} { status, data }
 */
export async function call(ctx, method, path, body, opts = {}) {
  const headers = { Accept: "application/json" };
  const auth = opts.token === undefined ? ctx.token : opts.token;

  if (auth) {
    headers.Authorization = "Bearer " + auth;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const r = await ctx.api.relay(
    method,
    ctx.config.server + "/api" + path,
    headers,
    body === undefined ? "" : JSON.stringify(body),
  );

  let data = null;
  try {
    data = r.body ? JSON.parse(r.body) : null;
  } catch (e) {
    /* not JSON */
  }

  if (r.status >= 300 && r.status < 400) {
    throw new Error(
      "Readeck redirected to " +
        (new Headers(r.headers).get("location") || "another address") +
        ". Use that address as the server URL.",
    );
  }

  if (r.status === 401 && !opts.allowError) {
    throw new Error("Readeck refused the sign-in. Sign in again.");
  }

  if ((r.status < 200 || r.status >= 300) && !opts.allowError) {
    const msg = data && (data.message || data.error_description || data.error);

    throw new Error(
      "Readeck answered HTTP " + r.status + (msg ? ": " + msg : ""),
    );
  }

  return { status: r.status, data };
}

/**
 * Get the name of the user logged in to Readeck, or "" if unknown.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} auth OAuth token
 * @returns {Promise<string>}
 */
export async function profileName(ctx, auth) {
  try {
    const r = await call(ctx, "GET", "/profile", undefined, {
      token: auth,
      allowError: true,
    });

    return r.status === 200 && r.data && r.data.user
      ? r.data.user.username
      : "";
  } catch (e) {
    return "";
  }
}

/**
 * Get every bookmark matching a query. Fetched a page at a time.
 * Bookmark ids are letters and digits, so they go into paths and queries unencoded.
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function listBookmarks(ctx, query) {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const r = await call(
      ctx,
      "GET",
      "/bookmarks?" + query + "&limit=" + PAGE_SIZE + "&offset=" + offset,
    );

    const page = Array.isArray(r.data) ? r.data : [];

    all.push(...page);

    if (page.length < PAGE_SIZE) {
      return all;
    }
  }
}

/**
 * @param {import("./storage.js").Context} ctx
 * @param {Iterable<string>} ids
 * @param {string} extra Extra query terms, starting with "&"
 * @returns {Promise<Array>}
 */
export async function bookmarksById(ctx, ids, extra = "") {
  const list = Array.from(ids);
  const out = [];

  for (let i = 0; i < list.length; i += BOOKMARKS_BY_ID_BATCH_SIZE) {
    const q = list
      .slice(i, i + BOOKMARKS_BY_ID_BATCH_SIZE)
      .map((id) => "id=" + id)
      .join("&");

    out.push(...(await listBookmarks(ctx, q + extra)));
  }

  return out;
}

/**
 * Streams a bookmark's EPUB or article HTML to the SD card in one request.
 * Not api.fetchToSd: it resumes in 2MB Range requests, which Readeck ignores.
 */
export async function fetchBookmark(ctx, id, resource, dest, headers = {}) {
  const r = await fetch("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plugin: "readeck",
      url: ctx.config.server + "/api/bookmarks/" + id + "/" + resource,
      dest,
      headers: { Authorization: "Bearer " + ctx.token, ...headers },
    }),
  });
  const result = await r.json().catch(() => ({}));

  if (!r.ok || result.complete === false) {
    const status = result.status || r.status;
    throw new Error(
      "download of " +
        dest +
        " failed: " +
        (result.error || "") +
        " HTTP " +
        status,
    );
  }

  return result;
}
