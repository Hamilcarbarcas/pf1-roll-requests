// ============================================================
// Pathfinder 1e Roll Requests — Opposed Check (ApplicationV2)
// ============================================================
//
// GM-only window: pick one of the common opposed contests, assign two tokens
// from the current scene to its two sides, and fire a targeted request where
// each side rolls its own half of the contest (Stealth against Perception, and
// so on). No DC is involved — the two totals are compared against each other,
// and the higher one wins.
//
// Opened as a Quick Action from the Roll Request window (see roll-options.mjs).

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

/**
 * The contests offered in the dropdown. `a` and `b` are the checks the two
 * sides roll; a contest whose halves are the same check (Forgery, Strength) is
 * written out in full rather than special-cased.
 *
 * Escape Artist deliberately has no entry: it is rolled against the binder's
 * CMD, which is a static number, not a roll.
 *
 * @typedef {object} OpposedContest
 * @property {string} key    - Stable identifier.
 * @property {string} label  - i18n key for the dropdown and the card title.
 * @property {{type: string, key: string}} a - The initiating side's check.
 * @property {{type: string, key: string}} b - The responding side's check.
 */
export const OPPOSED_CONTESTS = [
  { key: "stealth",  label: "RR.OC.Contest.stealth",  a: { type: "skill", key: "ste" }, b: { type: "skill", key: "per" } },
  { key: "bluff",    label: "RR.OC.Contest.bluff",    a: { type: "skill", key: "blf" }, b: { type: "skill", key: "sen" } },
  { key: "disguise", label: "RR.OC.Contest.disguise", a: { type: "skill", key: "dis" }, b: { type: "skill", key: "per" } },
  { key: "forgery",  label: "RR.OC.Contest.forgery",  a: { type: "skill", key: "lin" }, b: { type: "skill", key: "lin" } },
  { key: "strength", label: "RR.OC.Contest.strength", a: { type: "ability", key: "str" }, b: { type: "ability", key: "str" } },
];

/**
 * The localized display name of one side's check. Read from pf1.config rather
 * than kept as a second set of strings, so a module that renames a skill renames
 * it here too.
 *
 * @param {{type: string, key: string}} check
 * @returns {string}
 */
export function checkLabel(check) {
  const table = check?.type === "ability" ? pf1.config.abilities : pf1.config.skills;
  const label = table?.[check?.key];
  if (!label) return check?.key ?? "";
  return typeof label === "string" ? label : game.i18n.localize(label);
}

export class OpposedCheck extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(options = {}) {
    super(options);
    this.contest = OPPOSED_CONTESTS[0].key;
    /** Token document ids of the two sides; either may be null. */
    this.sideA = null;
    this.sideB = null;
    this.rollMode = "roll";
    this.showResults = true;
    this.flavor = "";

    this._initSidesFromCanvas();
  }

  static DEFAULT_OPTIONS = {
    id: "pf1-opposed-check",
    classes: ["pf1-opposed-check"],
    tag: "div",
    window: {
      title: "RR.OC.Window",
      icon: "fas fa-people-arrows",
      resizable: false,
      minimizable: true,
    },
    actions: {
      toggleToken: OpposedCheck.#onToggleToken,
      swapSides: OpposedCheck.#onSwapSides,
      requestOpposed: OpposedCheck.#onRequestOpposed,
    },
    position: { width: 400 },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/opposed-check.hbs` },
  };

  // ---- Helpers ----

  _contest() {
    return OPPOSED_CONTESTS.find(c => c.key === this.contest) ?? OPPOSED_CONTESTS[0];
  }

  /**
   * Every token on the viewed scene that has an actor to roll with, name-sorted.
   * Hidden tokens are included — this window is GM-only, and a Stealth contest
   * is exactly the case where one side is hidden.
   *
   * @returns {Token[]}
   */
  _sceneTokens() {
    return (canvas.tokens?.placeables ?? [])
      .filter(t => t.actor)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  /**
   * Seed the two sides from the canvas: controlled tokens first, then targeted
   * ones, up to two. The common approach is to select the pair and open this,
   * so the window usually opens ready to send.
   */
  _initSidesFromCanvas() {
    try {
      const ids = [];
      for (const token of [...(canvas?.tokens?.controlled ?? []), ...(game.user?.targets ?? [])]) {
        if (token?.actor && !ids.includes(token.id)) ids.push(token.id);
        if (ids.length === 2) break;
      }
      this.sideA = ids[0] ?? null;
      this.sideB = ids[1] ?? null;
    } catch { /* canvas may not be ready */ }
  }

  /** A side's token, or null when the slot is empty or the token has gone. */
  _token(tokenId) {
    return tokenId ? (canvas.tokens?.get(tokenId) ?? null) : null;
  }

  /** Card-sized descriptor for one side, or null when unassigned. */
  _sideData(tokenId, check) {
    const token = this._token(tokenId);
    return {
      check: checkLabel(check),
      filled: !!token,
      name: token ? (token.name ?? token.actor.name) : "",
      // Actor art rather than the token texture, matching how the card draws rows.
      img: token ? (token.actor?.img ?? token.document.texture?.src) : "",
      hidden: token?.document?.hidden ?? false,
    };
  }

  /** The compound roll-mode/visibility value the <select> carries. */
  _rollModeOption() {
    return `${this.rollMode}|${this.showResults ? "show" : "hidden"}`;
  }

  // ---- Context ----

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const contest = this._contest();

    context.contests = OPPOSED_CONTESTS.map(c => ({
      key: c.key,
      label: game.i18n.localize(c.label),
      selected: c.key === this.contest,
    }));

    context.sideA = this._sideData(this.sideA, contest.a);
    context.sideB = this._sideData(this.sideB, contest.b);
    context.ready = context.sideA.filled && context.sideB.filled;

    context.tokens = this._sceneTokens().map(t => ({
      id: t.id,
      name: t.name ?? t.actor.name,
      img: t.actor?.img ?? t.document.texture?.src,
      hidden: t.document.hidden,
      side: t.id === this.sideA ? "A" : t.id === this.sideB ? "B" : null,
    }));

    context.rollModeOption = this._rollModeOption();
    context.flavor = this.flavor;
    return context;
  }

  // ---- Render: bind the inputs that don't need a re-render ----

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    el.querySelector("#oc-contest")?.addEventListener("change", (e) => {
      this.contest = e.currentTarget.value;
      this.render();
    });
    el.querySelector("#oc-rollmode")?.addEventListener("change", (e) => {
      const [mode, vis] = e.currentTarget.value.split("|");
      this.rollMode = mode;
      this.showResults = vis === "show";
    });
    el.querySelector("#oc-flavor")?.addEventListener("blur", (e) => {
      this.flavor = e.currentTarget.value;
    });
  }

  // ---- Actions ----

  /**
   * Clicking a token row fills the first empty side, or empties the side it
   * already holds. With both sides full a third click is refused rather than
   * silently displacing one of them.
   */
  static #onToggleToken(_event, target) {
    const id = target.dataset.tokenId;
    if (!id) return;

    if (this.sideA === id) this.sideA = null;
    else if (this.sideB === id) this.sideB = null;
    else if (!this.sideA) this.sideA = id;
    else if (!this.sideB) this.sideB = id;
    else {
      ui.notifications.warn(game.i18n.localize("RR.OC.Notif.TwoOnly"));
      return;
    }
    this.render();
  }

  static #onSwapSides() {
    [this.sideA, this.sideB] = [this.sideB, this.sideA];
    this.render();
  }

  static async #onRequestOpposed() {
    const api = game.pf1RollRequests;
    if (!api?.createRequest) {
      ui.notifications.error(game.i18n.localize("RR.OC.Notif.ApiUnavailable"));
      return;
    }
    if (!this._token(this.sideA) || !this._token(this.sideB)) {
      ui.notifications.warn(game.i18n.localize("RR.OC.Notif.NeedTwo"));
      return;
    }

    const contest = this._contest();
    // Each side carries its own check on its target entry; the card's top-level
    // request stays the initiating side's, which is what a target with no
    // override of its own would fall back to.
    const message = await api.createRequest({
      ...contest.a,
      name: game.i18n.localize(contest.label),
      mode: "targeted",
      targetedActors: [
        { id: this.sideA, check: { ...contest.a, name: checkLabel(contest.a) } },
        { id: this.sideB, check: { ...contest.b, name: checkLabel(contest.b) } },
      ],
      dc: null,
      includeAid: false,
      rollMode: this.rollMode,
      showResults: this.showResults,
      flavor: this.flavor,
      opposed: true,
      summaryKey: OPPOSED_SUMMARY_KEY,
    });
    if (message) this.close();
  }

  // ---- Lifecycle / Singleton ----

  static _instance = null;

  async _onClose(options) {
    await super._onClose(options);
    OpposedCheck._instance = null;
  }

  static openWindow() {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.OC.Notif.GMOnly"));
      return;
    }
    if (!OpposedCheck._instance) OpposedCheck._instance = new OpposedCheck();
    OpposedCheck._instance.render(true);
  }
}

// ============================================================
// Outcome
//
// Recomputed from the card's flags on every roll, like every other derived
// slot, so a result applied or replaced later re-decides the contest with no
// extra bookkeeping.
// ============================================================

/** Summary key shared between opposed requests and their formatter. */
export const OPPOSED_SUMMARY_KEY = "pf1-opposed-check";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * A result's check modifier — everything the roll added to the die. Recovered
 * from the total rather than stored, so an applied roll and a rolled one are
 * read the same way. Null when the entry has no natural die to subtract.
 *
 * @param {object} entry
 * @returns {number|null}
 */
function entryModifier(entry) {
  return (isNum(entry?.total) && isNum(entry?.naturalRoll)) ? entry.total - entry.naturalRoll : null;
}

/**
 * Decide an opposed card, or null while it is still undecidable (not an opposed
 * card, not exactly two sides, or a side that has yet to roll).
 *
 * RAW: the higher total wins, a tie goes to the higher check modifier, and two
 * identical modifiers call for a reroll — which is the one case with no winner.
 *
 * @param {object} flags - The card's current flag state.
 * @returns {{winner: string|null, name: string, tieBroken: boolean}|null}
 */
export function opposedOutcome(flags) {
  if (!flags?.opposed) return null;
  const targets = flags.targetedActors ?? [];
  if (targets.length !== 2) return null;

  const results = flags.actorResults ?? {};
  const entries = targets.map(t => results[t.id]);
  if (!entries.every(e => isNum(e?.total))) return null;

  let index = null;
  let tieBroken = false;

  if (entries[0].total !== entries[1].total) {
    index = entries[0].total > entries[1].total ? 0 : 1;
  } else {
    const mods = entries.map(entryModifier);
    if (mods.every(isNum) && mods[0] !== mods[1]) {
      index = mods[0] > mods[1] ? 0 : 1;
      tieBroken = true;
    }
  }

  if (index === null) return { winner: null, name: "", tieBroken: false };
  return {
    winner: targets[index].id,
    name: entries[index].actorName ?? targets[index].name ?? "",
    tieBroken,
  };
}

/**
 * The card's verdict line. Rendered into the summary slot, which already hides
 * itself from players on a card whose results they are not meant to see.
 *
 * @param {object} flags - The opposed card's current flag state.
 * @returns {string}
 */
export function opposedSummary(flags) {
  const outcome = opposedOutcome(flags);
  if (!outcome) return "";

  if (!outcome.winner) {
    return `<i class="fas fa-scale-balanced"></i> <strong>${game.i18n.localize("RR.OC.DeadTie")}</strong>`;
  }

  // The name is carried in a tagged span so per-viewer name obscuring can
  // rewrite it (see RollRequestChat._applyNameObscuring) — without that, a
  // banner baked in by the GM would hand players a randomized token's real name.
  const name = `<span class="arr-opposed-name" data-token-id="${outcome.winner}">`
    + `${foundry.utils.escapeHTML(outcome.name)}</span>`;
  const note = outcome.tieBroken
    ? ` <span class="arr-opposed-note">${game.i18n.localize("RR.OC.TieBreak")}</span>`
    : "";
  return `<i class="fas fa-crown"></i> <strong>${game.i18n.format("RR.OC.Winner", { name })}</strong>${note}`;
}
