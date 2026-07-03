// ============================================================
// Pathfinder 1e Roll Requests — Monster Lore (ApplicationV2)
// ============================================================
//
// GM-only window: pick a monster's type, CR, and rarity, then fire a
// public multi-check Knowledge request via this module's createRequest API.
// The Knowledge skill is chosen from the monster type; the DC is the rarity
// base (5/10/15) + CR (minimum 1 for fractional CRs). A live "Questions
// earned" tally is shown on the card — 1 per passing check, +1 per full 5
// by which it beats the DC.
//
// Opened as a Quick Action from the Roll Request window (see roll-options.mjs).

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

/** Monster types → the Knowledge skill used to identify them. */
export const MONSTER_TYPES = [
  { key: "aberration",         label: "Aberrations",         skill: "kdu" },
  { key: "animal",             label: "Animals",             skill: "kna" },
  { key: "construct",          label: "Constructs",          skill: "kar" },
  { key: "dragon",             label: "Dragons",             skill: "kar" },
  { key: "fey",                label: "Fey",                 skill: "kna" },
  { key: "humanoid",           label: "Humanoids",           skill: "klo" },
  { key: "magical-beast",      label: "Magical Beasts",      skill: "kar" },
  { key: "monstrous-humanoid", label: "Monstrous Humanoids", skill: "kna" },
  { key: "ooze",               label: "Oozes",               skill: "kdu" },
  { key: "outsider",           label: "Outsiders",           skill: "kpl" },
  { key: "plant",              label: "Plants",              skill: "kna" },
  { key: "undead",             label: "Undead",              skill: "kre" },
  { key: "vermin",             label: "Vermin",              skill: "kna" },
];

/** Rarity → DC base value. */
export const RARITY = [
  { key: "common", label: "Common", base: 5 },
  { key: "normal", label: "Normal", base: 10 },
  { key: "rare",   label: "Rare",   base: 15 },
];

/** Challenge Rating options. Fractional CRs contribute 1 to the DC. */
export const CR_OPTIONS = [
  { value: 0.125, label: "1/8" },
  { value: 0.25,  label: "1/4" },
  { value: 0.5,   label: "1/2" },
  ...Array.from({ length: 30 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
];

/** Resolve a PF1 skill key (e.g. "kna") to its localized display name. */
export function skillLabel(skillKey) {
  const label = pf1.config.skills?.[skillKey];
  if (!label) return skillKey;
  return typeof label === "string" ? label : game.i18n.localize(label);
}

/**
 * Map a PF1 creature-type key (camelCase, e.g. "magicalBeast") to the
 * kebab-case key used by MONSTER_TYPES (e.g. "magical-beast"). Returns null
 * if the type isn't one we recognize.
 */
export function pf1TypeToKey(pf1Key) {
  if (!pf1Key) return null;
  const kebab = pf1Key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return MONSTER_TYPES.some(t => t.key === kebab) ? kebab : null;
}

/**
 * PF1 size keys in index order (matches pf1.config.sizeChart and the numeric
 * `system.traits.size.value`). Used to resolve a numeric size index to its key.
 */
const PF1_SIZE_KEYS = ["fine", "dim", "tiny", "sm", "med", "lg", "huge", "grg", "col"];

/**
 * Resolve PF1's `system.traits.size` to a short size key (e.g. "med", "lg").
 * In PF1 v11 this is an object: `.base` is the natural-size string key and
 * `.value` is a numeric index of the *current* (possibly buff-modified) size.
 * We prefer `.base` so it reflects the creature's natural size, not a
 * temporary Enlarge/Reduce. Falls back to the numeric index, then to a legacy
 * plain string. Returns null if unreadable.
 * @param {object|string|number|null} size
 * @returns {string|null}
 */
function resolveSizeKey(size) {
  if (size == null) return null;
  if (typeof size === "string") return size;            // legacy plain key
  if (typeof size === "number") return PF1_SIZE_KEYS[size] ?? null;
  if (typeof size === "object") {
    if (typeof size.base === "string" && size.base) return size.base;
    if (typeof size.value === "number") return PF1_SIZE_KEYS[size.value] ?? null;
    if (typeof size.value === "string" && size.value) return size.value;
  }
  return null;
}

/**
 * Read a PF1 actor's CR, primary creature type, and size.
 * `size` is the short PF1 size key (e.g. "med", "lg").
 * @param {Actor} actor
 * @returns {{ cr: number|null, typeKey: string|null, size: string|null }}
 */
export function readMonsterStats(actor) {
  let cr = null, typeKey = null;
  const crTotal = actor?.system?.details?.cr?.total;
  if (typeof crTotal === "number") cr = crTotal;

  const types = actor?.system?.traits?.creatureTypes?.standard;
  const primary = types && typeof types[Symbol.iterator] === "function" ? [...types][0] : null;
  typeKey = pf1TypeToKey(primary);

  const size = resolveSizeKey(actor?.system?.traits?.size);
  return { cr, typeKey, size };
}

export class MonsterLore extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(options = {}) {
    super(options);
    this.monsterType = "aberration";
    this.cr = 1;
    this.rarity = "normal";
    this.referenceActor = null;

    // Auto-populate CR & type from a single selected token on first open.
    this._initReferenceFromSelection();
  }

  static DEFAULT_OPTIONS = {
    id: "pf1-monster-lore",
    classes: ["pf1-monster-lore"],
    tag: "div",
    window: {
      title: "Monster Lore",
      icon: "fas fa-dragon",
      resizable: true,
      minimizable: true,
    },
    actions: {
      requestChecks: MonsterLore.#onRequestChecks,
      grabToken: MonsterLore.#onGrabToken,
      syncMonster: MonsterLore.#onSyncMonster,
      clearMonster: MonsterLore.#onClearMonster,
    },
    position: { width: 360 },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/monster-lore.hbs` },
  };

  // ---- Helpers ----

  _selectedType() {
    return MONSTER_TYPES.find(t => t.key === this.monsterType) ?? MONSTER_TYPES[0];
  }

  /** Pick up the currently selected token's actor (if exactly one). */
  _initReferenceFromSelection() {
    try {
      const controlled = canvas?.tokens?.controlled;
      if (controlled?.length === 1 && controlled[0]?.actor) {
        this._applyReferenceActor(controlled[0].actor, false);
      }
    } catch { /* canvas may not be ready */ }
  }

  /**
   * Set the reference actor and auto-populate CR & creature type. Rarity is
   * never on the actor, so it is left untouched.
   * @param {Actor} actor
   * @param {boolean} [render=true]
   */
  _applyReferenceActor(actor, render = true) {
    this.referenceActor = actor;
    if (actor) {
      const { cr, typeKey } = readMonsterStats(actor);
      if (cr != null) this.cr = cr;
      if (typeKey) this.monsterType = typeKey;
    }
    if (render) this.render();
  }

  _skillName(skillKey) {
    return skillLabel(skillKey);
  }

  /** DC = rarity base + CR (fractional CRs count as 1). */
  _computeDC() {
    const base = RARITY.find(r => r.key === this.rarity)?.base ?? 10;
    const crTerm = this.cr < 1 ? 1 : this.cr;
    return base + crTerm;
  }

  // ---- Context ----

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const type = this._selectedType();
    context.types = MONSTER_TYPES.map(t => ({ ...t, selected: t.key === this.monsterType }));
    context.rarities = RARITY.map(r => ({ ...r, selected: r.key === this.rarity }));
    context.crOptions = CR_OPTIONS.map(c => ({ ...c, selected: c.value === this.cr }));
    context.skillName = this._skillName(type.skill);
    context.typeLabel = type.label;
    context.dc = this._computeDC();

    // Reference monster (optional)
    const actor = this.referenceActor;
    context.hasReference = !!actor;
    context.monsterImg = actor ? (actor.img || "icons/svg/mystery-man.svg") : "";
    context.monsterName = actor ? (actor.name || "Unknown") : "";
    context.crLabel = pf1.utils.CR.fromNumber(this.cr);
    return context;
  }

  // ---- Render: bind selectors (re-render to refresh skill + DC) ----

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    el.querySelector("#ml-type")?.addEventListener("change", (e) => {
      this.monsterType = e.currentTarget.value;
      this.render();
    });
    el.querySelector("#ml-cr")?.addEventListener("change", (e) => {
      this.cr = Number(e.currentTarget.value);
      this.render();
    });
    el.querySelector("#ml-rarity")?.addEventListener("change", (e) => {
      this.rarity = e.currentTarget.value;
      this.render();
    });

    // Drag-and-drop for the reference monster
    this._bindDropZone(el.querySelector(".ml-monster-drop-zone"));
    this._bindDropZone(el.querySelector(".ml-monster-display"));
  }

  /** Attach dragover / dragleave / drop handlers to a drop target. */
  _bindDropZone(zone) {
    if (!zone) return;
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      zone.classList.add("drag-hover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-hover"));
    zone.addEventListener("drop", (e) => this._onDropActor(e));
  }

  /** Handle an actor drop onto the reference monster zone. */
  async _onDropActor(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("drag-hover");
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (data.type !== "Actor") return;

    const actor = await fromUuid(data.uuid);
    if (!actor) {
      ui.notifications.warn("Could not resolve actor.");
      return;
    }
    this._applyReferenceActor(actor);
  }

  // ---- Actions ----

  static #onGrabToken() {
    const controlled = canvas?.tokens?.controlled;
    if (controlled?.length === 1 && controlled[0]?.actor) {
      this._applyReferenceActor(controlled[0].actor);
    } else if (controlled?.length > 1) {
      ui.notifications.warn("Select a single token to use as the monster.");
    } else {
      ui.notifications.info("No token selected. Select a token or drag an actor here.");
    }
  }

  static #onSyncMonster() {
    if (this.referenceActor) this._applyReferenceActor(this.referenceActor);
  }

  static #onClearMonster() {
    this.referenceActor = null;
    this.render();
  }

  static async #onRequestChecks() {
    const api = game.pf1RollRequests;
    if (!api?.createRequest) {
      ui.notifications.error("pf1-roll-requests createRequest API is unavailable.");
      return;
    }
    const type = this._selectedType();
    const dc = this._computeDC();
    await api.createRequest({
      type: "skill",
      key: type.skill,
      dc,
      mode: "multi",
      includeAid: false,
      rollMode: "roll",
      showDC: false,
      showResults: true,
      flavor: "Monster Lore",
      summaryKey: MONSTER_LORE_SUMMARY_KEY,
    });
    ui.notifications.info(`Monster Lore: requested ${this._skillName(type.skill)} (DC ${dc}).`);
  }

  // ---- Lifecycle / Singleton ----

  static _instance = null;

  async _onClose(options) {
    await super._onClose(options);
    MonsterLore._instance = null;
  }

  static openWindow() {
    if (!game.user.isGM) {
      ui.notifications.warn("Only the GM can use Monster Lore.");
      return;
    }
    if (!MonsterLore._instance) MonsterLore._instance = new MonsterLore();
    MonsterLore._instance.render(true);
  }
}

// ============================================================
// Summary formatter
//
// Renders a live running tally of the questions the party has earned.
// Each passing knowledge check earns 1 question, +1 per full 5 by which
// it beats the DC. Recomputed from results on every roll (no accumulation).
// ============================================================

/** Summary key shared between Monster Lore requests and its formatter. */
export const MONSTER_LORE_SUMMARY_KEY = "pf1-monster-lore";

/** @param {object} flags - The Monster Lore card's current flag state. */
export function monsterLoreSummary(flags) {
  const dc = flags.dc;
  if (dc == null) return "";
  let questions = 0;
  for (const r of Object.values(flags.rolledActors ?? {})) {
    if (typeof r.total !== "number") continue;
    if (r.total >= dc) questions += 1 + Math.floor((r.total - dc) / 5);
  }
  return `<i class="fas fa-circle-question"></i> <strong>Questions earned:</strong> ${questions}`;
}
