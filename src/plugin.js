import { trimUrl, isHttpUrl, parseLabels, excludeQuery } from "./util.js";
import settingsHtml from "./settings.html";
import { el, status } from "./dom.js";
import { createContext, saveConfig } from "./storage.js";
import { profileName } from "./readeck.js";
import { bindAuthForm, showSignedIn } from "./auth_form.js";
import { sync } from "./sync.js";

CrossPoint.registerPlugin(async (container, api) => {
  container.innerHTML = settingsHtml;

  const ctx = await createContext(api);

  function formConfig() {
    const server = trimUrl(el("rd-url").value);

    if (server && !isHttpUrl(server)) {
      throw new Error(
        "enter the full server URL, like https://readeck.example.com",
      );
    }

    const auto = parseLabels(el("rd-auto").value);
    const ignore = parseLabels(el("rd-ignore").value);

    return {
      server,
      auto_labels: auto.join(", "),
      ignore_labels: ignore.join(", "),
      exclude_labels: excludeQuery(ignore),
      archive_finished: el("rd-archive").checked ? "1" : "0",
    };
  }

  const saveFormConfig = () => saveConfig(ctx, formConfig());

  bindAuthForm(ctx, saveFormConfig);

  el("rd-save").onclick = async () => {
    try {
      await saveFormConfig();
      status("Saved.");
    } catch (e) {
      status("Error: " + e.message);
    }
  };

  el("rd-sync").onclick = async () => {
    const out = el("rd-log");
    out.style.display = "";
    out.textContent = "";

    const log = (line) => {
      out.textContent += line + "\n";
    };

    el("rd-sync").disabled = true;
    status("Syncing...");

    try {
      await saveFormConfig();
      const r = await sync(ctx, log);
      status(
        "Sync done: " +
          r.downloaded +
          " downloaded, " +
          r.highlights +
          " highlights sent, " +
          r.archived +
          " archived.",
      );

      if (!out.textContent) {
        log("Nothing to do.");
      }
    } catch (e) {
      status("Sync failed: " + e.message);
    } finally {
      el("rd-sync").disabled = false;
    }
  };

  el("rd-url").value = ctx.config.server || "";
  el("rd-auto").value = ctx.config.auto_labels || "";
  el("rd-ignore").value = ctx.config.ignore_labels || "";
  el("rd-archive").checked = ctx.config.archive_finished === "1";

  showSignedIn(ctx, ctx.token ? await profileName(ctx, ctx.token) : "");
});
