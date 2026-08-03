// ============================================================
// Pathfinder 1e Check Roll Requests — Main Module Entry
// ============================================================

import { RollRequestDialog } from "./apps/RollRequestDialog.mjs";
import { RollRequestChat } from "./apps/RollRequestChat.mjs";
import { SaveAutoRequest } from "./apps/SaveAutoRequest.mjs";
import { ActionCheckConfig } from "./apps/ActionCheckConfig.mjs";
import { BlacklistConfig } from "./apps/BlacklistConfig.mjs";
import { RollOptionsConfig } from "./apps/RollOptionsConfig.mjs";
import { registerQuickAction, unregisterQuickAction, getQuickActions } from "./roll-options.mjs";
import { MONSTER_LORE_SUMMARY_KEY, monsterLoreSummary } from "./apps/MonsterLore.mjs";
import { SocketHandler } from "./SocketHandler.mjs";

const MODULE_ID = "pf1-roll-requests";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Pathfinder 1e Roll Requests`);
  game.pf1RollRequests = { MODULE_ID };

  // Public API for other modules to contribute Quick Action buttons.
  game.pf1RollRequests.registerQuickAction = registerQuickAction;
  game.pf1RollRequests.unregisterQuickAction = unregisterQuickAction;
  game.pf1RollRequests.getQuickActions = getQuickActions;

  // Public API for registering card summary formatters (live aggregate displays).
  game.pf1RollRequests.registerSummary = RollRequestChat.registerSummary;
  game.pf1RollRequests.unregisterSummary = RollRequestChat.unregisterSummary;

  // Setting to auto-convert PF1 attack messages with saves into roll-request cards
  game.settings.register(MODULE_ID, "auto-save-request", {
    name: "RR.Settings.AutoSave.Name",
    hint: "RR.Settings.AutoSave.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Setting to toggle the token-control-bar button
  game.settings.register(MODULE_ID, "show-button", {
    name: "RR.Settings.ShowButton.Name",
    hint: "RR.Settings.ShowButton.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  // Setting to fall back to a user's configured actor when no token is selected.
  game.settings.register(MODULE_ID, "use-configured-actor", {
    name: "RR.Settings.UseConfiguredActor.Name",
    hint: "RR.Settings.UseConfiguredActor.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Setting to show a live highest/average aggregate on multi- and selection-check
  // cards once more than one result has come in.
  game.settings.register(MODULE_ID, "check-aggregate", {
    name: "RR.Settings.CheckAggregate.Name",
    hint: "RR.Settings.CheckAggregate.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      none: "RR.Settings.CheckAggregate.None",
      average: "RR.Settings.CheckAggregate.Average",
      highest: "RR.Settings.CheckAggregate.Highest",
    },
    default: "none",
  });

  // Setting to allow Aid Another to grant scaling bonuses for high check results.
  game.settings.register(MODULE_ID, "uncap-aid-another", {
    name: "RR.Settings.UncapAid.Name",
    hint: "RR.Settings.UncapAid.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // Persistent list of actor ids excluded from the Selection Check prompt list.
  game.settings.register(MODULE_ID, "npc-blacklist", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  // Settings-menu entry to view and restore excluded actors.
  game.settings.registerMenu(MODULE_ID, "npc-blacklist-menu", {
    name: "RR.Menu.Blacklist.Name",
    label: "RR.Menu.Blacklist.Label",
    hint: "RR.Menu.Blacklist.Hint",
    icon: "fa-solid fa-user-slash",
    type: BlacklistConfig,
    restricted: true,
  });

  // Hidden roll categories in the Roll Request dialog.
  game.settings.register(MODULE_ID, "excluded-categories", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  // Hidden Quick Actions in the Roll Request dialog.
  game.settings.register(MODULE_ID, "excluded-quick-actions", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  // Settings-menu entry to toggle categories and Quick Actions.
  game.settings.registerMenu(MODULE_ID, "roll-options-menu", {
    name: "RR.Menu.RollOptions.Name",
    label: "RR.Menu.RollOptions.Label",
    hint: "RR.Menu.RollOptions.Hint",
    icon: "fa-solid fa-sliders",
    type: RollOptionsConfig,
    restricted: true,
  });
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  SocketHandler.register();

  // Register the Monster Lore card summary (live "Questions earned" tally).
  RollRequestChat.registerSummary(MONSTER_LORE_SUMMARY_KEY, monsterLoreSummary);
});

// ---- Render interactive elements on chat cards ----
Hooks.on("renderChatMessageHTML", (message, html, data) => {
  SaveAutoRequest.onRenderChatMessage(message, html);
  RollRequestChat.onRenderChatMessage(message, html, data);
});

// ---- Inject skill/ability check options into the item-action sheet ----
Hooks.on("renderItemActionSheet", (app, html) => {
  ActionCheckConfig.onRenderActionSheet(app, html);
});

// ---- Register a scene-control button ----
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, "show-button")) return;

  const tokenControls = controls.tokens ?? controls.find?.(c => c.name === "token");
  if (tokenControls) {
    tokenControls.tools["pf1-roll-request"] = {
      name: "pf1-roll-request",
      title: game.i18n.localize("RR.Common.RequestRoll"),
      icon: "fas fa-dice-d20",
      button: true,
      toggle: false,
      onClick: () => new RollRequestDialog().render(true),
    };
  }
});

// Public API for macros: `game.pf1RollRequests.requestRoll()`
Hooks.once("ready", () => {
  game.pf1RollRequests.bulkRollTargeted = async (message) => {
    if (!game.user.isGM) return;
    return RollRequestChat._bulkRollTargeted(message);
  };

  game.pf1RollRequests.requestRoll = () => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }
    new RollRequestDialog().render(true);
  };

  /**
   * Dismiss one or more roll-request cards that have served their purpose — for
   * example a multi-step sequence that has finished collecting its rolls and
   * written the outcome somewhere else.
   *
   * Unlike deleting the messages yourself, this unregisters each card's onResult
   * stream *first*, so a consumer does not receive the terminal
   * { rollType: "cancelled", reason: "deleted" } event for a request that
   * actually completed. Any unresolved awaitResult promise still resolves null.
   *
   * All cards are removed in a single broadcast, so a batch disappears at once
   * rather than popping one at a time on players' screens.
   *
   * @param {ChatMessage|string|Array<ChatMessage|string>} messages - Card(s) or message ID(s).
   * @returns {Promise<string[]>} The IDs actually deleted (unknown ones are skipped).
   */
  game.pf1RollRequests.closeRequest = async (messages) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return [];
    }

    const ids = (Array.isArray(messages) ? messages : [messages])
      .map((m) => m?.id ?? m)
      .filter((id) => typeof id === "string" && game.messages.has(id));
    if (!ids.length) return [];

    for (const id of ids) RollRequestChat.cancelResultCallback(id);
    await ChatMessage.deleteDocuments(ids);
    return ids;
  };

  /**
   * Close a card to further results without removing it.
   *
   * `closeRequest` deletes; this leaves the card on screen exactly as it stands
   * and stops accepting input — the roll and selection buttons disappear, a lock
   * appears in the header, and a click that races the re-render is refused. For
   * a re-pickable selection card this is what "locking in" looks like: the
   * choices stay readable as a record, but nobody can change theirs.
   *
   * Like `closeRequest` it unregisters the card's `onResult` stream first, so a
   * consumer does not receive a terminal `cancelled` event for a request that in
   * fact completed. Any unresolved `awaitResult` promise resolves `null`, since
   * the roll it was waiting for can no longer happen.
   *
   * @param {ChatMessage|string} message - The card, or its message ID.
   * @returns {Promise<ChatMessage|undefined>}
   */
  game.pf1RollRequests.lockRequest = async (message) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = message?.id ? message : game.messages.get(message);
    const current = msg?.flags?.[MODULE_ID];
    if (!current?.request) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }
    if (current.locked) return msg;

    RollRequestChat.cancelResultCallback(msg.id);
    RollRequestChat.cancelPendingResult(msg.id);

    await msg.update({
      [`flags.${MODULE_ID}.locked`]: true,
      content: await RollRequestChat._rebuildCardContent({ ...current, locked: true }),
    });
    return msg;
  };

  /**
   * Replace a card's `description` slot and re-render it in place.
   *
   * The card's HTML lives in message.content, rebuilt from flags, so setting the
   * flag alone would not change anything on screen — this does both. Use it to
   * post a card with a plain reference table and then re-post it with the rolled
   * row highlighted once the result is in.
   *
   * @param {ChatMessage|string} message - The card, or its message ID.
   * @param {string} html                - Raw HTML (not escaped, not gated).
   * @returns {Promise<ChatMessage|undefined>}
   */
  game.pf1RollRequests.setDescription = async (message, html) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = message?.id ? message : game.messages.get(message);
    const current = msg?.flags?.[MODULE_ID];
    if (!current?.request) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }

    const description = html ?? "";
    await msg.update({
      [`flags.${MODULE_ID}.description`]: description,
      content: await RollRequestChat._rebuildCardContent({ ...current, description }),
    });
    return msg;
  };

  /**
   * Programmatically create a roll request chat card.
   *
   * @param {object} options
   * @param {string} options.type        - "ability", "save", "skill", or "dice". Optional when
   *   `selectFromTable` is set (nothing is rolled), where it defaults to "dice".
   * @param {string} options.key         - The key for the check (e.g. "str", "ref", "per"). For
   *   type "dice" this is a roll formula — any valid one, not just a bare die ("2d6+2", "2d4-2").
   *   Validated at request time so a bad formula fails here rather than on a player's click.
   *   Optional (and unused) when `selectFromTable` is set.
   * @param {string} [options.name]      - Display name (auto-resolved from key if omitted)
   * @param {string} [options.mode="multi"]       - "single", "multi", or "targeted". "targeted"
   *   pins specific tokens to the card (see targetedActors) instead of letting any player roll.
   * @param {object[]} [options.targetedActors]   - Required for mode "targeted": one entry per
   *   token, each needing only { id } (the token document ID). `tokenUUID`, `name`, `img`, and
   *   `isHidden` are auto-resolved from the canvas token and may be overridden per entry.
   * @param {boolean} [options.autoRoll=false]    - Targeted mode only: immediately roll every
   *   target GM-side without dialogs, exactly like the card's Roll All button. createRequest does
   *   not resolve until every target has rolled, so the returned message's flags are fully
   *   populated. Equivalent to calling game.pf1RollRequests.bulkRollTargeted() afterwards.
   * @param {number|null} [options.dc=null]       - The DC (null for no DC). Forced to null when a
   *   resultTable is set, since a mapped label has no numeric pass/fail.
   * @param {boolean} [options.showDC=false]      - Whether the DC number is visible to players
   * @param {boolean} [options.showResults=false]  - Whether pass/fail indicators are visible to players
   * @param {string} [options.rollMode="roll"]    - "roll", "gmroll", "publicblind" (public, totals obscured), or "blindroll" (GM-only whisper)
   * @param {string} [options.flavor=""]          - Flavor text
   * @param {boolean} [options.includeAid=true]   - Whether Aid Another is included (single mode only; forced off for dice)
   * @param {string} [options.description=""]     - Raw HTML dropped into a slot near the top of the
   *   card, below the flavor line. Not escaped and not gated — every player sees it. Intended for
   *   caller-supplied context (a lookup table, a rules reminder). Update it later, including after
   *   a roll, with game.pf1RollRequests.setDescription().
   * @param {object[]} [options.resultTable]      - Maps the roll's total onto a label, so the card
   *   shows "Banana" instead of "2". Rows are thresholds — [{ label }, { min, label }, ...] — where
   *   each row covers from its `min` up to the next row's `min - 1`, and the lowest row may omit
   *   `min` for an open lower end. Rows are sorted here, so declaration order doesn't matter, and
   *   a table cannot contain a gap. Labels are rendered unescaped, so simple markup works. Setting
   *   a table forces `dc` to null and suppresses the highest/average aggregate line.
   * @param {boolean} [options.showTable=false]   - Render the resultTable into the card as a table
   *   of every possible outcome, highlighting rows that have been rolled and appending the portrait
   *   of each actor who landed there. Recomputed on every roll. On publicblind cards the highlight
   *   is GM-only (the table itself still shows), so it can't leak a total shown to players as "?".
   * @param {boolean} [options.clampTable=false]  - Trim the displayed table's open ends to the
   *   formula's own reachable range ("≤0" → "0", "5+" → "5–6" for 2d4-2). Off by default: a table
   *   whose formula can only reach part of it still renders in full. Ignored on a selection
   *   request, which has no formula to clamp to.
   * @param {boolean} [options.selectFromTable=false] - Replace the roll with a choice. Requires a
   *   `resultTable`: clicking the card's button opens a dropdown of its rows, and the picked row
   *   becomes the result — recorded, displayed, and highlighted in `showTable` exactly as a rolled
   *   one would be. Works in every mode. The stored `total` is the chosen row's threshold, so
   *   `onResult` / `awaitResult` consumers still get a number the table maps back to; the entry
   *   also carries `selectedIndex` and `selectedLabel`. `type` and `key` become optional, Aid
   *   Another and `clampTable` are forced off, and `autoRoll` / Roll All are unavailable — a
   *   selection is a person's choice, so there is nothing to fire on their behalf. A pick is final
   *   unless `allowRepick` says otherwise.
   * @param {boolean} [options.allowRepick=false] - Selection requests only: let a choice be changed
   *   for as long as the card is up. The button stays live after a pick; clicking it again reopens
   *   the dropdown on the current choice and replaces it. Limited to the slot that clicker already
   *   filled — their own token in single/multi, in targeted the target they may roll for — so no
   *   one can overwrite another's choice. onResult therefore fires again for that actor, while
   *   awaitResult still resolves on the first pick only. Ignored without `selectFromTable`.
   * @param {string} [options.summaryKey]         - Key of a summary formatter registered via
   *   game.pf1RollRequests.registerSummary(). Renders a live aggregate line into the card, recomputed
   *   on each roll. Player visibility follows showResults. Currently displayed in multi-check cards.
   * @param {boolean} [options.awaitResult=false]  - If true, returns a Promise that resolves with the
   *   primary roll result once a player completes the roll. Only works with mode "single".
   *   The promise resolves with an object: { messageId, total, actorId, actorName, actorImg, passed,
   *   naturalRoll, dc, formula, aidTotal, aidResults, notes }, or null if the card is deleted
   *   before the roll is completed.
   * @param {(payload: object) => void} [options.onResult]  - Streaming callback invoked on every roll
   *   completed on this card (works in any mode; best suited to "multi" where there is no single
   *   resolution point). The payload is { messageId, rollType, result, results, aidResults, dc },
   *   where `result` is the entry just rolled and `results` is every primary entry so far — both with
   *   a computed `passed` (total >= dc, or null when no DC). Runs on the GM client that created the
   *   request; like awaitResult it is in-memory, so a GM reload mid-roll drops it. If the card is
   *   deleted, fires one final terminal event { rollType: "cancelled", reason: "deleted", result: null,
   *   results: [], aidResults: [], dc } — branch on rollType before reading roll fields.
   *
   * @returns {Promise<object|null>|ChatMessage|undefined}  When awaitResult is true (single mode),
   *   returns a Promise that resolves with the result. Otherwise returns the created ChatMessage —
   *   a handle for reading flags, correlating with onResult / the pf1RollRequests.rollComplete
   *   hook, or later closing the card with closeRequest(). Returns undefined only when the request
   *   was rejected (bad type, invalid formula, empty targetedActors, selectFromTable without a
   *   resultTable, non-GM caller).
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
   *
   * @example
   * // Selection instead of a roll — the player picks a row rather than rolling for it
   * const message = await game.pf1RollRequests.createRequest({
   *   mode: "single", flavor: "Choose your watch",
   *   selectFromTable: true, showTable: true,
   *   resultTable: [{ label: "First watch" }, { min: 1, label: "Second watch" }, { min: 2, label: "Third watch" }],
   *   onResult: ({ result }) => console.log(`${result.actorName} chose ${result.selectedLabel}`),
   * });
   */
  game.pf1RollRequests.createRequest = async (options = {}) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    // A selection request swaps the roll for a dropdown of the result table's
    // rows, so it needs a table to choose from but neither a check nor a formula
    // to roll — both become optional and default to an unused "dice" request.
    const selectFromTable = options.selectFromTable ?? false;
    if (selectFromTable && options.resultTable == null) {
      ui.notifications.error(game.i18n.localize("RR.Notif.SelectNeedsTable"));
      return;
    }

    const type = options.type ?? (selectFromTable ? "dice" : null);
    const key = options.key ?? (selectFromTable ? "" : null);
    if (!type || (!key && !selectFromTable)) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CreateRequestParams"));
      return;
    }

    const validTypes = ["ability", "save", "skill", "dice"];
    if (!validTypes.includes(type)) {
      ui.notifications.error(game.i18n.format("RR.Notif.InvalidType", { type, types: validTypes.join(", ") }));
      return;
    }

    // For "dice" the key is a roll formula. Validate it here so a typo fails on
    // the GM's request rather than on whichever player clicks the roll button.
    if (type === "dice" && !selectFromTable && !Roll.validate(key)) {
      ui.notifications.error(game.i18n.format("RR.Notif.InvalidFormula", { formula: key }));
      return;
    }

    // --- Result table: normalize, sort, and (optionally) find the formula's range ---
    let resultTable = null;
    if (options.resultTable != null) {
      if (!Array.isArray(options.resultTable) || options.resultTable.length === 0) {
        ui.notifications.error(game.i18n.localize("RR.Notif.ResultTableInvalid"));
        return;
      }
      // Rows are thresholds, so sorting them ascending is what makes each row's
      // upper bound "the next row's min - 1" when the card renders the table.
      resultTable = options.resultTable
        .map((row) => ({
          min: Number.isFinite(Number(row?.min)) ? Number(row.min) : null,
          label: row?.label ?? "",
        }))
        .sort((a, b) => {
          const am = a.min ?? Number.NEGATIVE_INFINITY;
          const bm = b.min ?? Number.NEGATIVE_INFINITY;
          if (am === bm) return 0;
          return am < bm ? -1 : 1;
        });
    }

    const showTable = resultTable ? (options.showTable ?? false) : false;
    // Clamping describes what a formula can reach; a selection has no formula.
    const clampTable = (resultTable && !selectFromTable) ? (options.clampTable ?? false) : false;

    // Clamping trims the table's open ends to what the formula can actually
    // roll. Resolved once here rather than on every re-render.
    let tableBounds = null;
    if (clampTable && type === "dice") {
      try {
        const low = await new Roll(key).evaluate({ minimize: true });
        const high = await new Roll(key).evaluate({ maximize: true });
        tableBounds = { min: low.total, max: high.total };
      } catch (err) {
        console.error(`${MODULE_ID} | Could not determine formula bounds for "${key}":`, err);
      }
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
    // A selection request may carry no key at all, leaving nothing to name it by.
    if (!name && selectFromTable) name = options.flavor || game.i18n.localize("RR.Select.Title");

    const mode = options.mode ?? "multi";
    // A mapped result has no numeric pass/fail, so a DC would be meaningless —
    // and nulling it also drops the pass/fail icons and the feasibility gate.
    const dc = resultTable ? null : (options.dc ?? null);
    const showDC = options.showDC ?? false;
    const showResults = options.showResults ?? false;
    const rollMode = options.rollMode ?? "roll";
    const flavor = options.flavor ?? "";
    // Opt-in: a selection is final unless the request says it can be changed.
    const allowRepick = selectFromTable ? (options.allowRepick ?? false) : false;

    // Aid Another modifies a roll; a selection has none to modify.
    const includeAid = (type === "dice" || type === "save" || selectFromTable)
      ? false
      : (options.includeAid ?? true);
    const targetedActors = options.targetedActors ?? [];

    if (mode === "targeted" && targetedActors.length === 0) {
      ui.notifications.error(game.i18n.localize("RR.Notif.TargetedNeedsActors"));
      return;
    }

    // Auto-populate missing entry fields from the canvas token document.
    if (mode === "targeted") {
      for (const entry of targetedActors) {
        const tokenDoc = canvas.tokens?.get(entry.id)?.document;
        if (tokenDoc) {
          entry.tokenUUID ??= tokenDoc.uuid;
          entry.name     ??= tokenDoc.name;
          entry.img      ??= tokenDoc.texture?.src ?? tokenDoc.actor?.img;
          entry.isHidden ??= tokenDoc.hidden ?? false;
        }
      }
    }

    const requestData = {
      mode,
      dc: dc != null ? Number(dc) : null,
      showDC,
      showResults,
      rollMode,
      flavor,
      includeAid,
      request: { type, key, name },
      description: options.description ?? "",
      resultTable,
      showTable,
      clampTable,
      tableBounds,
      selectFromTable,
      allowRepick,
      locked: false,
      summaryKey: options.summaryKey ?? null,
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
      targetedActors,
      actorResults: {},
      actorAidResults: {},
      usedActorIds: [],
    };

    const awaitResult = options.awaitResult ?? false;
    // Every result on a selection card is somebody's deliberate choice, so there
    // is nothing to fire on their behalf.
    if (selectFromTable && options.autoRoll) {
      console.warn(`${MODULE_ID} | autoRoll ignored: a selection request has no roll to auto-fire.`);
    }
    const autoRoll = (mode === "targeted" && !selectFromTable) ? (options.autoRoll ?? false) : false;
    const message = await RollRequestChat.createChatCard(requestData);

    // Streaming callback: invoked on every roll on this card (any mode). Lets
    // callers observe multi-check results as they come in (single-check rolls
    // fire it too, in addition to any awaitResult promise).
    if (typeof options.onResult === "function" && message) {
      RollRequestChat.registerResultCallback(message.id, options.onResult);
    }

    // Targeted mode: optionally auto-roll all targets, then return the message.
    if (mode === "targeted") {
      if (autoRoll && message) await RollRequestChat._bulkRollTargeted(message);
      return message;
    }

    // If awaitResult is requested for a single-check, return a Promise
    // that resolves when the primary roll is completed.
    if (awaitResult && mode === "single" && message) {
      return RollRequestChat.registerPendingResult(message.id);
    }

    // Every other mode returns the message, so callers always have a handle —
    // to read flags (rolledActors), correlate with the pf1RollRequests.rollComplete
    // hook, or later close the card with closeRequest().
    return message;
  };
});

// Clean up pending result promises and streaming callbacks when a card is deleted.
// awaitResult resolves null; onResult gets a final "cancelled" terminal event.
Hooks.on("deleteChatMessage", (message) => {
  RollRequestChat.cancelPendingResult(message.id);
  const dc = message.flags?.[MODULE_ID]?.dc ?? null;
  RollRequestChat.cancelResultCallback(message.id, "deleted", dc);
});
