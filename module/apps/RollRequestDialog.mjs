// ============================================================
// Pathfinder 1e Roll Requests — Roll Request Dialog (ApplicationV2)
// ============================================================

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "pf1-roll-requests";

export class RollRequestDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(options = {}) {
    super(options);
    this.checkMode = "multi";      // "single" or "multi"
    this.dc = "";
    this.showDC = false;
    this.showResults = false;      // Whether pass/fail indicators are visible to players
    this.rollMode = "roll";        // roll, gmroll, blindroll
    this.flavor = "";
    this.includeAid = true;        // Whether single-check mode includes Aid Another
    this.selectedRequest = null;   // { type, key, name }
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

    const optionGroups = [
      { id: "ability", text: "Ability Check", groups: abilities },
      { id: "save", text: "Saving Throw", groups: saves },
      { id: "skill", text: "Skill Check", groups: skills },
      { id: "dice", text: "Dice", groups: dice },
    ];

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
    });
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
    if (this.rollMode === "roll" || this.rollMode === "gmroll") {
      return this.showResults ? `${this.rollMode}|show` : `${this.rollMode}|hidden`;
    }
    return this.rollMode; // blindroll
  }

  // ---- After Render — bind form listeners ----

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Bind form fields to instance properties
    const el = this.element;
    el.querySelectorAll('input[name="checkMode"]').forEach(radio => {
      radio.addEventListener("change", (e) => { this.checkMode = e.currentTarget.value; });
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
    });
    el.querySelector("#arr-flavor")?.addEventListener("blur", (e) => { this.flavor = e.currentTarget.value; });
    el.querySelector("#arr-include-aid")?.addEventListener("change", (e) => { this.includeAid = e.currentTarget.checked; });
  }

  // ---- Actions ----

  static #onSelectOption(event, target) {
    const type = target.dataset.type;
    const key = target.dataset.key;
    const name = target.textContent.trim();

    // Deselect all, then select clicked
    this.element.querySelectorAll(".request-option.selected").forEach(el => el.classList.remove("selected"));
    target.classList.add("selected");

    this.selectedRequest = { type, key, name };
  }

  static #onRequestRoll(event, target) {
    if (!this.selectedRequest) {
      ui.notifications.warn("Please select a check type before requesting a roll.");
      return;
    }

    // Force includeAid off for dice-type requests
    const includeAid = this.selectedRequest.type === "dice" ? false : this.includeAid;

    const requestData = {
      mode: this.checkMode,
      dc: this.dc !== "" ? Number(this.dc) : null,
      showDC: this.showDC,
      showResults: this.showResults,
      rollMode: this.rollMode,
      flavor: this.flavor,
      includeAid,
      request: this.selectedRequest,
      rolledActors: {},     // tokenId -> roll result data
      aidResults: {},       // tokenId -> { total, bonus }
      aidTotal: 0,
    };

    // Import dynamically to avoid circular deps
    import("./RollRequestChat.mjs").then(({ RollRequestChat }) => {
      RollRequestChat.createChatCard(requestData);
    });

    this.close();
  }
}
