// ============================================================
// Pathfinder 1e Roll Requests — Excluded-Actor Manager (ApplicationV2)
// ============================================================

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

/**
 * Settings-menu window listing actors excluded from the Selection Check
 * prompt list, with a per-row control to restore them.
 */
export class BlacklistConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "pf1-roll-request-blacklist",
    tag: "div",
    classes: ["pf1-roll-requests", "roll-request-blacklist"],
    window: {
      title: "RR.Window.Blacklist",
      icon: "fa-solid fa-user-slash",
      resizable: true,
    },
    actions: {
      removeActor: BlacklistConfig.#onRemoveActor,
    },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/blacklist-config.html` },
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const ids = game.settings.get(MODULE_ID, "npc-blacklist") ?? [];
    context.actors = ids
      .map(id => {
        const actor = game.actors.get(id);
        return {
          id,
          name: actor?.name ?? game.i18n.format("RR.Blacklist.MissingActor", { id }),
          img: actor?.img ?? "icons/svg/mystery-man.svg",
          missing: !actor,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return context;
  }

  static async #onRemoveActor(_event, target) {
    const actorId = target.dataset.actorId;
    if (!actorId) return;
    const list = (game.settings.get(MODULE_ID, "npc-blacklist") ?? []).filter(id => id !== actorId);
    await game.settings.set(MODULE_ID, "npc-blacklist", list);
    this.render();
  }
}
