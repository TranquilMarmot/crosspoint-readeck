// Sync between Readeck and the SD card.
// Download tagged articles, send highlights, and archive finished articles.
import {
  BOOK_DIR,
  CLIPPINGS_PATH,
  parseLabels,
  sanitizeFilename,
  parseClippings,
  normalizeText,
  locateHighlight,
  highlightKey,
} from "./util.js";
import { readSd, readJson, writeJson, reloadContext } from "./storage.js";
import {
  call,
  listBookmarks,
  bookmarksById,
  fetchBookmark,
} from "./readeck.js";

/**
 * Readeck articles on the SD card, by bookmark id.
 * The sidecar the device writes next to each download (book.epub.meta.json) holds the id.
 * @returns {Promise<Map>}
 */
async function booksOnDevice() {
  // Throws rather than returning an empty list: sync would then download
  // every tagged article again. A missing folder lists as [].
  const r = await fetch("/api/files?path=" + encodeURIComponent(BOOK_DIR));
  const entries = r.ok ? await r.json() : null;

  if (!Array.isArray(entries)) {
    throw new Error("could not list " + BOOK_DIR + " on the SD card");
  }

  const found = new Map();
  const names = new Set(entries.map((e) => e.name));

  for (const e of entries) {
    if (e.isDirectory || !e.name.endsWith(".epub.meta.json")) {
      continue;
    }

    const book = e.name.slice(0, -".meta.json".length);

    if (!names.has(book)) {
      continue;
    }

    const meta = await readJson(BOOK_DIR + "/" + e.name);
    if (meta && meta.readeck_id) {
      found.set(String(meta.readeck_id), BOOK_DIR + "/" + book);
    }
  }

  return found;
}

async function download(ctx, b, log) {
  const dest = BOOK_DIR + "/" + sanitizeFilename(b.title + ".epub");

  await fetchBookmark(ctx, b.id, "article.epub", dest);
  await writeJson(ctx.api, dest + ".meta.json", { readeck_id: b.id });

  log("Downloaded " + b.title);
  return dest;
}

async function syncDownloads(ctx, onDevice, log) {
  let count = 0;

  for (const label of parseLabels(ctx.config.auto_labels || "")) {
    // Same filter as the reader's tag lists in device.json;
    // "label" followed by the ignored tags' exclusions.
    const q =
      "type=article&is_archived=false&labels=" +
      encodeURIComponent('"' + label + '"') +
      "%20" +
      ctx.config.exclude_labels;

    for (const b of await listBookmarks(ctx, q)) {
      if (onDevice.has(b.id) || !b.title || !b.loaded) {
        continue;
      }

      onDevice.set(b.id, await download(ctx, b, log));
      count++;
    }
  }

  return count;
}

async function articleRoot(ctx, id) {
  await fetchBookmark(ctx, id, "article", ctx.paths.articleTmp, {
    Accept: "text/html",
  });

  const html = await readSd(ctx.paths.articleTmp);
  if (html == null) {
    throw new Error("could not read the article back from the SD card");
  }

  return new DOMParser().parseFromString(html, "text/html").body;
}

async function syncHighlights(ctx, onDevice, log) {
  const clippings = parseClippings((await readSd(CLIPPINGS_PATH)) || "");

  if (!clippings.length || !onDevice.size) {
    return 0;
  }

  const state = (await readJson(ctx.paths.state)) || {};
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  const byTitle = new Map();

  for (const b of await bookmarksById(ctx, onDevice.keys())) {
    if (b.title) {
      byTitle.set(normalizeText(b.title), b.id);
    }
  }

  let count = 0;
  const groups = new Map();
  for (const c of clippings) {
    const id = byTitle.get(normalizeText(c.title));

    if (!id || sent.has(highlightKey(id, c.text))) {
      continue;
    }

    if (!groups.has(id)) {
      groups.set(id, []);
    }

    groups.get(id).push(c);
  }

  for (const [id, list] of groups) {
    const existing = new Set();
    const ann = await call(ctx, "GET", "/bookmarks/" + id + "/annotations");

    for (const a of ann.data || []) {
      existing.add(normalizeText(a.text || ""));
    }

    for (const c of list) {
      const key = highlightKey(id, c.text);

      if (existing.has(normalizeText(c.text))) {
        sent.add(key);
        continue;
      }

      // Each new highlight changes the article's markup,
      // locate the next one in a fresh copy
      const range = locateHighlight(await articleRoot(ctx, id), c.text);
      if (!range) {
        log(
          'Could not find a highlight from "' +
            c.title +
            '" in the article; skipped.',
        );

        continue;
      }

      const r = await call(
        ctx,
        "POST",
        "/bookmarks/" + id + "/annotations",
        Object.assign(range, { color: "yellow" }),
        { allowError: true },
      );

      if (r.status === 201 || r.status === 200) {
        count++;
        sent.add(key);
        existing.add(normalizeText(c.text));
      } else {
        log(
          'Readeck refused a highlight from "' +
            c.title +
            '" (HTTP ' +
            r.status +
            (r.data && r.data.message ? ": " + r.data.message : "") +
            ").",
        );
      }
    }
  }

  if (count || sent.size !== (state.sent || []).length) {
    await writeJson(ctx.api, ctx.paths.state, { sent: Array.from(sent) });
  }

  if (count) {
    log("Sent " + count + " highlight" + (count === 1 ? "" : "s") + ".");
  }

  return count;
}

async function syncArchive(ctx, onDevice, log) {
  if (ctx.config.archive_finished !== "1" || !onDevice.size) {
    return 0;
  }

  let count = 0;
  for (const b of await bookmarksById(
    ctx,
    onDevice.keys(),
    "&is_archived=false&read_status=read",
  )) {
    await call(ctx, "PATCH", "/bookmarks/" + b.id, {
      is_archived: true,
    });

    log("Archived " + b.title);
    count++;
  }

  return count;
}

/**
 * @param {import("./storage.js").Context} ctx
 * @param {(line: string) => void} log
 * @returns {Promise<{downloaded: number, highlights: number, archived: number}>}
 */
export async function sync(ctx, log) {
  await reloadContext(ctx);

  if (!ctx.config.server || !ctx.token) {
    throw new Error("sign in to Readeck first");
  }

  const onDevice = await booksOnDevice();

  return {
    downloaded: await syncDownloads(ctx, onDevice, log),
    highlights: await syncHighlights(ctx, onDevice, log),
    archived: await syncArchive(ctx, onDevice, log),
  };
}
