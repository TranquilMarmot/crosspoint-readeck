// Sign in and Sign out buttons on the settings page.
import { el, status } from "./dom.js";
import { profileName } from "./readeck.js";
import { storeToken, startDeviceFlow, pollForToken, signOut } from "./auth.js";

/**
 * Display status of being signed in to Readeck
 *
 * @param {import("./storage.js").Context} ctx
 * @param {string} user
 */
export function showSignedIn(ctx, user) {
  el("rd-signout").style.display = ctx.token ? "" : "none";
  el("rd-signin").textContent = ctx.token ? "Sign in again" : "Sign in";

  if (!ctx.config.server) {
    status("Not set up yet. Enter your Readeck server URL and sign in.");
  } else if (!ctx.token) {
    status("Not signed in.");
  } else {
    status(
      "Signed in" +
        (user ? " as " + user : "") +
        ". Browse from the reader: Home -> Plugins -> Readeck.",
    );
  }
}

/**
 * @param {import("./storage.js").Context} ctx
 * @param {() => Promise<Object>} saveConfig Saves the form's settings and returns them
 */
export function bindAuthForm(ctx, saveConfig) {
  /** Bumped by each Sign in and by Sign out, so an older polling loop stops. */
  let signInRun = 0;

  // sign in button (OAuth device flow, run from the browser)
  el("rd-signin").onclick = async () => {
    const box = el("rd-code");

    try {
      const cfg = await saveConfig();
      if (!cfg.server) {
        throw new Error("enter your Readeck server URL first");
      }

      status("Contacting Readeck...");

      const flow = await startDeviceFlow(ctx);

      el("rd-verify").href =
        flow.dev.verification_uri_complete || flow.dev.verification_uri;
      el("rd-verify").textContent = flow.dev.verification_uri;
      el("rd-usercode").textContent = flow.userCode;

      box.style.display = "";

      status("Waiting for approval in Readeck...");

      const run = ++signInRun;
      const t = await pollForToken(ctx, flow, () => run !== signInRun);
      if (!t) {
        return;
      }

      await storeToken(ctx, t);
      box.style.display = "none";
      showSignedIn(ctx, await profileName(ctx, t));
    } catch (e) {
      box.style.display = "none";
      status("Sign-in failed: " + e.message);
    }
  };

  // sign out button
  el("rd-signout").onclick = async () => {
    signInRun++;

    await signOut(ctx);
    showSignedIn(ctx, "");
  };
}
