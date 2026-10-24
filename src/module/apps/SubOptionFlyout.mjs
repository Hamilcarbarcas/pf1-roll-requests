// ============================================================
// Sub-option flyouts on the request dialog's check tiles (SUB-OPTIONS-SPEC §4).
//
// Hover opens a flyout beside a tile, right-click pins it. Clicking the tile
// itself stays the plain check (RollRequestDialog#onSelectOption).
// ============================================================

import {
  canPick,
  commonFor,
  isMultiple,
  normalizeTags,
  pickMore,
  subOptionsFor,
  tagLabels,
} from "../sub-options.mjs";

const OPEN_DELAY = 250;
const CLOSE_DELAY = 200;
const TYPES = ["save", "skill", "ability", "spellcasting"];

/** app → { el, tile, pinned, openTimer, closeTimer, onDoc, onKey } */
const state = new WeakMap();

function stateOf(app) {
  if (!state.has(app)) {
    state.set(app, { el: null, tile: null, pinned: false, openTimer: null, closeTimer: null });
    app.addEventListener?.("close", () => closeFlyout(app));
  }
  return state.get(app);
}

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** The tile's own check name, without its chevron or sub line. */
export function tileName(tile) {
  return (tile.querySelector(".arr-option-label") ?? tile).textContent.trim();
}

/** Tags currently chosen for a tile: the selected request's, if it is this tile. */
function currentTags(app, tile) {
  const req = app.selectedRequest;
  if (req?.type !== tile.dataset.type || req?.key !== tile.dataset.key) return [];
  return normalizeTags(req.tags);
}

/** Select a tile with the given tags. */
function select(app, tile, tags) {
  app.element.querySelectorAll(".request-option.selected").forEach((el) => el.classList.remove("selected"));
  tile.classList.add("selected");
  app.selectedRequest = { type: tile.dataset.type, key: tile.dataset.key, name: tileName(tile), tags: normalizeTags(tags) };
  app._syncAidCheckbox?.();
  app._syncSubjectControl?.();
  refreshSubLines(app);
}

/* -------------------------------------------- */
/*  Tiles                                       */
/* -------------------------------------------- */

/** Mark tiles that have sub-options and wire their hover / right-click. Call on every render. */
export function attachSubOptions(app) {
  const root = app.element;
  if (!root) return;
  closeFlyout(app);

  // Remembered tags the provider no longer knows are dropped (§3).
  const req = app.selectedRequest;
  if (req?.tags?.length) {
    const known = new Set(subOptionsFor(req.type, req.key).map((o) => o.id));
    req.tags = normalizeTags(req.tags).filter((t) => known.has(t));
  }

  for (const tile of root.querySelectorAll(".request-option[data-type]")) {
    if (!TYPES.includes(tile.dataset.type)) continue;
    if (!subOptionsFor(tile.dataset.type, tile.dataset.key).length) continue;
    if (tile.dataset.arrSub) continue; // Already wired; a partial re-render kept this tile.
    tile.dataset.arrSub = "1";

    tile.classList.add("arr-has-sub");
    if (!tile.querySelector(".arr-sub-chevron")) {
      tile.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-caret-down arr-sub-chevron" inert></i>');
    }
    tile.addEventListener("mouseenter", () => scheduleOpen(app, tile));
    tile.addEventListener("mouseleave", () => scheduleClose(app));
    tile.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFlyout(app, tile, { pinned: true });
    });
  }
  refreshSubLines(app);
}

/** Show the chosen sub-options under the selected tile. */
export function refreshSubLines(app) {
  const root = app.element;
  if (!root) return;
  root.querySelectorAll(".arr-sub-line").forEach((el) => el.remove());
  const req = app.selectedRequest;
  if (!req?.tags?.length) return;
  const tile = root.querySelector(`.request-option.selected[data-type="${req.type}"][data-key="${CSS.escape(req.key)}"]`);
  if (!tile) return;
  const line = document.createElement("span");
  line.className = "arr-sub-line";
  line.textContent = tagLabels(req).join(", ");
  tile.append(line);
}

/* -------------------------------------------- */
/*  Flyout                                      */
/* -------------------------------------------- */

function scheduleOpen(app, tile) {
  const s = stateOf(app);
  clearTimeout(s.closeTimer);
  clearTimeout(s.openTimer);
  if (s.pinned || s.tile === tile) return;
  s.openTimer = setTimeout(() => openFlyout(app, tile, { pinned: false }), OPEN_DELAY);
}

function scheduleClose(app) {
  const s = stateOf(app);
  clearTimeout(s.openTimer);
  if (s.pinned) return;
  clearTimeout(s.closeTimer);
  s.closeTimer = setTimeout(() => closeFlyout(app), CLOSE_DELAY);
}

export function closeFlyout(app) {
  const s = state.get(app);
  if (!s) return;
  clearTimeout(s.openTimer);
  clearTimeout(s.closeTimer);
  s.el?.remove();
  if (s.onDoc) document.removeEventListener("pointerdown", s.onDoc, true);
  if (s.onKey) document.removeEventListener("keydown", s.onKey, true);
  Object.assign(s, { el: null, tile: null, pinned: false, onDoc: null, onKey: null });
}

function itemsHtml(app, tile) {
  const { type, key } = tile.dataset;
  const options = subOptionsFor(type, key);
  const current = currentTags(app, tile);

  if (!isMultiple(type)) {
    const chosen = current[0] ?? "";
    const row = (id, label) =>
      `<a class="arr-sub-item${id === chosen ? " arr-sub-chosen" : ""}" data-tag="${esc(id)}">${esc(label)}</a>`;
    return [row("", game.i18n.localize("RR.SubOptions.General")), ...options.map((o) => row(o.id, o.label))].join("");
  }

  // Long lists show the provider's common subset plus anything already chosen (§4.3).
  const common = commonFor(type, key);
  const shown = common
    ? options.filter((o) => common.includes(o.id) || current.includes(o.id))
    : options;
  let lastGroup = null;
  const rows = [];
  for (const o of shown) {
    if (!common && o.group && o.group !== lastGroup) {
      rows.push(`<div class="arr-sub-group">${esc(o.group)}</div>`);
      lastGroup = o.group;
    }
    rows.push(`<label class="arr-sub-item arr-sub-check">
      <input type="checkbox" data-tag="${esc(o.id)}" ${current.includes(o.id) ? "checked" : ""}> ${esc(o.label)}
    </label>`);
  }
  if (canPick(type)) {
    rows.push(`<a class="arr-sub-more"><i class="fa-solid fa-list-check" inert></i> ${game.i18n.localize("RR.SubOptions.AllTags")}</a>`);
  }
  return rows.join("");
}

function position(flyout, tile) {
  const r = tile.getBoundingClientRect();
  const w = flyout.offsetWidth;
  const h = flyout.offsetHeight;
  let left = r.right + 4;
  if (left + w > window.innerWidth - 4) left = Math.max(4, r.left - w - 4);
  let top = r.top;
  if (top + h > window.innerHeight - 4) top = Math.max(4, window.innerHeight - h - 4);
  flyout.style.left = `${left}px`;
  flyout.style.top = `${top}px`;
}

function openFlyout(app, tile, { pinned }) {
  closeFlyout(app);
  const s = stateOf(app);
  const { type, key } = tile.dataset;

  const flyout = document.createElement("div");
  flyout.className = "arr-sub-flyout";
  flyout.innerHTML = itemsHtml(app, tile);
  const z = Number(getComputedStyle(app.element).zIndex);
  flyout.style.zIndex = String(Number.isFinite(z) ? z + 1 : 10000);
  document.body.append(flyout);
  position(flyout, tile);
  Object.assign(s, { el: flyout, tile, pinned });

  flyout.addEventListener("mouseenter", () => clearTimeout(s.closeTimer));
  flyout.addEventListener("mouseleave", () => scheduleClose(app));
  flyout.addEventListener("contextmenu", (event) => event.preventDefault());

  // Single pick: choose and close.
  flyout.querySelectorAll("a.arr-sub-item").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      select(app, tile, a.dataset.tag ? [a.dataset.tag] : []);
      closeFlyout(app);
    })
  );

  // Several: toggle and stay open.
  flyout.querySelectorAll("input[type=checkbox][data-tag]").forEach((box) =>
    box.addEventListener("change", () => {
      const tags = new Set(currentTags(app, tile));
      if (box.checked) tags.add(box.dataset.tag);
      else tags.delete(box.dataset.tag);
      select(app, tile, [...tags]);
    })
  );

  flyout.querySelector(".arr-sub-more")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const current = currentTags(app, tile);
    closeFlyout(app);
    const ids = await pickMore(type, key, current);
    if (ids) select(app, tile, ids);
  });

  if (pinned) {
    s.onDoc = (event) => {
      if (flyout.contains(event.target) || tile.contains(event.target)) return;
      closeFlyout(app);
    };
    document.addEventListener("pointerdown", s.onDoc, true);
  }
  s.onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeFlyout(app);
  };
  document.addEventListener("keydown", s.onKey, true);
}
