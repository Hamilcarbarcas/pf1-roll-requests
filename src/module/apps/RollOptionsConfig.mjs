// ============================================================
// Pathfinder 1e Roll Requests — Roll Options Config (ApplicationV2)
// ============================================================
//
// Settings-menu window to show/hide whole roll categories and individual
// Quick Actions in the Roll Request dialog.

import { ROLL_CATEGORIES, getQuickActions } from "../roll-options.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

export class RollOptionsConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "pf1-roll-request-options",
    tag: "form",
    classes: ["pf1-roll-requests", "roll-options-config"],
    window: {
      title: "RR.Window.RollOptions",
      icon: "fa-solid fa-sliders",
      resizable: true,
    },
    actions: {
      save: RollOptionsConfig.#onSave,
    },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/roll-options-config.html` },
    footer: { template: "templates/generic/form-footer.hbs" },
  };

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (partId === "footer") {
      context.buttons = [
        { type: "button", icon: "fas fa-save", label: "RR.OptionsConfig.SaveChanges", action: "save" },
      ];
      return context;
    }

    const excludedCats = new Set(game.settings.get(MODULE_ID, "excluded-categories") ?? []);
    const excludedQuick = new Set(game.settings.get(MODULE_ID, "excluded-quick-actions") ?? []);

    context.categories = ROLL_CATEGORIES.map(c => ({
      id: c.id,
      label: game.i18n.localize(c.text),
      enabled: !excludedCats.has(c.id),
    }));
    context.quickActions = getQuickActions().map(q => ({
      key: q.key,
      label: game.i18n.localize(q.label),
      enabled: !excludedQuick.has(q.key),
    }));
    return context;
  }

  static async #onSave(event, _target) {
    event.preventDefault();
    const form = this.element;
    const excludedCategories = [...form.querySelectorAll('input[name="category"]:not(:checked)')].map(cb => cb.value);
    const excludedQuickActions = [...form.querySelectorAll('input[name="quick"]:not(:checked)')].map(cb => cb.value);
    await game.settings.set(MODULE_ID, "excluded-categories", excludedCategories);
    await game.settings.set(MODULE_ID, "excluded-quick-actions", excludedQuickActions);
    ui.notifications.info(game.i18n.localize("RR.Notif.RollOptionsUpdated"));
    this.close();
  }
}
