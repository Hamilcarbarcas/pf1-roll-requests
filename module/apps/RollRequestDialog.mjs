// ============================================================
// Pathfinder 1e Roll Requests — Roll Request Dialog (ApplicationV2)
// ============================================================

import { getQuickActions } from "../roll-options.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

export class RollRequestDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  static _lastSettings = null;

  constructor(options = {}) {
    super(options);
    const s = RollRequestDialog._lastSettings;
    this.checkMode = s?.checkMode ?? "multi";
    this.dc = s?.dc ?? "";
    this.showDC = s?.showDC ?? false;
    this.showResults = s?.showResults ?? false;
    this.rollMode = s?.rollMode ?? "roll";
    this.flavor = s?.flavor ?? "";
    this.includeAid = s?.includeAid ?? true;
    this.selectedRequest = s?.selectedRequest ?? null;
    this.targetedActors = s?.targetedActors ?? [];
  }

  _saveSettings() {
    RollRequestDialog._lastSettings = {
      checkMode: this.checkMode,
      dc: this.dc,
      showDC: this.showDC,
      showResults: this.showResults,
      rollMode: this.rollMode,
      flavor: this.flavor,
      includeAid: this.includeAid,
      selectedRequest: this.selectedRequest,
      targetedActors: [...this.targetedActors],
    };
  }

  async _onClose(options) {
    this._saveSettings();
    return super._onClose(options);
  }

  // ---- AppV2 Configuration ----

  static DEFAULT_OPTIONS = {
    id: "pf1-roll-request-dialog",
    tag: "form",
    classes: ["pf1-roll-requests", "roll-request-dialog"],
    window: {
      title: "Request Roll",
      resizable: false,
    },
    actions: {
      selectOption: RollRequestDialog.#onSelectOption,
      requestRoll: RollRequestDialog.#onRequestRoll,
      quickAction: RollRequestDialog.#onQuickAction,
    },
    position: { width: 700 },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/roll-request-dialog.html` },
    footer: { template: "templates/generic/form-footer.hbs" },
  };

  // ---- Context ----

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    switch (partId) {
      case "body":
        return this._prepareBodyContext(context);
      case "footer":
        context.buttons = [
          {
            type: "button",
            icon: "fas fa-dice-d20",
            label: "Request Roll",
            action: "requestRoll",
          },
        ];
        return context;
    }
    return context;
  }

  _prepareBodyContext(context) {
    // Build the request option groups
    const abilities = {};
    for (const [key, label] of Object.entries(pf1.config.abilities)) {
      abilities[key] = typeof label === "string" ? label : game.i18n.localize(label);
    }

    const saves = {};
    for (const [key, label] of Object.entries(pf1.config.savingThrows)) {
      saves[key] = typeof label === "string" ? label : game.i18n.localize(label);
    }

    // Skills — merge system defaults with custom skills from astora-mod
    const skills = this._getSkillOptions();

    const dice = {
      d4: "d4", d6: "d6", d8: "d8", d10: "d10", d12: "d12", d20: "d20",
    };

    const allGroups = [
      { id: "ability", text: "Ability Check", groups: abilities },
      { id: "save", text: "Saving Throw", groups: saves },
      { id: "skill", text: "Skill Check", groups: skills },
      { id: "dice", text: "Dice", groups: dice },
    ];

    // Quick Actions — execute immediately (built-in) or invoke a mod callback.
    const excludedQuick = new Set(game.settings.get(MODULE_ID, "excluded-quick-actions") ?? []);
    const quickItems = getQuickActions()
      .filter(qa => !excludedQuick.has(qa.key))
      .map(qa => ({ key: qa.key, label: qa.label, icon: qa.icon ?? "fa-bolt" }));
    if (quickItems.length > 0) {
      allGroups.push({ id: "quick", text: "Quick Actions", isQuickAction: true, items: quickItems });
    }

    // Hide any categories disabled in the Roll Options config.
    const excludedCats = new Set(game.settings.get(MODULE_ID, "excluded-categories") ?? []);
    const optionGroups = allGroups.filter(g => !excludedCats.has(g.id));

    // Build the "Prompt Actors" list from two sources, deduped by actor id.
    const targetedSet = new Set(this.targetedActors.map(a => a.id));
    const promptActors = this._getPromptActors(targetedSet);

    return foundry.utils.mergeObject(context, {
      checkMode: this.checkMode,
      dc: this.dc,
      showDC: this.showDC,
      showResults: this.showResults,
      rollMode: this.rollMode,
      rollModeOption: this._getRollModeOption(),
      flavor: this.flavor,
      includeAid: this.includeAid,
      optionGroups,
      selectedRequest: this.selectedRequest,
      promptActors,
    });
  }

  /**
   * Build the list of actors offered in Selection Check mode.
   *
   * Two sources, merged and deduped by actor id (configured PCs win):
   *   1. "assigned" — each non-GM user's configured character (always shown).
   *   2. "npc"      — NPC-type actors with a player owner that have a *linked*
   *                   token on the currently-viewed scene and are not blacklisted.
   *
   * @param {Set<string>} targetedSet - Actor ids currently checked, for restoring state.
   * @returns {Array<{id: string, name: string, img: string, source: string, checked: boolean}>}
   */
  _getPromptActors(targetedSet) {
    const rows = new Map();

    // Source 1: configured player characters (includes offline players).
    for (const user of game.users) {
      if (user.isGM || !user.character) continue;
      const c = user.character;
      if (rows.has(c.id)) continue;
      rows.set(c.id, { id: c.id, name: c.name, img: c.img, source: "assigned", checked: targetedSet.has(c.id) });
    }

    // Source 2: player-owned, linked NPCs with a token on the current scene.
    const blacklist = new Set(game.settings.get(MODULE_ID, "npc-blacklist") ?? []);
    const sceneActorIds = new Set(
      (canvas.scene?.tokens ?? [])
        .filter(t => t.actorLink && t.actorId)
        .map(t => t.actorId)
    );
    for (const id of sceneActorIds) {
      if (rows.has(id) || blacklist.has(id)) continue;
      const actor = game.actors.get(id);
      if (!actor || actor.type !== "npc" || !actor.hasPlayerOwner) continue;
      rows.set(id, { id, name: actor.name, img: actor.img, source: "npc", checked: targetedSet.has(id) });
    }

    // Configured PCs first, then NPCs; alphabetical within each group.
    return [...rows.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source === "assigned" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Add an actor to the persistent blacklist so it no longer appears as a
   * player-owned NPC option, then refresh the dialog.
   *
   * @param {string} actorId
   */
  async _excludeActor(actorId) {
    const list = new Set(game.settings.get(MODULE_ID, "npc-blacklist") ?? []);
    list.add(actorId);
    await game.settings.set(MODULE_ID, "npc-blacklist", [...list]);
    // Drop it from the current selection if it was checked.
    this.targetedActors = this.targetedActors.filter(a => a.id !== actorId);
    const actor = game.actors.get(actorId);
    ui.notifications.info(`${actor?.name ?? "Actor"} excluded from the roll-request prompt list.`);
    this.render();
  }

  /** Context-menu entries for right-clicking a player-owned NPC row. */
  _getActorContextOptions() {
    return [
      {
        name: "Exclude from List",
        icon: '<i class="fa-solid fa-eye-slash"></i>',
        callback: (target) => {
          const el = target instanceof HTMLElement ? target : target[0];
          const actorId = el?.dataset.actorId;
          if (actorId) this._excludeActor(actorId);
        },
      },
    ];
  }

  // ---- Quick Actions ----

  static async #onQuickAction(event, target) {
    const action = getQuickActions().find(a => a.key === target.dataset.key);
    if (!action) return;

    let selectedActors = null;
    if (action.promptActors) {
      const ids = await this._promptActorSelection(action.label);
      if (ids === null) return; // cancelled / no eligible actors
      if (ids.length === 0) {
        ui.notifications.warn("Please select at least one actor to prompt.");
        return;
      }
      selectedActors = ids
        .map(id => game.actors.get(id))
        .filter(Boolean)
        .map(a => ({ id: a.id, name: a.name, img: a.img }));
    } else if (action.allActors) {
      // Pass every eligible actor without prompting.
      selectedActors = this._getPromptActors(new Set())
        .map(a => ({ id: a.id, name: a.name, img: a.img }));
    }

    // External (mod-provided) quick action: invoke its callback.
    if (typeof action.callback === "function") {
      try {
        await action.callback({ app: this, actors: selectedActors, event });
      } catch (err) {
        console.error(`pf1-roll-requests | Quick action '${action.key}' threw:`, err);
        ui.notifications.error(`Quick action "${action.label}" failed; see console.`);
      }
      if (action.closeOnUse) this.close();
      return;
    }

    // Built-in declarative quick action.
    this._executeQuickAction(action, selectedActors ?? []);
  }

  /**
   * Public helper for external quick actions: the actors eligible for the
   * Prompt Actors / Quick Action picker (configured PCs + player-owned NPCs
   * with a linked token on the current scene), minus blacklisted ones.
   *
   * @returns {Array<{id: string, name: string, img: string, source: string}>}
   */
  getEligibleActors() {
    return this._getPromptActors(new Set())
      .map(a => ({ id: a.id, name: a.name, img: a.img, source: a.source }));
  }

  /**
   * Show a popup to pick which actors a quick action prompts. Uses the same
   * actor list as the main Prompt Actors checklist, all selected by default.
   *
   * @param {string} label - The quick action's label (for the title).
   * @returns {Promise<string[]|null>} Selected actor ids, or null if cancelled.
   */
  async _promptActorSelection(label) {
    const actors = this._getPromptActors(new Set());
    if (actors.length === 0) {
      ui.notifications.warn("No eligible actors to prompt.");
      return null;
    }

    const content = await renderTemplate(
      `modules/${MODULE_ID}/templates/quick-actor-select.html`,
      { label, actors }
    );

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: `${label} — Select Actors`, icon: "fa-solid fa-eye" },
      classes: ["pf1-roll-requests"],
      position: { width: 320 },
      content,
      buttons: [
        {
          action: "prompt",
          label: "Prompt",
          icon: "fas fa-dice-d20",
          default: true,
          callback: (_event, _button, dialog) => {
            const root = dialog.element;
            return [...root.querySelectorAll(".arr-actor-checkbox:checked")].map(cb => cb.dataset.actorId);
          },
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" },
      ],
      rejectClose: false,
    });

    return Array.isArray(result) ? result : null;
  }

  /**
   * Fire a quick action's pre-configured roll request, bypassing the left panel.
   *
   * @param {QuickAction} action
   * @param {Array<{id: string, name: string, img: string}>} selectedActors
   */
  _executeQuickAction(action, selectedActors) {
    const cfg = action.config;
    const isTargeted = cfg.mode === "targeted";

    const requestData = {
      mode: cfg.mode,
      dc: cfg.dc,
      showDC: cfg.showDC,
      showResults: cfg.showResults,
      rollMode: cfg.rollMode,
      flavor: "",
      includeAid: cfg.includeAid,
      request: action.request,
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
      targetedActors: isTargeted ? selectedActors : [],
      actorResults: {},
      actorAidResults: {},
      usedActorIds: [],
    };

    import("./RollRequestChat.mjs").then(({ RollRequestChat }) => {
      RollRequestChat.createChatCard(requestData);
    });

    this.close();
  }

  _getSkillOptions() {
    const skills = {};

    // System-defined skills
    for (const [key, label] of Object.entries(pf1.config.skills)) {
      skills[key] = typeof label === "string" ? label : game.i18n.localize(label);
    }

    // Custom skills from astora-mod (added via preCreateActor hook)
    const customSkills = {
      ahy: "Autohypnosis",
      csh: "Control Shape",
      psi: "Psicraft",
      kps: "Knowledge (Psionics)",
    };
    for (const [key, name] of Object.entries(customSkills)) {
      if (!skills[key]) skills[key] = name;
    }

    // Sort alphabetically by display name
    const sorted = Object.entries(skills).sort((a, b) => a[1].localeCompare(b[1]));
    return Object.fromEntries(sorted);
  }

  // ---- Compute compound roll mode option value ----

  _getRollModeOption() {
    if (this.rollMode === "roll" || this.rollMode === "gmroll" || this.rollMode === "publicblind") {
      return this.showResults ? `${this.rollMode}|show` : `${this.rollMode}|hidden`;
    }
    return this.rollMode; // blindroll
  }

  // ---- After Render — bind form listeners ----

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;

    // Actor selection visibility depends on checkMode
    const actorSelectionEl = el.querySelector(".arr-actor-selection");
    const syncActorSelectionVisibility = () => {
      if (actorSelectionEl) {
        actorSelectionEl.style.display = this.checkMode === "selection" ? "" : "none";
      }
    };

    // Check mode radios — also toggle actor selection visibility
    el.querySelectorAll('input[name="checkMode"]').forEach(radio => {
      radio.addEventListener("change", (e) => {
        this.checkMode = e.currentTarget.value;
        syncActorSelectionVisibility();
      });
    });

    el.querySelector("#arr-dc")?.addEventListener("blur", (e) => { this.dc = e.currentTarget.value; });
    el.querySelector("#arr-show-dc")?.addEventListener("change", (e) => { this.showDC = e.currentTarget.checked; });
    el.querySelector("#arr-rollmode")?.addEventListener("change", (e) => {
      const val = e.currentTarget.value;
      if (val.includes("|")) {
        const [mode, vis] = val.split("|");
        this.rollMode = mode;
        this.showResults = vis === "show";
      } else {
        this.rollMode = val;
        this.showResults = false;
      }
      if (this.rollMode === "blindroll") {
        this.includeAid = false;
        const aidCb = el.querySelector("#arr-include-aid");
        if (aidCb) aidCb.checked = false;
      }
    });
    el.querySelector("#arr-flavor")?.addEventListener("blur", (e) => { this.flavor = e.currentTarget.value; });
    el.querySelector("#arr-include-aid")?.addEventListener("change", (e) => { this.includeAid = e.currentTarget.checked; });

    // Actor checkboxes
    el.querySelectorAll(".arr-actor-checkbox").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const actorId = e.currentTarget.dataset.actorId;
        if (e.currentTarget.checked) {
          if (!this.targetedActors.find(a => a.id === actorId)) {
            const actor = game.actors.get(actorId);
            if (actor) this.targetedActors.push({ id: actorId, name: actor.name, img: actor.img });
          }
        } else {
          this.targetedActors = this.targetedActors.filter(a => a.id !== actorId);
        }
      });
    });

    // Right-click a player-owned NPC row to exclude it from the prompt list.
    // ContextMenu.create() is V1-only; AppV2 must instantiate the namespaced class.
    new foundry.applications.ux.ContextMenu(
      el,
      ".arr-actor-check-label[data-source='npc']",
      this._getActorContextOptions(),
      { jQuery: false, fixed: true }
    );

    this._syncAidCheckbox();
  }

  _syncAidCheckbox() {
    const checkbox = this.element?.querySelector("#arr-include-aid");
    if (!checkbox) return;
    const disableAid = this.selectedRequest?.type === "save" || this.selectedRequest?.type === "dice";
    checkbox.disabled = disableAid;
    const group = checkbox.closest(".form-group");
    if (group) group.style.opacity = disableAid ? "0.4" : "";
  }

  // ---- Actions ----

  static #onSelectOption(_event, target) {
    const type = target.dataset.type;
    const key = target.dataset.key;
    const name = target.textContent.trim();

    // Deselect all, then select clicked
    this.element.querySelectorAll(".request-option.selected").forEach(el => el.classList.remove("selected"));
    target.classList.add("selected");

    this.selectedRequest = { type, key, name };
    this._syncAidCheckbox();
  }

  static #onRequestRoll(_event, _target) {
    if (!this.selectedRequest) {
      ui.notifications.warn("Please select a check type before requesting a roll.");
      return;
    }

    // Force includeAid off for dice-type and save-type requests
    const includeAid = (this.selectedRequest.type === "dice" || this.selectedRequest.type === "save") ? false : this.includeAid;

    // Selection Check requires at least one actor to be chosen
    if (this.checkMode === "selection" && this.targetedActors.length === 0) {
      ui.notifications.warn("Please select at least one actor to prompt.");
      return;
    }

    const isTargeted = this.checkMode === "selection" && this.selectedRequest.type !== "dice";
    const mode = isTargeted ? "targeted" : this.checkMode === "selection" ? "single" : this.checkMode;

    const requestData = {
      mode,
      dc: this.dc !== "" ? Number(this.dc) : null,
      showDC: this.showDC,
      showResults: this.showResults,
      rollMode: this.rollMode,
      flavor: this.flavor,
      includeAid,
      request: this.selectedRequest,
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
      // Targeted mode data
      targetedActors: isTargeted ? this.targetedActors : [],
      actorResults: {},
      actorAidResults: {},
      usedActorIds: [],
    };

    // Import dynamically to avoid circular deps
    import("./RollRequestChat.mjs").then(({ RollRequestChat }) => {
      RollRequestChat.createChatCard(requestData);
    });

    this.close();
  }
}
