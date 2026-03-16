// ============================================================
// Pathfinder 1e Check Roll Requests — Main Module Entry
// ============================================================

import { RollRequestDialog } from "./apps/RollRequestDialog.mjs";
import { RollRequestChat } from "./apps/RollRequestChat.mjs";
import { SocketHandler } from "./SocketHandler.mjs";

const MODULE_ID = "pf1-roll-requests";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Pathfinder 1e Roll Requests`);
  game.pf1RollRequests = { MODULE_ID };
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  SocketHandler.register();
});

// ---- Render interactive elements on chat cards ----
Hooks.on("renderChatMessageHTML", (message, html, data) => {
  RollRequestChat.onRenderChatMessage(message, html, data);
});

// ---- Register a scene-control button or macro-friendly API ----
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tokenControls = controls.tokens ?? controls.find?.(c => c.name === "token");
  if (tokenControls) {
    tokenControls.tools["pf1-roll-request"] = {
      name: "pf1-roll-request",
      title: "Request Roll",
      icon: "fas fa-dice-d20",
      button: true,
      toggle: false,
      onClick: () => new RollRequestDialog().render(true),
    };
  }
});

// Public API for macros: `game.pf1RollRequests.requestRoll()`
Hooks.once("ready", () => {
  game.pf1RollRequests.requestRoll = () => {
    if (!game.user.isGM) {
      ui.notifications.warn("Only the GM can create roll requests.");
      return;
    }
    new RollRequestDialog().render(true);
  };

  /**
   * Programmatically create a roll request chat card.
   *
   * @param {object} options
   * @param {string} options.type        - "ability", "save", "skill", or "dice"
   * @param {string} options.key         - The key for the check (e.g. "str", "ref", "per", "d20")
   * @param {string} [options.name]      - Display name (auto-resolved from key if omitted)
   * @param {string} [options.mode="multi"]       - "single" or "multi"
   * @param {number|null} [options.dc=null]       - The DC (null for no DC)
   * @param {boolean} [options.showDC=false]      - Whether the DC number is visible to players
   * @param {boolean} [options.showResults=false]  - Whether pass/fail indicators are visible to players
   * @param {string} [options.rollMode="roll"]    - "roll", "gmroll", or "blindroll"
   * @param {string} [options.flavor=""]          - Flavor text
   * @param {boolean} [options.includeAid=true]   - Whether Aid Another is included (single mode only; forced off for dice)
   * @param {boolean} [options.awaitResult=false]  - If true, returns a Promise that resolves with the
   *   primary roll result once a player completes the roll. Only works with mode "single".
   *   The promise resolves with an object: { messageId, total, actorName, actorImg, passed,
   *   naturalRoll, dc, formula, aidTotal, aidResults, notes }, or null if the card is deleted
   *   before the roll is completed.
   *
   * @returns {Promise<object|null>|undefined}  When awaitResult is true (single mode), returns
   *   a Promise. Otherwise returns undefined.
   *
   * @example
   * // Request a Perception skill check, DC 15, public roll with results hidden
   * game.pf1RollRequests.createRequest({ type: "skill", key: "per", dc: 15 });
   *
   * @example
   * // Request a Fortitude save, DC 18, showing DC and results to players
   * game.pf1RollRequests.createRequest({ type: "save", key: "fort", dc: 18, showDC: true, showResults: true });
   *
   * @example
   * // Single-check with awaitResult — waits for the player to roll, then gets the result
   * const result = await game.pf1RollRequests.createRequest({
   *   type: "skill", key: "dip", dc: 20, mode: "single", awaitResult: true,
   * });
   * if (result) console.log(`${result.actorName} rolled ${result.total} — ${result.passed ? "passed" : "failed"}`);
   */
  game.pf1RollRequests.createRequest = async (options = {}) => {
    if (!game.user.isGM) {
      ui.notifications.warn("Only the GM can create roll requests.");
      return;
    }

    const { type, key } = options;
    if (!type || !key) {
      ui.notifications.error("createRequest requires 'type' and 'key' parameters.");
      return;
    }

    const validTypes = ["ability", "save", "skill", "dice"];
    if (!validTypes.includes(type)) {
      ui.notifications.error(`Invalid type "${type}". Must be one of: ${validTypes.join(", ")}`);
      return;
    }

    // Resolve display name if not provided
    let name = options.name;
    if (!name) {
      if (type === "ability") {
        const label = pf1.config.abilities[key];
        name = label ? (typeof label === "string" ? label : game.i18n.localize(label)) : key;
      } else if (type === "save") {
        const label = pf1.config.savingThrows[key];
        name = label ? (typeof label === "string" ? label : game.i18n.localize(label)) : key;
      } else if (type === "skill") {
        const label = pf1.config.skills[key];
        name = label ? (typeof label === "string" ? label : game.i18n.localize(label)) : key;
      } else if (type === "dice") {
        name = key;
      }
    }

    const mode = options.mode ?? "multi";
    const dc = options.dc ?? null;
    const showDC = options.showDC ?? false;
    const showResults = options.showResults ?? false;
    const rollMode = options.rollMode ?? "roll";
    const flavor = options.flavor ?? "";
    const includeAid = type === "dice" ? false : (options.includeAid ?? true);

    const requestData = {
      mode,
      dc: dc != null ? Number(dc) : null,
      showDC,
      showResults,
      rollMode,
      flavor,
      includeAid,
      request: { type, key, name },
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
    };

    const awaitResult = options.awaitResult ?? false;
    const message = await RollRequestChat.createChatCard(requestData);

    // If awaitResult is requested for a single-check, return a Promise
    // that resolves when the primary roll is completed.
    if (awaitResult && mode === "single" && message) {
      return RollRequestChat.registerPendingResult(message.id);
    }
  };
});

// Clean up pending result promises when a roll-request card is deleted
Hooks.on("deleteChatMessage", (message) => {
  RollRequestChat.cancelPendingResult(message.id);
});
