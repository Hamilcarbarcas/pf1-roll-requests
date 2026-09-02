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

  // Extends the above to actions with no save and no configured check: the PF1
  // target list is replaced by a roll-request list that has nothing to roll.
  game.settings.register(MODULE_ID, "target-list-always", {
    name: "RR.Settings.TargetListAlways.Name",
    hint: "RR.Settings.TargetListAlways.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
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

// ============================================================
// Shared request construction
//
// createRequest() and embed() take the same option set and differ only in where
// the resulting state is stored and how it is drawn, so they build it here
// together — otherwise the two would drift on every option added.
// ============================================================

/**
 * Resolve `targetedActors` entries against the canvas, filling in whatever the
 * caller left out. Each entry needs only `{ id }` (a token document ID).
 *
 * @param {object[]} targetedActors - Mutated in place.
 * @returns {object[]} The same array.
 */
function resolveTargetedActors(targetedActors) {
  for (const entry of targetedActors ?? []) {
    const tokenDoc = canvas.tokens?.get(entry.id)?.document;
    if (!tokenDoc) continue;
    entry.tokenUUID ??= tokenDoc.uuid;
    entry.name     ??= tokenDoc.name;
    // Actor art, not the token texture — portraits read better at card size
    // than a top-down token, and fall back to it when the actor has none.
    entry.img      ??= tokenDoc.actor?.img ?? tokenDoc.texture?.src;
    entry.isHidden ??= tokenDoc.hidden ?? false;
  }
  return targetedActors ?? [];
}

/**
 * Validate an option set and turn it into the flag state a request runs on.
 * Notifies and returns null when the request should be rejected.
 *
 * @param {object} options
 * @param {boolean} [embedded]  Building for embed() rather than createRequest():
 *   the host owns the card's header, so there is no flavor or description, and
 *   the whisper-based roll modes are unavailable (see below).
 * @returns {Promise<object|null>}
 */
async function buildRequestData(options, { embedded = false } = {}) {
  // A selection request swaps the roll for a dropdown of the result table's
  // rows, so it needs a table to choose from but neither a check nor a formula
  // to roll — both become optional and default to an unused "dice" request.
  const selectFromTable = options.selectFromTable ?? false;
  if (selectFromTable && options.resultTable == null) {
    ui.notifications.error(game.i18n.localize("RR.Notif.SelectNeedsTable"));
    return null;
  }

  const type = options.type ?? (selectFromTable ? "dice" : null);
  const key = options.key ?? (selectFromTable ? "" : null);
  if (!type || (!key && !selectFromTable)) {
    ui.notifications.error(game.i18n.localize("RR.Notif.CreateRequestParams"));
    return null;
  }

  const validTypes = ["ability", "save", "skill", "dice"];
  if (!validTypes.includes(type)) {
    ui.notifications.error(game.i18n.format("RR.Notif.InvalidType", { type, types: validTypes.join(", ") }));
    return null;
  }

  // For "dice" the key is a roll formula. Validate it here so a typo fails on
  // the GM's request rather than on whichever player clicks the roll button.
  if (type === "dice" && !selectFromTable && !Roll.validate(key)) {
    ui.notifications.error(game.i18n.format("RR.Notif.InvalidFormula", { formula: key }));
    return null;
  }

  // --- Result table: normalize, sort, and (optionally) find the formula's range ---
  let resultTable = null;
  if (options.resultTable != null) {
    if (!Array.isArray(options.resultTable) || options.resultTable.length === 0) {
      ui.notifications.error(game.i18n.localize("RR.Notif.ResultTableInvalid"));
      return null;
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
  // "gmroll" and "blindroll" are whisper modes: they work by restricting who the
  // *message* is delivered to. An embed lives inside a card somebody else posted
  // and cannot narrow its audience, so accepting them would quietly show players
  // a roll the caller believed was hidden. "publicblind" is pure rendering and
  // means exactly the same thing embedded as it does on a card of its own.
  let rollMode = options.rollMode ?? "roll";
  if (embedded && rollMode !== "roll" && rollMode !== "publicblind") {
    console.warn(`${MODULE_ID} | rollMode "${rollMode}" is not available to an embedded request `
      + `(it whispers the message, which an embed does not own) — falling back to "roll". `
      + `Use "publicblind" to obscure the totals.`);
    rollMode = "roll";
  }
  // The host draws its own header and prose; an embed contributes neither.
  const flavor = embedded ? "" : (options.flavor ?? "");
  const description = embedded ? "" : (options.description ?? "");
  // Opt-in: a selection is final unless the request says it can be changed.
  const allowRepick = selectFromTable ? (options.allowRepick ?? false) : false;

  // Aid Another modifies a roll; a selection has none to modify.
  const includeAid = (type === "dice" || type === "save" || selectFromTable)
    ? false
    : (options.includeAid ?? true);
  const targetedActors = options.targetedActors ?? [];

  if (mode === "targeted" && targetedActors.length === 0) {
    ui.notifications.error(game.i18n.localize("RR.Notif.TargetedNeedsActors"));
    return null;
  }
  if (mode === "targeted") resolveTargetedActors(targetedActors);

  return {
    mode,
    dc: dc != null ? Number(dc) : null,
    showDC,
    showResults,
    rollMode,
    flavor,
    includeAid,
    request: { type, key, name },
    description,
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
}

/** Resolve a message argument that may be a document or an ID. */
function resolveMessage(message) {
  return message?.id ? message : game.messages.get(message);
}

// Public API for macros: `game.pf1RollRequests.requestRoll()`
Hooks.once("ready", () => {
  /**
   * Roll every pending target on a targeted card, GM-side and dialog-free —
   * exactly what the card's Roll All button does.
   *
   * @param {ChatMessage|string} message
   * @param {object} [options]
   * @param {string} [options.slot] - Roll an embedded request on the message
   *   instead of the card itself. Available whether or not that embed shows its
   *   bulk buttons (see `embed`'s `controls`).
   * @param {string} [options.which="all"] - "npcs" skips any target an active
   *   player owns (and every character-type actor), leaving them to roll for
   *   themselves — what the card's Roll NPCs button does.
   */
  game.pf1RollRequests.bulkRollTargeted = async (message, options = {}) => {
    if (!game.user.isGM) return;
    return RollRequestChat._bulkRollTargeted(resolveMessage(message), options);
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

    // Cancels the card's own stream and every embedded one it carries.
    for (const id of ids) RollRequestChat.cancelMessageCallbacks(id);
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
   * Closing a card closes every request embedded on it too — a card that stops
   * accepting rolls should not still be handing them out. A host that wants an
   * embed to outlive the card it sits on manages that slot with `closeEmbed`
   * instead.
   *
   * @param {ChatMessage|string} message - The card, or its message ID.
   * @returns {Promise<ChatMessage|undefined>}
   */
  game.pf1RollRequests.lockRequest = async (message) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = resolveMessage(message);
    const current = msg?.flags?.[MODULE_ID];
    const slots = Object.keys(current?.embeds ?? {});
    // A host card that carries only embeds is a legitimate target: it has no
    // request of its own, but it does have rolls to stop handing out.
    if (!current?.request && !slots.length) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }

    const update = {};

    if (current.request && !current.locked) {
      RollRequestChat.cancelResultCallback(msg.id);
      RollRequestChat.cancelPendingResult(msg.id);
      update[`flags.${MODULE_ID}.locked`] = true;
      update.content = await RollRequestChat._rebuildCardContent({ ...current, locked: true });
    }

    for (const slot of slots) {
      if (current.embeds[slot]?.locked) continue;
      RollRequestChat.cancelResultCallback(msg.id, null, null, slot);
      update[`flags.${MODULE_ID}.embeds.${slot}.locked`] = true;
    }

    if (!Object.keys(update).length) return msg; // Already fully closed.
    await msg.update(update);
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

    const msg = resolveMessage(message);
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

    const requestData = await buildRequestData(options);
    if (!requestData) return;

    const { mode, selectFromTable } = requestData;
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

  // ==========================================================
  // Embedded requests
  //
  // Put a live request inside a card another module owns, without either module
  // taking the other's card away from it. State lives at
  // flags["pf1-roll-requests"].embeds.<slot>; message.content is never read and
  // never written. Placement is the host's job (renderEmbed), which is what
  // makes ordering between the two modules a non-issue rather than a race.
  // ==========================================================

  /** Slot keys are flag keys: a dot in one would be expanded into nesting. */
  const SLOT_PATTERN = /^[\w-]+$/;

  const validateSlot = (slot) => {
    if (typeof slot === "string" && SLOT_PATTERN.test(slot)) return true;
    ui.notifications.error(game.i18n.localize("RR.Notif.EmbedSlotInvalid"));
    return false;
  };

  /**
   * Attach a roll request to an existing chat message, as state only — this
   * renders nothing by itself. The host draws it with `renderEmbed()` from its
   * own render hook, or asks for the convenience `mount` below.
   *
   * Takes the `createRequest` option set minus the parts that are properties of
   * *being a card*: no `flavor` or `description` (the host has its own header
   * and prose) and no `awaitResult` (a Promise held on one client dies on
   * reload — use the `pf1RollRequests.rollComplete` hook, filtered on `slot`).
   * `rollMode` is limited to `"roll"` and `"publicblind"`; the whisper modes
   * restrict who the *message* reaches, which an embed does not own.
   *
   * GM-only, exactly like `createRequest`. A player's roll crosses the existing
   * socket to the GM, who stays the only writer to the message.
   *
   * @param {ChatMessage|string} message - The host card, or its message ID.
   * @param {object} options
   * @param {string} options.slot        - Key for this request on the host card,
   *   matching `/^[\w-]+$/`. Namespace it yourself (`"ce-crit-save"`); an
   *   existing slot of the same name is replaced, with a console warning.
   * @param {boolean} [options.controls=true] - `false` strips the widget to its
   *   rows: no bulk action row (Roll All / Roll NPCs / Select …), no title, no
   *   GM mode footer. A `showDC` chip survives. `bulkRollTargeted(message,
   *   { slot })` stays available regardless — suppressing the buttons is not the
   *   same as suppressing the capability.
   * @param {string} [options.mount]     - CSS selector, resolved against the
   *   message's rendered element on this module's own render hook, to auto-place
   *   the widget. A convenience for consumers that don't draw their card from
   *   flags; skipped silently when nothing matches. Hosts that rebuild their
   *   block should call `renderEmbed` instead.
   * @param {(payload: object) => void} [options.onResult] - As `createRequest`,
   *   scoped to this slot and carrying it in the payload. In-memory on the
   *   creating client, so a reload drops it; the hook is the durable channel.
   * @returns {Promise<ChatMessage|undefined>} The host message, or undefined if
   *   the request was rejected.
   */
  game.pf1RollRequests.embed = async (message, options = {}) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = resolveMessage(message);
    if (!msg) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }
    const slot = options.slot;
    if (!validateSlot(slot)) return;

    const data = await buildRequestData(options, { embedded: true });
    if (!data) return;

    data.controls = options.controls ?? true;
    data.mount = (typeof options.mount === "string" && options.mount) ? options.mount : null;

    // Flags deep-merge, so replacing a slot has to clear the old one first or
    // its results would survive underneath the new request.
    if (msg.flags?.[MODULE_ID]?.embeds?.[slot]) {
      console.warn(`${MODULE_ID} | Embed slot '${slot}' already exists on message ${msg.id} — replacing it.`);
      RollRequestChat.cancelResultCallback(msg.id, null, null, slot);
      await msg.update({ [`flags.${MODULE_ID}.embeds.-=${slot}`]: null });
    }

    await msg.update({ [`flags.${MODULE_ID}.embeds.${slot}`]: data });

    if (typeof options.onResult === "function") {
      RollRequestChat.registerResultCallback(msg.id, options.onResult, slot);
    }

    if (data.mode === "targeted" && options.autoRoll && !data.selectFromTable) {
      await RollRequestChat._bulkRollTargeted(msg, { slot });
    }
    return msg;
  };

  /**
   * Render an embedded request into an element the caller owns, replacing that
   * element's contents, and bind its buttons.
   *
   * Call this from your own `renderChatMessageHTML` hook once the container
   * exists — there is then no hook-ordering dependency between the two modules
   * and no retry loop. A roll writes only to flags, so Foundry re-renders the
   * message, your hook fires again, and you call this again on the rebuilt
   * container. Callable on any client.
   *
   * @param {ChatMessage|string} message
   * @param {object} options
   * @param {string} options.slot      - The slot passed to `embed()`.
   * @param {HTMLElement} options.into - Container to render into.
   * @returns {Promise<HTMLElement|null>} The rendered card, or null when the
   *   slot holds no request (closed, or never embedded); the container is
   *   emptied in that case.
   */
  game.pf1RollRequests.renderEmbed = async (message, options = {}) => {
    const msg = resolveMessage(message);
    if (!msg) return null;
    return RollRequestChat.renderEmbed(msg, options);
  };

  /**
   * The current state of one embedded request — a copy, so mutating it does
   * nothing; use `updateEmbed` to change it.
   *
   * @param {ChatMessage|string} message
   * @param {string} slot
   * @returns {object|null}
   */
  game.pf1RollRequests.getEmbed = (message, slot) => {
    const state = RollRequestChat._readState(resolveMessage(message), slot);
    return state ? foundry.utils.deepClone(state) : null;
  };

  /**
   * The slot keys of every request embedded on a message.
   *
   * @param {ChatMessage|string} message
   * @returns {string[]}
   */
  game.pf1RollRequests.listEmbeds = (message) =>
    Object.keys(resolveMessage(message)?.flags?.[MODULE_ID]?.embeds ?? {});

  /**
   * Patch an embedded request's state in place — correct a DC, add a target,
   * reveal results. The flag write re-renders the message, so the host's hook
   * fires and the widget redraws with no further call.
   *
   * Keys are paths within the embed's own state, so `"request.name"` reaches the
   * nested field. Arrays are replaced wholesale, so pass a complete
   * `targetedActors` when adding a target; new entries are resolved against the
   * canvas exactly as `createRequest` resolves them.
   *
   * @param {ChatMessage|string} message
   * @param {string} slot
   * @param {object} changes
   * @returns {Promise<ChatMessage|undefined>}
   */
  game.pf1RollRequests.updateEmbed = async (message, slot, changes = {}) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = resolveMessage(message);
    const state = RollRequestChat._readState(msg, slot);
    if (!state?.request) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }

    if (Array.isArray(changes.targetedActors)) resolveTargetedActors(changes.targetedActors);

    const updateData = {};
    for (const [key, value] of Object.entries(changes)) {
      updateData[`flags.${MODULE_ID}.embeds.${slot}.${key}`] = value;
    }
    if (!Object.keys(updateData).length) return msg;

    await msg.update(updateData);
    return msg;
  };

  /**
   * Stop an embedded request accepting rolls.
   *
   * By default the slot is removed outright — the counterpart to
   * `closeRequest`, for a request that has served its purpose. With
   * `lock: true` the state stays and is marked closed instead, so the results
   * remain on the host's card as a record while the roll buttons disappear and
   * any click racing the re-render is refused (as `lockRequest` does for a
   * card).
   *
   * Either way the slot's `onResult` stream is unregistered first, so a consumer
   * doesn't receive a terminal `"cancelled"` event for a request that completed.
   *
   * @param {ChatMessage|string} message
   * @param {string} slot
   * @param {object} [options]
   * @param {boolean} [options.lock=false] - Keep the results visible.
   * @returns {Promise<ChatMessage|undefined>}
   */
  game.pf1RollRequests.closeEmbed = async (message, slot, { lock = false } = {}) => {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.GMOnly"));
      return;
    }

    const msg = resolveMessage(message);
    const state = RollRequestChat._readState(msg, slot);
    if (!state) return msg;

    RollRequestChat.cancelResultCallback(msg.id, null, null, slot);

    await msg.update(lock
      ? { [`flags.${MODULE_ID}.embeds.${slot}.locked`]: true }
      : { [`flags.${MODULE_ID}.embeds.-=${slot}`]: null });
    return msg;
  };
});

// Clean up pending result promises and streaming callbacks when a card is deleted.
// awaitResult resolves null; every onResult on the message — the card's own and
// each embedded request's — gets a final "cancelled" terminal event.
Hooks.on("deleteChatMessage", (message) => {
  RollRequestChat.cancelPendingResult(message.id);
  RollRequestChat.cancelMessageCallbacks(message, "deleted");
});
