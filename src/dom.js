// Small helpers for the settings page.

export const el = (id) => document.getElementById(id);

export const status = (t) => {
  el("rd-status").textContent = t;
};
