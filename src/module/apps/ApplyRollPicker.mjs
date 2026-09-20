// ============================================================
// Pathfinder 1e Roll Requests — Apply Roll picker (ApplicationV2)
// ============================================================
//
// Runs both directions of Apply Roll:
//   * "rolls" — a request card asking which chat rolls to pull in. Multi-select,
//     because a targeted card with several already-rolled targets is the case
//     the picker exists for.
//   * "requests" — a chat roll asking which open request should receive it.
//     Single pick; only reached when more than one request fits.

import { ApplyRoll } from "./ApplyRoll.mjs";
import { RollRequestChat } from "./RollRequestChat.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

/** Most candidate rolls listed at once. */
const DISPLAY_LIMIT = 20;

export class ApplyRollPicker extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "pf1-roll-request-apply",
    tag: "form",
    classes: ["pf1-roll-requests", "apply-roll-picker"],
    window: {
      title: "RR.Apply.PickerTitle",
      icon: "fa-solid fa-hand-holding-magic",
      resizable: true,
    },
    actions: {
      apply: ApplyRollPicker.#onApply,
      pickOne: ApplyRollPicker.#onPickOne,
    },
    position: { width: 460, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/apply-roll-picker.html` },
    footer: { template: "templates/generic/form-footer.hbs" },
  };

  /**
   * @param {object} config
   * @param {"rolls"|"requests"} config.pick - Which direction this picker runs.
   * @param {ChatMessage} [config.message] - The request's message (rolls mode).
   * @param {string|null} [config.slot] - Embed slot (rolls mode).
   * @param {ChatMessage} [config.sourceMessage] - The roll (requests mode).
   * @param {Array<object>} [config.rows] - Pre-collected candidates.
   */
  constructor(config = {}) {
    // Deliberately not forwarded: ApplicationV2 deep-merges its options, and a
    // ChatMessage passed through there would be walked as plain data.
    super({});
    this.pick = config.pick;
    this.requestMessage = config.message ?? null;
    this.slot = config.slot ?? null;
    this.sourceMessage = config.sourceMessage ?? null;
    this.rows = config.rows ?? [];
  }

  get title() {
    return game.i18n.localize(this.pick === "requests"
      ? "RR.Apply.PickerTitleRequest"
      : "RR.Apply.PickerTitle");
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);

    if (partId === "footer") {
      context.buttons = this.pick === "rolls"
        ? [{ type: "button", icon: "fas fa-check", label: "RR.Apply.ApplySelected", action: "apply" }]
        : [];
      return context;
    }

    context.isRolls = this.pick === "rolls";
    context.rows = context.isRolls ? this.#rollRows() : this.#requestRows();
    context.empty = context.rows.length === 0;
    // Said out loud rather than left implicit: a silently clipped list is how a
    // GM comes to believe the roll they are looking for was never eligible.
    context.truncated = this.rows.length > context.rows.length
      ? { shown: context.rows.length, total: this.rows.length }
      : null;
    context.emptyText = game.i18n.localize(context.isRolls
      ? "RR.Apply.NoCandidates"
      : "RR.Apply.NoRequests");
    return context;
  }

  /** Candidate rolls, as template rows. */
  #rollRows() {
    return this.rows.slice(0, DISPLAY_LIMIT).map((c, index) => ({
      index,
      img: c.actor.img,
      name: c.route.label,
      total: c.roll.total,
      when: foundry.utils.timeSince(c.message.timestamp),
      // An occupied slot is offered, not hidden — replacing an auto-rolled
      // result with the one the player made themselves is the common case.
      occupied: c.route.occupied,
      appliedAlready: c.appliedAlready,
      // Where the card takes aid, each row chooses which slot it fills.
      canAid: !!c.route.aidRollType && !c.route.aidOccupied,
    }));
  }

  /** Open requests a roll could go to, as template rows. */
  #requestRows() {
    return this.rows.slice(0, DISPLAY_LIMIT).map((r, index) => ({
      index,
      name: r.flags.request?.name ?? "",
      kind: RollRequestChat._getCheckKindLabel(r.flags),
      dc: r.flags.dc ?? null,
      when: foundry.utils.timeSince(r.message.timestamp),
      occupied: r.route.occupied,
      target: r.route.label,
    }));
  }

  static async #onApply(event) {
    event.preventDefault();
    const form = this.element;
    const picked = [...form.querySelectorAll('input[name="candidate"]:checked')]
      .map(cb => Number(cb.value));
    if (!picked.length) {
      ui.notifications.warn(game.i18n.localize("RR.Apply.NothingPicked"));
      return;
    }

    let applied = 0;
    for (const index of picked) {
      const candidate = this.rows[index];
      if (!candidate) continue;
      const asAid = !!form.querySelector(`input[name="asAid"][value="${index}"]`)?.checked;
      const ok = await ApplyRoll.apply(this.requestMessage, this.slot, candidate.message, {
        asAid,
        // The picker already showed which rows replace a result, and a batch
        // must not stop on a modal per row.
        confirmed: picked.length > 1,
      });
      if (ok) applied++;
    }

    if (applied) {
      ui.notifications.info(game.i18n.format("RR.Apply.Applied", { count: applied }));
    }
    this.close();
  }

  static async #onPickOne(event, target) {
    event.preventDefault();
    const row = this.rows[Number(target.dataset.index)];
    if (!row) return;
    this.close();
    const asAid = await ApplyRollPicker.promptRole(row.route);
    if (asAid === null) return;
    await ApplyRoll.apply(row.message, row.slot, this.sourceMessage, { asAid });
  }

  // ----------------------------------------------------------
  // Entry points
  // ----------------------------------------------------------

  /** Open the picker for a request card's Apply Roll button. */
  static async forRequest(message, slot = null) {
    const rows = ApplyRoll.candidatesFor(message, slot);
    if (!rows.length) {
      ui.notifications.warn(game.i18n.localize("RR.Apply.NoCandidates"));
      return null;
    }
    const app = new ApplyRollPicker({ pick: "rolls", message, slot, rows });
    app.render(true);
    return app;
  }

  /** Route a chat roll to a request: straight through when only one fits. */
  static async forRoll(sourceMessage) {
    const rows = ApplyRoll.requestsFor(sourceMessage);
    if (!rows.length) {
      ui.notifications.warn(game.i18n.localize("RR.Apply.NoRequests"));
      return null;
    }
    if (rows.length === 1) {
      const [only] = rows;
      const asAid = await ApplyRollPicker.promptRole(only.route);
      if (asAid === null) return null;
      await ApplyRoll.apply(only.message, only.slot, sourceMessage, { asAid });
      return null;
    }
    const app = new ApplyRollPicker({ pick: "requests", sourceMessage, rows });
    app.render(true);
    return app;
  }

  /**
   * Which slot a roll should fill where the card offers both. Answers false
   * without asking wherever only one of them is open.
   *
   * @param {object} route - Route descriptor from ApplyRoll.routeFor.
   * @returns {Promise<boolean|null>} true for aid, false for the check itself,
   *   null when the GM backed out.
   */
  static async promptRole(route) {
    const ambiguous = !!route.aidRollType && !route.aidOccupied && !route.occupied;
    if (!ambiguous) return false;

    const choice = await DialogV2.wait({
      window: { title: game.i18n.localize("RR.Apply.RoleTitle") },
      content: `<p>${game.i18n.format("RR.Apply.RoleBody", { name: route.label })}</p>`,
      buttons: [
        { action: "check", icon: "fas fa-dice-d20", label: "RR.Apply.RoleCheck", default: true },
        { action: "aid", icon: "fas fa-hands-helping", label: "RR.Apply.RoleAid" },
      ],
      rejectClose: false,
      modal: true,
    });

    if (choice === "aid") return true;
    if (choice === "check") return false;
    return null;
  }
}
