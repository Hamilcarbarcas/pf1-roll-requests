// ============================================================
// PF1 Roll Requests — Action Check Config
// Injects "Skill" and "Ability" options into an item action's
// Saving Throw "Type" dropdown. Because the PF1 system's
// `save.type` field only understands fort/ref/will, the extended
// check config is stored in a module flag on the parent item,
// keyed by action id:
//
//   flags["pf1-roll-requests"].checks[<actionId>] = {
//     type: "skill" | "ability",
//     key: "<skillKey>" | "<abilityKey>",
//     dc: "<formula>",          // resolved at card-conversion time
//     description: "<effect>",
//   }
//
// A configured check is mutually exclusive with a real saving
// throw on the same action (one Type field, one choice).
// The auto-conversion side (SaveAutoRequest) reads this flag off
// the originating action to build a targeted roll-request card,
// exactly as it does for saves.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

// Sentinel values for the two options we splice into the save.type
// <select>. They are never written to the system field — we strip the
// select's `name` so it no longer participates in the sheet's form submit
// and handle all of its changes ourselves.
const SKILL_OPT = "__rr_skill__";
const ABILITY_OPT = "__rr_ability__";

export class ActionCheckConfig {

  // ----------------------------------------------------------
  // renderItemActionSheet hook entry point
  // ----------------------------------------------------------

  static onRenderActionSheet(app, html) {
    const action = app?.action;
    const item = app?.item ?? action?.item;
    if (!action || !item) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    const typeSelect = root.querySelector('select[name="save.type"]');
    if (!typeSelect) return;

    const actionId = action.id;
    const config = item.getFlag(MODULE_ID, "checks")?.[actionId] ?? null;
    const isCheck = config?.type === "skill" || config?.type === "ability";

    // --- Splice our two options into the Type dropdown ---
    const optSkill = document.createElement("option");
    optSkill.value = SKILL_OPT;
    optSkill.textContent = game.i18n.localize("RR.Action.SkillCheck");
    const optAbility = document.createElement("option");
    optAbility.value = ABILITY_OPT;
    optAbility.textContent = game.i18n.localize("RR.Action.AbilityCheck");
    typeSelect.append(optSkill, optAbility);

    // Take the select out of the FormApplication's submit set — we own it.
    typeSelect.removeAttribute("name");

    // Reflect the stored state (the system rendered "None" since save.type is empty).
    if (isCheck) typeSelect.value = config.type === "skill" ? SKILL_OPT : ABILITY_OPT;

    typeSelect.addEventListener("change", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ActionCheckConfig._onTypeChange(item, action, config, typeSelect.value);
    });

    // --- Inject the picker / DC / effect controls for an active check ---
    if (isCheck) ActionCheckConfig._injectCheckControls(typeSelect, item, action, config);
  }

  // ----------------------------------------------------------
  // Type dropdown changed
  // ----------------------------------------------------------

  static async _onTypeChange(item, action, config, value) {
    const actionId = action.id;

    if (value === SKILL_OPT || value === ABILITY_OPT) {
      const type = value === SKILL_OPT ? "skill" : "ability";
      const key = type === "skill" ? ActionCheckConfig._firstSkillKey() : "str";
      const newCfg = {
        type,
        key: config?.key && config?.type === type ? config.key : key,
        dc: config?.dc ?? "",
        description: config?.description ?? "",
      };
      // Store our config first (so the re-render shows the check UI immediately),
      // then clear the mutually-exclusive system save.
      await item.setFlag(MODULE_ID, `checks.${actionId}`, newCfg);
      await action.update({ "save.type": "", "save.dc": "" });
    } else {
      // A real save type (fort/ref/will) or None — drop our config and let the
      // system field own the value again.
      if (config) await item.unsetFlag(MODULE_ID, `checks.${actionId}`);
      await action.update({ "save.type": value ?? "" });
    }
  }

  // ----------------------------------------------------------
  // Inject skill/ability picker + DC + effect below the Type row
  // ----------------------------------------------------------

  static _injectCheckControls(typeSelect, item, action, config) {
    const typeGroup = typeSelect.closest(".form-group");
    if (!typeGroup) return;
    const actionId = action.id;

    const options = config.type === "skill"
      ? ActionCheckConfig._skillOptions()
      : ActionCheckConfig._abilityOptions();
    const pickerLabel = config.type === "skill"
      ? game.i18n.localize("RR.Action.Skill")
      : game.i18n.localize("RR.Action.Ability");

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const optsHtml = Object.entries(options)
      .map(([k, label]) => `<option value="${k}"${k === config.key ? " selected" : ""}>${esc(label)}</option>`)
      .join("");

    const container = document.createElement("div");
    container.className = "rr-action-check-config";
    container.innerHTML = `
      <div class="form-group input-select">
        <label>${game.i18n.localize("PF1.DCFormula")}</label>
        <div class="form-fields">
          <input class="formula rr-check-dc" type="text" value="${esc(String(config.dc ?? ""))}" placeholder="0">
          <select class="rr-check-key" aria-label="${esc(pickerLabel)}">${optsHtml}</select>
        </div>
      </div>
      <div class="form-group input-select">
        <label>${game.i18n.localize("RR.Action.CheckEffect")}</label>
        <div class="form-fields">
          <input class="rr-check-desc" type="text" value="${esc(String(config.description ?? ""))}" placeholder="${game.i18n.localize("PF1.DCDescriptionExample")}">
        </div>
      </div>`;

    typeGroup.after(container);

    // These controls persist straight to the flag. stopPropagation keeps their
    // change events from reaching the sheet's form-level submit handler (which
    // would trigger a redundant re-render mid-edit).
    const bind = (selector, leaf) => {
      const el = container.querySelector(selector);
      el?.addEventListener("change", (ev) => {
        ev.stopPropagation();
        item.setFlag(MODULE_ID, `checks.${actionId}.${leaf}`, el.value);
      });
    };
    bind(".rr-check-key", "key");
    bind(".rr-check-dc", "dc");
    bind(".rr-check-desc", "description");
  }

  // ----------------------------------------------------------
  // Display name for a configured check (used by both sides)
  // ----------------------------------------------------------

  static checkName(type, key) {
    if (type === "skill") return ActionCheckConfig._skillOptions()[key] ?? key;
    if (type === "ability") {
      const label = pf1.config.abilities[key];
      return label ? (typeof label === "string" ? label : game.i18n.localize(label)) : key;
    }
    return key;
  }

  // ----------------------------------------------------------
  // Option builders (mirrors RollRequestDialog, incl. astora skills)
  // ----------------------------------------------------------

  static _skillOptions() {
    const skills = {};
    for (const [key, label] of Object.entries(pf1.config.skills)) {
      skills[key] = typeof label === "string" ? label : game.i18n.localize(label);
    }
    // Custom skills contributed by astora-mod (added via a preCreateActor hook).
    const custom = {
      ahy: "RR.CustomSkill.ahy",
      csh: "RR.CustomSkill.csh",
      psi: "RR.CustomSkill.psi",
      kps: "RR.CustomSkill.kps",
    };
    for (const [key, nameKey] of Object.entries(custom)) {
      if (!skills[key]) skills[key] = game.i18n.localize(nameKey);
    }
    return Object.fromEntries(Object.entries(skills).sort((a, b) => a[1].localeCompare(b[1])));
  }

  static _abilityOptions() {
    const out = {};
    for (const [key, label] of Object.entries(pf1.config.abilities)) {
      out[key] = typeof label === "string" ? label : game.i18n.localize(label);
    }
    return out;
  }

  static _firstSkillKey() {
    return Object.keys(ActionCheckConfig._skillOptions())[0] ?? "per";
  }
}
