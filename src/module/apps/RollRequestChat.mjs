// ============================================================
// Pathfinder 1e Roll Requests — Chat Card Logic
// Handles creating the card, binding buttons, processing rolls,
// and updating the message with results.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

export class RollRequestChat {

  // Pending result promises for awaitResult API (messageId → { resolve })
  static _pendingResults = new Map();

  // Streaming result callbacks for the onResult API (callback key → callback).
  // Keyed by _callbackKey so a whole-card request and each embedded one on the
  // same message keep their own stream.
  static _resultCallbacks = new Map();

  // Per-message serialization chains (messageId → Promise). Ensures concurrent
  // roll results (e.g. one player rolling two actors back-to-back over the
  // socket) apply strictly one-at-a-time, each reading freshly-committed flags.
  static _updateQueues = new Map();

  // Roll slots currently mid-roll on this client (roll-slot key → { warned }). A
  // card's "already rolled" checks read the message flags, which only catch up
  // *after* a result is committed — so without this, every click landing before
  // the first roll resolves passes those checks and posts its own result. See
  // _acquireRollSlot.
  static _inFlight = new Map();

  // ----------------------------------------------------------
  // Embedded requests
  //
  // A request can live either as a whole card of its own (the normal case,
  // state at flags.<MODULE_ID>) or *embedded* inside a card another module
  // owns, with its own state at flags.<MODULE_ID>.embeds.<slot>. An embedded
  // request never reads or writes message.content — the host owns that — so it
  // is rendered explicitly into a caller-supplied element by renderEmbed().
  //
  // Two different things are called a "slot" around here; keep them apart:
  //   * an **embed slot** — one embedded request's key on a host card. Always
  //     the parameter named `slot` below, and `null` for a whole-card request.
  //   * a **roll slot** — the unit a single result fills (one token's action,
  //     one target's save). See _rollSlotKey.
  // ----------------------------------------------------------

  /**
   * The flag state a request reads and writes: the message's own flag scope for
   * a whole-card request, or one embed's sub-object when a slot is given.
   *
   * @param {ChatMessage} message
   * @param {string|null} [slot] - Embed slot, or null for the whole card.
   * @returns {object|null} The state, or null when there is none.
   */
  static _readState(message, slot = null) {
    const flags = message?.flags?.[MODULE_ID];
    if (!flags) return null;
    if (!slot) return flags;
    return flags.embeds?.[slot] ?? null;
  }

  /**
   * The dotted document-update path for one key of a request's flag scope.
   *
   * @param {string|null} slot
   * @param {string} key
   * @returns {string}
   */
  static _statePath(slot, key) {
    return slot
      ? `flags.${MODULE_ID}.embeds.${slot}.${key}`
      : `flags.${MODULE_ID}.${key}`;
  }

  /**
   * Identity of one request for per-client bookkeeping (roll-slot locks). A
   * message may carry a whole-card request and several embedded ones, each of
   * which fills its roll slots independently.
   *
   * @param {string} messageId
   * @param {string|null} [slot]
   * @returns {string}
   */
  static _scopeId(messageId, slot = null) {
    return slot ? `${messageId}#${slot}` : messageId;
  }

  /** Key under which a request's streaming onResult callback is registered. */
  static _callbackKey(messageId, slot = null) {
    return slot ? `${messageId}#${slot}` : messageId;
  }

  // ----------------------------------------------------------
  // Summary formatter registry (public API)
  // A registered formatter renders an aggregate line into the card and is
  // recomputed on every roll. A request opts in via its `summaryKey`.
  // ----------------------------------------------------------

  static _summaryFormatters = new Map();

  /**
   * Register a summary formatter. The formatter receives the card's current
   * flags and returns an HTML string (or "" for nothing) shown in the card's
   * summary slot, recomputed on each roll.
   *
   * @param {string} key
   * @param {(flags: object) => string} formatter
   * @returns {string} The registered key.
   */
  static registerSummary(key, formatter) {
    if (typeof key !== "string" || !key) {
      throw new Error(`${MODULE_ID} | registerSummary requires a non-empty string 'key'.`);
    }
    if (typeof formatter !== "function") {
      throw new Error(`${MODULE_ID} | Summary '${key}' requires a formatter function.`);
    }
    RollRequestChat._summaryFormatters.set(key, formatter);
    return key;
  }

  /** Remove a registered summary formatter. */
  static unregisterSummary(key) {
    return RollRequestChat._summaryFormatters.delete(key);
  }

  /**
   * Build the summary-slot HTML for a card, or "" when there's no summary.
   * Visibility follows result visibility: when `showResults` is false the slot
   * is wrapped in `.gm-only`, so players see it only when results are public.
   *
   * @param {object} flags - The card's current flag state.
   * @returns {string}
   */
  static _renderSummary(flags) {
    const key = flags.summaryKey;
    if (!key) return "";
    const formatter = RollRequestChat._summaryFormatters.get(key);
    if (!formatter) return "";
    let inner;
    try {
      inner = formatter(flags);
    } catch (err) {
      console.error(`${MODULE_ID} | Summary formatter '${key}' threw:`, err);
      return "";
    }
    if (inner == null || inner === "") return "";
    const gmOnly = flags.showResults ? "" : " gm-only";
    return `<div class="arr-summary${gmOnly}">${inner}</div>`;
  }

  /**
   * Build the aggregate-line HTML — highest or average of the primary roll
   * totals — for a card, or "" when disabled or not applicable. Controlled by
   * the world setting `check-aggregate` ("none" | "average" | "highest"). Only
   * multi- and selection-(targeted)-check cards aggregate, and only once more
   * than one result is in.
   *
   * Visibility follows the totals themselves: the GM always sees it; players see
   * it unless the card hides totals (publicblind), where it is wrapped
   * `.gm-only`. The average is rounded to the nearest whole number.
   *
   * @param {object} flags - The card's current flag state.
   * @returns {string}
   */
  static _renderAggregate(flags) {
    let setting;
    try {
      setting = game.settings.get(MODULE_ID, "check-aggregate");
    } catch {
      return ""; // Setting not registered yet (e.g. very early card build)
    }
    if (setting !== "average" && setting !== "highest") return "";
    if (flags.mode !== "multi" && flags.mode !== "targeted") return "";
    // Auto-generated save-request cards aren't "selection checks"; keep them uncluttered.
    if (flags.isSaveRequest) return "";
    // A result table shows labels rather than totals, so a highest/average of the
    // underlying numbers would print a value that appears nowhere on the card.
    if (Array.isArray(flags.resultTable) && flags.resultTable.length) return "";

    const results = flags.mode === "multi"
      ? Object.values(flags.rolledActors || {})
      : Object.values(flags.actorResults || {});
    const totals = results
      .map((r) => r?.total)
      .filter((t) => typeof t === "number" && Number.isFinite(t));
    if (totals.length < 2) return "";

    let label, value;
    if (setting === "highest") {
      label = game.i18n.localize("RR.Card.AggregateHighest");
      value = Math.max(...totals);
    } else {
      label = game.i18n.localize("RR.Card.AggregateAverage");
      value = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
    }

    const gmOnly = flags.rollMode === "publicblind" ? " gm-only" : "";
    return `<div class="arr-aggregate${gmOnly}"><strong>${label}</strong> ${value}</div>`;
  }

  // ----------------------------------------------------------
  // Custom result tables (the API's resultTable / showTable options)
  //
  // A result table maps a roll's numeric total onto a label, so a card can ask
  // for "2d4-2" and display "Banana" instead of "2". Rows are *thresholds*: a
  // row covers everything from its `min` up to the next row's `min - 1`, and the
  // lowest row may omit `min` entirely (open-ended below). Expressed that way a
  // table cannot contain a gap, which explicit {min, max} ranges make easy to
  // write by accident.
  // ----------------------------------------------------------

  /**
   * Index of the table row a total falls into, or -1 for no match.
   *
   * Order-independent (the winner is the qualifying row with the highest `min`),
   * so a caller-supplied table that skipped normalization still resolves right.
   *
   * @param {object[]} resultTable
   * @param {number} total
   * @returns {number}
   */
  static _tableRowIndex(resultTable, total) {
    if (!Array.isArray(resultTable) || !resultTable.length) return -1;
    if (typeof total !== "number" || !Number.isFinite(total)) return -1;

    let index = -1;
    let bestMin = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < resultTable.length; i++) {
      const min = Number.isFinite(resultTable[i]?.min)
        ? resultTable[i].min
        : Number.NEGATIVE_INFINITY;
      if (total >= min && (index === -1 || min >= bestMin)) {
        index = i;
        bestMin = min;
      }
    }
    return index;
  }

  /**
   * The table row a result entry belongs to. A selection knows its own row, so
   * it is taken at its word; a roll resolves through its total as usual. The two
   * only disagree on a degenerate table where rows share a threshold, and there
   * the pick is what the card should report.
   *
   * @param {object} entry           - A stored result entry.
   * @param {object[]|null} resultTable
   * @returns {number} Row index, or -1 for no match.
   */
  static _entryRowIndex(entry, resultTable) {
    const i = entry?.selectedIndex;
    if (Number.isInteger(i) && resultTable?.[i]) return i;
    return RollRequestChat._tableRowIndex(resultTable, entry?.total);
  }

  /**
   * The label a result entry displays — what replaces the number on the card —
   * or null when there is no table or the entry maps to no row.
   *
   * @param {object} entry
   * @param {object[]|null} resultTable
   * @returns {string|null}
   */
  static _resolveEntryLabel(entry, resultTable) {
    const i = RollRequestChat._entryRowIndex(entry, resultTable);
    if (i === -1) return null;
    const label = resultTable[i]?.label;
    return (label == null || label === "") ? null : String(label);
  }

  /**
   * The numeric total a table row stands for — what a *selection* of that row
   * records as its result, so every display path can keep resolving the label
   * from a number exactly as it does for a real roll.
   *
   * Rows are thresholds, so a row's own `min` is the value that maps back to it.
   * The open-ended lowest row has no `min`, so it borrows the value just below
   * the next row's (or 0 when it is the only row).
   *
   * @param {object[]} table
   * @param {number} index
   * @returns {number|null}
   */
  static _tableRowTotal(table, index) {
    const row = table?.[index];
    if (!row) return null;
    if (Number.isFinite(row.min)) return row.min;
    const nextMin = Number.isFinite(table[index + 1]?.min) ? table[index + 1].min : null;
    return nextMin != null ? nextMin - 1 : 0;
  }

  /**
   * Ask the clicker to pick a row of the card's result table, standing in for
   * the roll on a `selectFromTable` request. Returns the chosen row's index,
   * label, and the numeric total it records, or null if the dialog was
   * dismissed (treated exactly like cancelling a roll dialog).
   *
   * Labels render unescaped on the card, so any markup in them is flattened to
   * plain text for the dropdown; a row with no visible label is not offered.
   *
   * @param {object} flags - The card's current flag state.
   * @param {object|null} [existing] - The entry being changed, if this slot has
   *   already been picked; its row opens as the dropdown's current value.
   * @returns {Promise<{index: number, label: string, total: number}|null>}
   */
  static async _promptTableSelection(flags, existing = null) {
    const table = flags.resultTable ?? [];
    const choices = [];
    for (let i = 0; i < table.length; i++) {
      const scratch = document.createElement("div");
      scratch.innerHTML = String(table[i]?.label ?? "");
      const text = scratch.textContent.trim();
      if (text) choices.push({ index: i, text });
    }
    if (!choices.length) {
      ui.notifications.error(game.i18n.localize("RR.Notif.NoSelectionChoices"));
      return null;
    }

    const currentIndex = Number.isInteger(existing?.selectedIndex) ? existing.selectedIndex : null;
    const options = choices
      .map((c) => `<option value="${c.index}"${c.index === currentIndex ? " selected" : ""}>`
        + `${foundry.utils.escapeHTML(c.text)}</option>`)
      .join("");
    const content =
      `<div style="margin-bottom:6px;">`
      + game.i18n.localize(currentIndex != null ? "RR.Select.PromptChange" : "RR.Select.Prompt")
      + `</div><select name="row" style="width:100%;">${options}</select>`;

    let picked;
    try {
      picked = await foundry.applications.api.DialogV2.prompt({
        window: { title: flags.flavor || flags.request?.name || game.i18n.localize("RR.Select.Title") },
        content,
        ok: {
          label: game.i18n.localize(currentIndex != null ? "RR.Select.ConfirmChange" : "RR.Select.Confirm"),
          icon: "fas fa-check",
          callback: (_event, button) => button.form?.elements?.row?.value ?? null,
        },
        rejectClose: false,
      });
    } catch {
      return null; // Dismissed
    }
    if (picked == null) return null;

    const index = Number(picked);
    const row = table[index];
    if (!row) return null;
    return {
      index,
      label: String(row.label ?? ""),
      total: RollRequestChat._tableRowTotal(table, index),
    };
  }

  /**
   * Render one row's range. `low`/`high` are null when that end is open. When
   * `bounds` ({min, max}) is supplied the open ends are clamped to the formula's
   * own reachable range, turning "≤0" into "0" and "5+" into "5–6" for 2d4-2.
   *
   * A row the formula can never reach would clamp to an inverted range; those
   * fall back to their unclamped open-ended form rather than printing nonsense.
   *
   * @param {number|null} low
   * @param {number|null} high
   * @param {{min: number, max: number}|null} bounds
   * @returns {string}
   */
  static _formatTableRange(low, high, bounds) {
    let lo = low;
    let hi = high;

    if (bounds) {
      if (lo == null && Number.isFinite(bounds.min)) lo = bounds.min;
      if (hi == null && Number.isFinite(bounds.max)) hi = bounds.max;
      if (lo != null && hi != null && lo > hi) { lo = low; hi = high; }
    }

    if (lo == null && hi == null) return game.i18n.localize("RR.Table.Any");
    if (lo == null) return `≤${hi}`;
    if (hi == null) return `${lo}+`;
    if (lo === hi) return `${lo}`;
    return `${lo}–${hi}`;
  }

  /**
   * Build the result-table slot: every row of the card's table with its derived
   * range, plus the portraits of anyone whose roll landed on that row. Like the
   * summary and aggregate slots this is recomputed from flags on every roll, so
   * the highlight keeps itself current with no extra call from the caller.
   *
   * The full table always renders — a formula that can only reach part of it
   * still shows every row, which is the point of writing the table out. Set
   * `clampTable` to trim the open ends to what the formula can actually roll.
   *
   * On publicblind cards the hit markers are `.gm-only`: the table itself stays
   * visible to players, but revealing which row was hit would hand them the
   * total the card is deliberately showing them as "?".
   *
   * @param {object} flags - The card's current flag state.
   * @returns {string}
   */
  static _renderResultTable(flags) {
    const table = flags.resultTable;
    if (!flags.showTable || !Array.isArray(table) || !table.length) return "";

    const bounds = flags.clampTable ? (flags.tableBounds ?? null) : null;
    const hideHitsFromPlayers = flags.rollMode === "publicblind";
    // On a selection card the numbers behind the rows are bookkeeping, not
    // outcomes anyone rolls for, so the range column is dropped entirely.
    const hideRanges = !!flags.selectFromTable;

    // Bucket every result posted so far onto the row it landed on.
    const results = flags.mode === "targeted"
      ? Object.values(flags.actorResults || {})
      : Object.values(flags.rolledActors || {});
    const hits = new Map();
    for (const entry of results) {
      const i = RollRequestChat._entryRowIndex(entry, table);
      if (i === -1) continue;
      if (!hits.has(i)) hits.set(i, []);
      hits.get(i).push(entry);
    }

    const rows = table.map((row, i) => {
      const low = Number.isFinite(row?.min) ? row.min : null;
      const nextMin = Number.isFinite(table[i + 1]?.min) ? table[i + 1].min : null;
      const high = nextMin != null ? nextMin - 1 : null;
      const range = RollRequestChat._formatTableRange(low, high, bounds);

      const entries = hits.get(i) ?? [];
      let hitHtml = "";
      if (entries.length) {
        const portraits = entries.map((e) => {
          const name = foundry.utils.escapeHTML(String(e.actorName ?? ""));
          return `<img class="arr-table-portrait" src="${e.actorImg}" alt="${name}" title="${name}" />`;
        }).join("");
        hitHtml = `<span class="arr-table-hit${hideHitsFromPlayers ? " gm-only" : ""}">${portraits}</span>`;
      }

      return `<tr class="arr-table-row">`
        + (hideRanges ? "" : `<td class="arr-table-range">${range}</td>`)
        + `<td class="arr-table-label">${row?.label ?? ""}</td>`
        + `<td class="arr-table-hits">${hitHtml}</td>`
        + `</tr>`;
    }).join("");

    return `<table class="arr-result-table"><tbody>${rows}</tbody></table>`;
  }

  // ----------------------------------------------------------
  // Create and post the chat card
  // ----------------------------------------------------------

  /** The card template a request's mode renders through. */
  static _cardTemplate(mode) {
    if (mode === "single") return `modules/${MODULE_ID}/src/templates/chat-card-single.html`;
    if (mode === "targeted") return `modules/${MODULE_ID}/src/templates/chat-card-targeted.html`;
    return `modules/${MODULE_ID}/src/templates/chat-card-multi.html`;
  }

  /**
   * The template context for a request's card, derived wholly from its flag
   * state. Shared by the three paths that draw a card: the initial post, the
   * content rebuild after a roll, and renderEmbed.
   *
   * @param {object} flags - The request's current flag state.
   * @returns {object}
   */
  static _templateData(flags) {
    const requestName = flags.request.name;
    return {
      name: flags.flavor || requestName,
      requestName,
      dc: flags.dc,
      showDC: flags.showDC,
      showResults: flags.showResults,
      flavor: flags.flavor,
      includeAid: flags.includeAid,
      // Roll mode display name (shown in GM-only footer)
      modeName: RollRequestChat._getModeName(flags.rollMode, flags.showResults),
      targetedActors: flags.targetedActors ?? [],
      isSaveRequest: flags.isSaveRequest ?? false,
      isSelection: flags.selectFromTable ?? false,
      locked: flags.locked ?? false,
      checkKindLabel: RollRequestChat._getCheckKindLabel(flags),
      description: flags.description ?? "",
      tableHtml: RollRequestChat._renderResultTable(flags),
      summaryHtml: RollRequestChat._renderSummary(flags),
      aggregateHtml: RollRequestChat._renderAggregate(flags),
    };
  }

  static async createChatCard(requestData) {
    const template = RollRequestChat._cardTemplate(requestData.mode);
    const html = await renderTemplate(template, RollRequestChat._templateData(requestData));

    // Build the chat message
    const chatData = {
      user: game.user.id,
      content: html,
      flags: {
        [MODULE_ID]: requestData,
      },
    };

    // Apply roll mode visibility
    switch (requestData.rollMode) {
      case "blindroll":
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
        chatData.blind = true;
        break;
      case "gmroll":
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
        break;
    }

    const message = await ChatMessage.create(chatData);

    // DM Check: immediately roll for every selected NPC, GM-side and dialog-free.
    // Reuses the targeted bulk-roll path (skipDialog, no player interaction).
    if (requestData.isDMCheck && game.user.isGM) {
      await RollRequestChat._bulkRollTargeted(message);
    }

    return message;
  }

  // ----------------------------------------------------------
  // Hook: renderChatMessage — bind interactivity to the card
  // ----------------------------------------------------------

  static async onRenderChatMessage(message, html, _data) {
    const root = html instanceof HTMLElement ? html : html?.[0];

    // The whole-card request, if this message is one. Embedded cards are tagged
    // by renderEmbed and excluded here: a host module may draw its block — and
    // with it an embed — from a render hook that runs before this one, and that
    // card is not this message's request.
    const card = root?.querySelector?.(".arr-card:not([data-arr-embed])");
    if (card) {
      await RollRequestChat._activateCard(message, card, message.flags?.[MODULE_ID], null);
    }

    // Bind the standalone check button (mirrors PF1's native save button) that
    // auto-generated skill/ability check cards carry in the preserved PF1 footer,
    // outside .arr-card. Same behaviour as the save button: roll for the clicker's
    // selected token(s) as a standalone PF1 roll card.
    const checkBtn = root?.querySelector?.(".rr-check-button");
    if (checkBtn && !checkBtn.dataset.bound) {
      checkBtn.dataset.bound = "1";
      checkBtn.addEventListener("click", (ev) => RollRequestChat._onCheckButton(ev));
    }

    // Embedded requests that asked us to place them (API: embed's `mount`).
    await RollRequestChat._renderMountedEmbeds(message, root);
  }

  // ----------------------------------------------------------
  // Turn a freshly-rendered card element into a live one: resolve per-viewer
  // visibility, bind its buttons, and replay the results already in its flags.
  //
  // Shared by the whole-card render hook and renderEmbed, which differ only in
  // where the element came from and which flag scope drives it.
  // ----------------------------------------------------------

  static async _activateCard(message, card, flags, slot = null) {
    // Remove GM-only elements for non-GMs; remove player-only elements for GMs
    if (game.user.isGM) {
      card.querySelectorAll(".arr-player-only").forEach(el => el.remove());
    } else {
      card.querySelectorAll(".gm-only").forEach(el => el.remove());
    }

    if (!flags || !flags.request) return;

    // `controls: false` strips the card down to its rows, so an embedded request
    // doesn't sit inside a host's card wearing a second card's chrome.
    if (flags.controls === false) RollRequestChat._stripCardChrome(card);

    const mode = flags.mode;

    if (mode === "multi") {
      RollRequestChat._bindMultiCheck(message, card, flags, slot);
    } else if (mode === "single") {
      RollRequestChat._bindSingleCheck(message, card, flags, slot);
    } else if (mode === "targeted") {
      RollRequestChat._bindTargetedCheck(message, card, flags, slot);
    }

    // Re-render results from flag data (await so DOM is populated before cleanup/binding)
    await RollRequestChat._renderExistingResults(message, card, flags);

    // Obscure NPC token names for non-observers when pf1-token-randomizer is active.
    RollRequestChat._applyNameObscuring(card, flags);

    // Strip PF1's "Success/Failure" + DC display from freshly-rendered roll details —
    // our card handles pass/fail display separately, and PF1 may show the wrong DC
    card.querySelectorAll(".arr-roll-details .difficulty-class").forEach(el => el.remove());

    // When results are hidden, also strip PF1's success/failure coloring for non-GMs
    if (!flags.showResults && !game.user.isGM) {
      card.querySelectorAll(".arr-roll-details .success").forEach(el => el.classList.remove("success"));
      card.querySelectorAll(".arr-roll-details .failure").forEach(el => el.classList.remove("failure"));
    }

    // Bind click-to-expand on result rows
    RollRequestChat._bindExpandToggle(card);
  }

  /**
   * Reduce a card to its rows: no title, no flavor, no GM mode footer. The DC
   * chip survives on its own — a caller that asked for `showDC` meant it, and
   * dropping the number with the rest of the header would silently ignore that.
   *
   * @param {HTMLElement} card
   */
  static _stripCardChrome(card) {
    card.classList.add("arr-card-bare");
    card.querySelector(".arr-flavor")?.remove();
    card.querySelector(".arr-card-footer")?.remove();
    const header = card.querySelector(".arr-card-header");
    if (!header) return;
    const title = header.querySelector(".arr-card-title");
    // The lock rides in the title, and without it a closed request is just rows
    // whose buttons have vanished — so it is kept even when the title goes.
    const lock = title?.querySelector(".arr-locked-icon");
    if (header.querySelector(".arr-dc-display") || lock) {
      if (lock) header.insertBefore(lock, header.firstChild);
      title?.remove();
    } else {
      header.remove();
    }
  }

  // ----------------------------------------------------------
  // Embedded requests: rendering
  // ----------------------------------------------------------

  /**
   * Render an embedded request into an element the caller owns, and bind it.
   *
   * Placement is the caller's, deliberately: a host calls this from its own
   * render hook once its container exists, so there is no hook-ordering
   * dependency between the two modules and no retry loop. Calling it again on a
   * later draw simply replaces the widget. Nothing here reads or writes
   * `message.content`.
   *
   * Safe to call from any client — a player's roll crosses the existing socket
   * to the GM, who stays the only writer to the message.
   *
   * @param {ChatMessage} message
   * @param {object} options
   * @param {string} options.slot        - The embed slot, as passed to embed().
   * @param {HTMLElement} options.into   - Container to render into; its contents
   *   are replaced.
   * @returns {Promise<HTMLElement|null>} The rendered card element, or null when
   *   the slot holds no request (closed, or never embedded) — in which case the
   *   container is emptied.
   */
  static async renderEmbed(message, { slot, into } = {}) {
    if (!(into instanceof HTMLElement)) {
      throw new Error(`${MODULE_ID} | renderEmbed requires an 'into' HTMLElement.`);
    }
    if (typeof slot !== "string" || !slot) {
      throw new Error(`${MODULE_ID} | renderEmbed requires a non-empty string 'slot'.`);
    }

    const state = RollRequestChat._readState(message, slot);
    if (!state?.request) {
      into.replaceChildren();
      return null;
    }

    const html = await renderTemplate(
      RollRequestChat._cardTemplate(state.mode),
      RollRequestChat._templateData(state)
    );
    const scratch = document.createElement("div");
    scratch.innerHTML = html;
    const card = scratch.querySelector(".arr-card");
    if (!card) return null;

    // Tag it so the whole-card render hook doesn't mistake it for the message's
    // own request, and drop `chat-card` so it doesn't wear a second card's frame.
    card.dataset.arrEmbed = slot;
    card.classList.remove("chat-card");
    card.classList.add("arr-embed");

    await RollRequestChat._activateCard(message, card, state, slot);

    into.replaceChildren(card);
    return card;
  }

  /**
   * Render every embed on a message that supplied a `mount` selector, resolved
   * against the message's own rendered element.
   *
   * This is the convenience path for consumers that don't draw their card from
   * flags: it runs on our render hook, so it only finds containers that already
   * exist by then. A host that builds its block later — or rebuilds it — should
   * call renderEmbed itself instead.
   *
   * @param {ChatMessage} message
   * @param {HTMLElement} root - The message's rendered element.
   */
  static async _renderMountedEmbeds(message, root) {
    const embeds = message?.flags?.[MODULE_ID]?.embeds;
    if (!root || !embeds) return;

    for (const [slot, state] of Object.entries(embeds)) {
      if (!state?.mount || !state.request) continue;
      let into;
      try {
        into = root.querySelector(state.mount);
      } catch {
        console.warn(`${MODULE_ID} | Embed '${slot}' has an invalid mount selector: ${state.mount}`);
        continue;
      }
      if (!into) continue; // Nothing to mount into on this render — skip silently.
      try {
        await RollRequestChat.renderEmbed(message, { slot, into });
      } catch (err) {
        console.error(`${MODULE_ID} | Could not mount embed '${slot}':`, err);
      }
    }
  }

  // ----------------------------------------------------------
  // Standalone check button handler — mirrors PF1's native save button.
  // Rolls the configured skill/ability check for the clicker's controlled
  // token(s) (or their configured character), as standalone roll cards.
  // ----------------------------------------------------------

  static async _onCheckButton(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const type = button.dataset.checkType;
    const key = button.dataset.checkKey;
    const dcRaw = button.dataset.dc;
    const dc = dcRaw !== "" && dcRaw != null ? parseInt(dcRaw, 10) : undefined;
    if (!type || !key) return;

    let actors = (canvas.tokens?.controlled ?? []).map(t => t.actor).filter(Boolean);
    if (!actors.length && game.user.character) actors = [game.user.character];
    if (!actors.length) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.SelectTokenFirst"));
      return;
    }

    for (const actor of actors) {
      try {
        const opts = { event };
        if (dc != null && !Number.isNaN(dc)) opts.dc = dc;
        if (type === "skill") await actor.rollSkill(key, opts);
        else if (type === "ability") await actor.rollAbilityTest(key, opts);
      } catch (err) {
        console.error(`${MODULE_ID} | Check button roll error for ${actor?.name}:`, err);
      }
    }
  }

  // ----------------------------------------------------------
  // Bind a roll button to the roll handler
  //
  // The button is marked busy for as long as its click is being handled, so a
  // second click while the dialog is open reads as "still working" rather than
  // as a button that did nothing. The slot lock in _handleRoll is what actually
  // enforces one result per slot — this is its visible half, and it stops a
  // burst of clicks on one button before they reach the handler at all.
  // ----------------------------------------------------------

  static _bindBusyClick(btn, handler) {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.dataset.busy) return;
      btn.dataset.busy = "1";
      btn.classList.add("arr-btn-busy");
      try {
        await handler(ev);
      } finally {
        delete btn.dataset.busy;
        btn.classList.remove("arr-btn-busy");
      }
    });
  }

  static _bindRollButton(btn, message, flags, rollType, opts = {}) {
    RollRequestChat._bindBusyClick(btn, () => RollRequestChat._handleRoll(message, flags, rollType, opts));
  }

  // ----------------------------------------------------------
  // Multi-Check: bind the roll button
  // ----------------------------------------------------------

  static _bindMultiCheck(message, card, flags, slot = null) {
    const rollBtn = card.querySelector('.arr-roll-btn[data-action="roll"]');
    if (rollBtn) RollRequestChat._bindRollButton(rollBtn, message, flags, "multi", { slot });

    if (flags.includeAid) {
      const aidBtn = card.querySelector('.arr-roll-btn[data-action="rollMultiAid"]');
      if (aidBtn) RollRequestChat._bindRollButton(aidBtn, message, flags, "multiAid", { slot });
      RollRequestChat._updateAidDisplay(card, flags, false, flags.aidTotal || 0);
    }
  }

  // ----------------------------------------------------------
  // Single-Check: bind both buttons
  // ----------------------------------------------------------

  static _bindSingleCheck(message, card, flags, slot = null) {
    // Aid Another button
    const aidBtn = card.querySelector('.arr-roll-btn[data-action="rollAid"]');
    if (aidBtn) RollRequestChat._bindRollButton(aidBtn, message, flags, "aid", { slot });

    // Primary Roll button
    const primaryBtn = card.querySelector('.arr-roll-btn[data-action="rollPrimary"]');
    if (primaryBtn) RollRequestChat._bindRollButton(primaryBtn, message, flags, "primary", { slot });

    // Update aid bonus display
    RollRequestChat._updateAidDisplay(card, flags);
  }

  // ----------------------------------------------------------
  // Targeted-Check: bind per-actor roll and aid buttons
  // ----------------------------------------------------------

  static _bindTargetedCheck(message, card, flags, slot = null) {
    // Bulk action rows are for a card that is a fireball against six tokens. An
    // embedded request is usually one target and one row, where they are four
    // buttons that each do what that row already does (API: controls).
    const showControls = flags.controls !== false;

    // Primary roll buttons — one per targeted actor
    card.querySelectorAll('.arr-roll-btn[data-action="rollTargeted"]').forEach(btn => {
      const targetActorId = btn.dataset.actorId;

      // Dim the button for users who don't own this actor. Resolve ownership via
      // the token (tokenUUID → actor.isOwner) whenever present — this matches the
      // permission check in _handleRoll and works for any targeted request, not
      // just saves. Fall back to the assigned-character id only when there is no
      // token reference (e.g. dialog-created requests with linked actors).
      const entry = flags.targetedActors?.find(t => t.id === targetActorId);
      const ownedByUser = entry?.tokenUUID
        ? (fromUuidSync(entry.tokenUUID)?.actor?.isOwner ?? false)
        : game.user.character?.id === targetActorId;
      if (!game.user.isGM && !ownedByUser) {
        btn.classList.add("arr-roll-btn-disabled");
      }

      RollRequestChat._bindRollButton(btn, message, flags, "targeted", { targetActorId, slot });
    });

    // Aid buttons — one per targeted actor's section, usable by anyone
    card.querySelectorAll('.arr-roll-btn[data-action="rollTargetedAid"]').forEach(btn => {
      const targetActorId = btn.dataset.targetActorId;
      RollRequestChat._bindRollButton(btn, message, flags, "targetedAid", { targetActorId, slot });
    });

    // Initialise aid bonus displays
    for (const block of card.querySelectorAll(".arr-targeted-block")) {
      RollRequestChat._updateTargetedAidDisplay(card, flags, block.dataset.actorId);
    }

    // Save-request specific: compact styling + per-user visibility tiers + GM controls
    if (flags.isSaveRequest) {
      card.classList.add("arr-save-request");

      if (!game.user.isGM) {
        // Tier 1 (hidden): remove entirely. Tier 2 (visible, sub-observer): portrait grid only.
        const portraitTargets = [];
        for (const target of (flags.targetedActors || [])) {
          const block = card.querySelector(`.arr-targeted-block[data-actor-id="${target.id}"]`);
          const dropBlock = () => {
            if (!block) return;
            const next = block.nextElementSibling;
            if (next?.classList.contains("arr-divider")) next.remove();
            block.remove();
          };
          if (target.isHidden) { dropBlock(); continue; }
          const tokenDoc = fromUuidSync(target.tokenUUID);
          const hasObserver = tokenDoc?.actor?.testUserPermission(game.user, "OBSERVER") ?? false;
          if (!hasObserver) { dropBlock(); portraitTargets.push(target); }
        }
        if (portraitTargets.length) {
          const grid = document.createElement("div");
          grid.className = "arr-save-portrait-grid";
          grid.style.cssText = "display:flex;flex-wrap:wrap;justify-content:center;gap:3px;padding:4px 0 2px;border-top:1px solid #ddd;margin-top:2px;";
          for (const target of portraitTargets) {
            const img = document.createElement("img");
            img.src = target.img;
            img.alt = "";
            img.className = "arr-save-portrait-only";
            img.style.cssText = "display:inline-block;width:56px;height:56px;max-width:56px;flex:0 0 56px;object-fit:contain;border-radius:2px;border:1px solid #aaa;background:rgba(0,0,0,0.1);opacity:0.7;";
            grid.appendChild(img);
          }
          (card.querySelector(".arr-card-body") ?? card).appendChild(grid);
        }
      }

      if (game.user.isGM) {
        // Click full-row portraits to select that token on canvas
        for (const target of (flags.targetedActors || [])) {
          const block = card.querySelector(`.arr-targeted-block[data-actor-id="${target.id}"]`);
          if (!block) continue;
          const img = block.querySelector(".arr-actor-img");
          if (!img) continue;
          img.style.cursor = "pointer";
          img.addEventListener("click", (e) => {
            e.stopPropagation();
            const tokenDoc = fromUuidSync(target.tokenUUID);
            if (!tokenDoc?.object) return;
            canvas.tokens.releaseAll();
            tokenDoc.object.control();
          });
        }

        if (showControls && (flags.targetedActors?.length ?? 0) > 1) {
          // Roll All / Roll NPCs bulk buttons at top of card body. A locked card
          // accepts no further results, so they are omitted — the token-selection
          // footer below still is, since selecting tokens is not a result.
          if (!flags.locked) {
            const bulkBtns = document.createElement("div");
            bulkBtns.className = "arr-save-bulk-btns flexrow";
            bulkBtns.innerHTML =
              `<button type="button" class="arr-save-sel-btn" data-bulk="all">${game.i18n.localize("RR.Bulk.RollAll")}</button>` +
              `<button type="button" class="arr-save-sel-btn" data-bulk="npcs">${game.i18n.localize("RR.Bulk.RollNPCs")}</button>`;
            const body = card.querySelector(".arr-card-body");
            if (body) body.insertBefore(bulkBtns, body.firstChild);
            else card.prepend(bulkBtns);
            bulkBtns.querySelectorAll("[data-bulk]").forEach(btn => {
              RollRequestChat._bindBusyClick(btn, () => RollRequestChat._bulkRollSave(message, btn.dataset.bulk, slot));
            });
          }

          // Select All / Passed / Failed footer
          const selectFooter = document.createElement("div");
          selectFooter.className = "arr-save-select-footer flexrow";
          selectFooter.innerHTML =
            `<button type="button" class="arr-save-sel-btn" data-select="all">${game.i18n.localize("RR.Bulk.SelectAll")}</button>` +
            `<button type="button" class="arr-save-sel-btn" data-select="passed">${game.i18n.localize("RR.Bulk.SelectPassed")}</button>` +
            `<button type="button" class="arr-save-sel-btn" data-select="failed">${game.i18n.localize("RR.Bulk.SelectFailed")}</button>`;
          card.appendChild(selectFooter);
          selectFooter.querySelectorAll("[data-select]").forEach(btn => {
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              const currentFlags = RollRequestChat._readState(message, slot);
              if (currentFlags) RollRequestChat._selectSaveTokens(currentFlags, btn.dataset.select);
            });
          });
        }
      }

      // Combined row-click dropdown (defenses + post-roll details) — only the
      // blocks surviving above (OBSERVER+/GM)
      RollRequestChat._bindTargetedExpand(card, flags);
    }

    // Blind-roll targeted (non-save): GM-only Roll All button. A selection card
    // has no roll to bulk-fire — every result is somebody's deliberate choice.
    if (showControls && game.user.isGM && flags.rollMode === "blindroll" && !flags.isSaveRequest && !flags.selectFromTable && !flags.locked) {
      const bulkBtns = document.createElement("div");
      bulkBtns.className = "arr-save-bulk-btns flexrow";
      bulkBtns.innerHTML = `<button type="button" class="arr-save-sel-btn">${game.i18n.localize("RR.Bulk.RollAll")}</button>`;
      const body = card.querySelector(".arr-card-body");
      if (body) body.insertBefore(bulkBtns, body.firstChild);
      else card.prepend(bulkBtns);
      RollRequestChat._bindBusyClick(
        bulkBtns.querySelector("button"),
        () => RollRequestChat._bulkRollTargeted(message, { slot })
      );
    }
  }

  // ----------------------------------------------------------
  // Per-target combined dropdown (save requests only)
  // ----------------------------------------------------------

  // Bind a click on the whole actor row to toggle the combined dropdown:
  // post-roll roll details (when present) on top, defenses below. Works
  // pre-roll too (defenses only). Sub-observer blocks are already removed for
  // non-GMs, so anything present here is OBSERVER+ (or GM) — no extra check.
  static _bindTargetedExpand(card, flags) {
    for (const block of card.querySelectorAll(".arr-targeted-block")) {
      const actorId = block.dataset.actorId;
      const row = block.querySelector(".arr-targeted-actor-row");
      const panel = block.querySelector(":scope > .arr-targeted-defenses");
      if (!row || !panel) continue;
      const entry = flags.targetedActors?.find(t => t.id === actorId);

      const rotateIcons = (open) => {
        for (const icon of block.querySelectorAll(".arr-defenses-icon, .arr-targeted-actor-row .arr-expand-icon")) {
          icon.classList.toggle("fa-chevron-up", open);
          icon.classList.toggle("fa-chevron-down", !open);
        }
      };

      row.style.cursor = "pointer";
      row.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        // Build defenses once, lazily, from the live actor on this client.
        if (!panel.dataset.loaded) {
          const actor = entry?.tokenUUID ? fromUuidSync(entry.tokenUUID)?.actor : null;
          if (!actor) return void ui.notifications.warn(game.i18n.localize("RR.Notif.LoadDefensesFailed"));
          try {
            panel.innerHTML = await RollRequestChat._buildDefensesPanel(actor);
            panel.dataset.loaded = "1";
          } catch (err) {
            console.error("pf1-roll-requests | failed to build defenses panel", err);
            return;
          }
        }

        const open = block.classList.toggle("arr-expanded");
        rotateIcons(open);
      });
    }
  }

  // Build the compact defenses panel HTML for an actor. Mirrors the data
  // assembly in PF1's actor.displayDefenseCard (which can't be used directly
  // because it requires ownership). All reads are permission-free.
  static async _buildDefensesPanel(actor) {
    const rollData = actor.getRollData();
    const sys = actor.system;
    const formatTextNotes = (notes) => notes?.split(/[\n\r]+/).map((text) => ({ text })) ?? [];

    const [acNotes, cmdNotes, srNotes, saveNotes] = await Promise.all([
      actor.getContextNotesParsed("ac", { rollData }),
      actor.getContextNotesParsed("cmd", { rollData }),
      actor.getContextNotesParsed("sr", { rollData }),
      actor.getContextNotesParsed("allSavingThrows", { rollData }),
    ]);
    if (sys.attributes?.acNotes) acNotes.push(...formatTextNotes(sys.attributes.acNotes));
    if (sys.attributes?.cmdNotes) cmdNotes.push(...formatTextNotes(sys.attributes.cmdNotes));
    if (sys.attributes?.srNotes) srNotes.push(...formatTextNotes(sys.attributes.srNotes));
    if (sys.attributes?.saveNotes) saveNotes.push(...formatTextNotes(sys.attributes.saveNotes));

    // Damage reduction / energy resistance (string maps keyed by type)
    const drNotes = Object.values(actor.parseResistances?.("dr") ?? {}).map((text) => ({ text }));
    const erNotes = Object.values(actor.parseResistances?.("eres") ?? {}).map((text) => ({ text }));

    // Active conditions flagged for defense display
    const conditions = Object.entries(sys.conditions ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => pf1.registry?.conditions?.get(id))
      .filter((c) => c?.showInDefense)
      .map((c) => ({ text: c.name }));

    const ac = sys.attributes?.ac ?? {};
    const cmd = sys.attributes?.cmd ?? {};
    const saves = sys.attributes?.savingThrows ?? {};
    const sr = sys.attributes?.sr?.total;

    const sign = (n) => (Number(n) >= 0 ? `+${n}` : `${n}`);
    const stat = (label, val) =>
      `<span class="arr-def-stat"><span class="arr-def-label">${label}</span><span class="arr-def-val">${val}</span></span>`;
    const noteGroup = (label, notes) => {
      if (!notes?.length) return "";
      const tags = notes
        .map((n) => `<span class="arr-def-tag"${n.source ? ` title="${n.source}"` : ""}>${n.text}</span>`)
        .join("");
      return `<div class="arr-def-notes"><span class="arr-def-notes-label">${label}</span><div class="arr-def-tags">${tags}</div></div>`;
    };

    let html = `<div class="arr-defenses-content">`;
    html += `<div class="arr-def-header">${game.i18n.localize("RR.Def.Defenses")}</div>`;

    html += `<div class="arr-def-row">${stat(game.i18n.localize("RR.Def.AC"), ac.normal?.total ?? 0)}${stat(game.i18n.localize("RR.Def.Touch"), ac.touch?.total ?? 0)}${stat(game.i18n.localize("RR.Def.FF"), ac.flatFooted?.total ?? 0)}</div>`;
    html += noteGroup(game.i18n.localize("RR.Def.ACNotes"), acNotes);

    let cmdRow = `${stat(game.i18n.localize("RR.Def.CMD"), cmd.total ?? 0)}${stat(game.i18n.localize("RR.Def.FFCMD"), cmd.flatFootedTotal ?? 0)}`;
    if (sr) cmdRow += stat(game.i18n.localize("RR.Def.SR"), sr);
    html += `<div class="arr-def-row">${cmdRow}</div>`;
    html += noteGroup(game.i18n.localize("RR.Def.CMDNotes"), cmdNotes);
    if (sr) html += noteGroup(game.i18n.localize("RR.Def.SRNotes"), srNotes);

    html += `<div class="arr-def-row">${stat(game.i18n.localize("RR.Def.Fort"), sign(saves.fort?.total ?? 0))}${stat(game.i18n.localize("RR.Def.Ref"), sign(saves.ref?.total ?? 0))}${stat(game.i18n.localize("RR.Def.Will"), sign(saves.will?.total ?? 0))}</div>`;
    html += noteGroup(game.i18n.localize("RR.Def.SaveNotes"), saveNotes);

    html += noteGroup(game.i18n.localize("RR.Def.DamageReduction"), drNotes);
    html += noteGroup(game.i18n.localize("RR.Def.EnergyResistance"), erNotes);
    html += noteGroup(game.i18n.localize("RR.Def.Conditions"), conditions);

    html += `</div>`;
    return html;
  }

  // ----------------------------------------------------------
  // Concurrency guard
  //
  // A roll is not instantaneous — the dialog, the roll itself and (for a
  // player) the socket round-trip to the GM all sit between the click and the
  // moment the result appears in the card's flags. Every duplicate check in
  // _handleRoll reads those flags, so a second click arriving inside that
  // window sees a card nobody has rolled on yet and rolls again, overwriting
  // the first result. These helpers hold a lock on the *slot* a click is about
  // to fill, from the click until the result is visibly committed.
  // ----------------------------------------------------------

  /**
   * The identity of the *roll slot* a click fills — the unit the card's own
   * duplicate checks are expressed in. Two clicks that would land in the same
   * roll slot share a key and must not run concurrently; anything else is free
   * to proceed.
   *
   * Mirrors the checks in _handleRoll: a single-check card has one primary slot
   * however many tokens are around; multi cards allow one action (roll *or*
   * aid) per token; targeted cards spend one action per actor id, whether that
   * actor rolled for itself or aided someone else.
   *
   * @param {string} scopeId - The request this click belongs to (_scopeId), so
   *   two embedded requests on one message never share a lock.
   * @param {string} rollType
   * @param {{tokenId?: string, actorId?: string, targetActorId?: string}} ids
   * @returns {string|null} Key, or null when the roll type has no slot to lock.
   */
  static _rollSlotKey(scopeId, rollType, { tokenId, actorId, targetActorId } = {}) {
    switch (rollType) {
      case "primary":     return `${scopeId}:primary`;
      case "aid":         return `${scopeId}:aid:${tokenId}`;
      case "multi":
      case "multiAid":    return `${scopeId}:action:${tokenId}`;
      case "targeted":    return `${scopeId}:used:${targetActorId}`;
      case "targetedAid": return `${scopeId}:used:${actorId}`;
      default:            return null;
    }
  }

  /**
   * Whether a request's committed state already fills the roll slot a result
   * targets. The counterpart to _rollSlotKey: same rules, asked of the flags
   * rather than of the click.
   *
   * @param {object} flags - The request's current flag state.
   * @param {string} rollType
   * @param {{tokenId?: string, actorId?: string, targetActorId?: string}} ids
   * @returns {boolean}
   */
  static _isRollSlotFilled(flags, rollType, { tokenId, actorId, targetActorId } = {}) {
    switch (rollType) {
      case "primary":     return Object.keys(flags.rolledActors || {}).length > 0;
      // One action per token, spent by rolling *or* aiding — as in _handleRoll.
      case "multi":
      case "multiAid":    return !!(flags.rolledActors || {})[tokenId] || !!(flags.aidResults || {})[tokenId];
      case "aid":         return !!(flags.aidResults || {})[tokenId];
      case "targeted":    return (flags.usedActorIds || []).includes(targetActorId);
      case "targetedAid": return (flags.usedActorIds || []).includes(actorId);
      default:            return false;
    }
  }

  /**
   * Claim a roll slot for the click now being handled. Returns false when
   * another click already holds it, in which case the caller must abort.
   *
   * Only the first rejected click notifies: a double-click is usually just an
   * impatient one, and five stacked warnings say nothing the first didn't.
   *
   * @param {string|null} key
   * @param {string} actorName - Named in the notification.
   * @returns {boolean} True when the slot was claimed by this call.
   */
  static _acquireRollSlot(key, actorName) {
    if (!key) return true;
    const held = RollRequestChat._inFlight.get(key);
    if (held) {
      if (!held.warned) {
        held.warned = true;
        ui.notifications.warn(game.i18n.format("RR.Notif.RollInProgress", { name: actorName }));
      }
      return false;
    }
    RollRequestChat._inFlight.set(key, { warned: false });
    return true;
  }

  /**
   * Release a slot once the card's flags actually show the result.
   *
   * A GM's own update is already committed by the time _commitResult returns,
   * so this usually releases immediately. A player's result went out over the
   * socket and lands a round-trip later — holding the lock across that gap is
   * what stops a follow-up click from passing duplicate checks on flags that
   * have not caught up yet. A repick, which overwrites a slot that is already
   * filled, also releases at once; the lock has already done its job by
   * holding across the dialog.
   *
   * The timeout is a backstop: a socket message the GM never processes (nobody
   * connected, an error on their side) must not jam the slot for the session.
   *
   * @param {ChatMessage} message
   * @param {string} key
   * @param {string} rollType
   * @param {object} ids - As passed to _rollSlotKey.
   * @param {string|null} [slot] - Embed slot the result belongs to.
   */
  static _releaseWhenCommitted(message, key, rollType, ids, slot = null) {
    const filled = (doc) => RollRequestChat._isRollSlotFilled(RollRequestChat._readState(doc, slot) ?? {}, rollType, ids);
    if (filled(message)) {
      RollRequestChat._inFlight.delete(key);
      return;
    }

    let timeout;
    const release = () => {
      Hooks.off("updateChatMessage", hookId);
      clearTimeout(timeout);
      RollRequestChat._inFlight.delete(key);
    };
    const hookId = Hooks.on("updateChatMessage", (doc) => {
      if (doc.id === message.id && filled(doc)) release();
    });
    timeout = setTimeout(release, 15000);
  }

  // ----------------------------------------------------------
  // Core Roll Handler
  // ----------------------------------------------------------

  /**
   * Entry point for every roll button. Wraps the real handler so the slot lock
   * it claims is always released — held until the result is committed, dropped
   * straight away when the click bailed out (cancelled dialog, failed
   * validation, error).
   */
  static async _handleRoll(message, flags, rollType, opts = {}) {
    const gate = { release: null, committed: false };
    try {
      return await RollRequestChat._handleRollInner(message, flags, rollType, opts, gate);
    } finally {
      gate.release?.(gate.committed);
    }
  }

  static async _handleRollInner(message, _flags, rollType, opts = {}, gate = {}) {
    const { targetActorId, slot = null } = opts;

    // Re-read flags from the message to get the latest state. For an embedded
    // request that is its own sub-object, not the message's flag scope.
    const currentFlags = RollRequestChat._readState(message, slot);
    if (!currentFlags || !currentFlags.request) {
      ui.notifications.error(game.i18n.localize("RR.Notif.CantReadData"));
      return;
    }

    // A locked card accepts nothing further (API: lockRequest). Its buttons are
    // already gone, so this only catches a click racing the re-render.
    if (currentFlags.locked) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.RequestLocked"));
      return;
    }

    const request = currentFlags.request;
    const dc = currentFlags.dc;

    // --- Acquire actor and tokenId based on roll type ---
    let actor, tokenId;
    if (rollType === "targeted") {
      // If the target entry has a tokenUUID, look up via the token (handles unlinked tokens).
      // Otherwise fall back to actor ID lookup (dialog-created requests with linked actors).
      const entry = currentFlags.targetedActors?.find(t => t.id === targetActorId);
      if (entry?.tokenUUID) {
        const tokenDoc = fromUuidSync(entry.tokenUUID);
        actor = tokenDoc?.actor;
        tokenId = tokenDoc?.id ?? null;
      } else {
        actor = game.actors.get(targetActorId);
        tokenId = actor?.getActiveTokens?.()?.[0]?.id ?? null;
      }
      if (!actor) { ui.notifications.warn(game.i18n.localize("RR.Notif.TargetNotFound")); return; }
    } else {
      // All other roll types use the currently controlled token.
      const token = canvas.tokens.controlled[0];
      if (token) {
        actor = token.actor;
        if (!actor) { ui.notifications.warn(game.i18n.localize("RR.Notif.TokenNoActor")); return; }
        tokenId = token.id;
      } else if (game.settings.get(MODULE_ID, "use-configured-actor") && game.user.character) {
        // Nothing selected: fall back to the actor set in this user's configuration.
        actor = game.user.character;
        // Prefer an active token on the current scene for dedup; else key on the actor id.
        tokenId = actor.getActiveTokens?.()?.[0]?.id ?? actor.id;
      } else {
        ui.notifications.warn(game.i18n.localize("RR.Notif.SelectTokenFirst"));
        return;
      }
    }

    // --- Permission check: targeted primary rolls are actor-specific ---
    if (rollType === "targeted" && !game.user.isGM) {
      const entry = currentFlags.targetedActors?.find(t => t.id === targetActorId);
      const canRoll = entry?.tokenUUID ? actor.isOwner : game.user.character?.id === targetActorId;
      if (!canRoll) {
        ui.notifications.warn(game.i18n.localize(entry?.tokenUUID
          ? "RR.Notif.OnlyOwnTokens"
          : "RR.Notif.OnlyOwnCharacter"));
        return;
      }
    }

    // --- Prevent self-aid in targeted sections ---
    if (rollType === "targetedAid" && actor.id === targetActorId) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.CannotAidSelf"));
      return;
    }

    // --- Changing an existing selection (allowRepick requests only) ---
    // Where the request allows it, clicking again reopens the dropdown and the
    // new pick replaces the old one. This is confined to the slot the clicker
    // already filled — their own token in single/multi, and in targeted the
    // target whose ownership was checked above — so it never overwrites
    // somebody else's choice.
    const existingSelection = (currentFlags.selectFromTable && currentFlags.allowRepick)
      ? (rollType === "targeted"
        ? currentFlags.actorResults?.[targetActorId]
        : currentFlags.rolledActors?.[tokenId])
      : null;

    // --- Duplicate / one-action-per-actor checks ---
    if (existingSelection) {
      // Skipped: this click is a change to that slot, not a second action.
    } else if (rollType === "multi") {
      const rolledActors = currentFlags.rolledActors || {};
      const aidResults = currentFlags.aidResults || {};
      if (rolledActors[tokenId] || aidResults[tokenId]) {
        ui.notifications.warn(game.i18n.format("RR.Notif.AlreadyUsedAction", { name: actor.name }));
        return;
      }
    } else if (rollType === "multiAid") {
      const rolledActors = currentFlags.rolledActors || {};
      const aidResults = currentFlags.aidResults || {};
      if (rolledActors[tokenId] || aidResults[tokenId]) {
        ui.notifications.warn(game.i18n.format("RR.Notif.AlreadyUsedAction", { name: actor.name }));
        return;
      }
    } else if (rollType === "aid") {
      const aidResults = currentFlags.aidResults || {};
      if (aidResults[tokenId]) {
        ui.notifications.warn(game.i18n.format("RR.Notif.AlreadyProvidedAid", { name: actor.name }));
        return;
      }
    } else if (rollType === "primary") {
      const rolledActors = currentFlags.rolledActors || {};
      if (Object.keys(rolledActors).length > 0) {
        ui.notifications.warn(game.i18n.localize("RR.Notif.PrimaryAlreadyRolled"));
        return;
      }
    } else if (rollType === "targeted") {
      const usedActorIds = currentFlags.usedActorIds || [];
      if (usedActorIds.includes(targetActorId)) {
        ui.notifications.warn(game.i18n.format("RR.Notif.AlreadyUsedAction", { name: actor.name }));
        return;
      }
    } else if (rollType === "targetedAid") {
      const usedActorIds = currentFlags.usedActorIds || [];
      if (usedActorIds.includes(actor.id)) {
        ui.notifications.warn(game.i18n.format("RR.Notif.AlreadyUsedAction", { name: actor.name }));
        return;
      }
    }

    // --- Claim this slot for the duration of the roll ---
    // The checks above only see results that are already committed; this covers
    // the click-to-commit window they can't. Everything up to here is
    // synchronous from the click handler, so a burst of clicks reaches this
    // point one at a time and only the first gets through.
    const ids = { tokenId, actorId: actor.id, targetActorId };
    const rollSlotKey = RollRequestChat._rollSlotKey(
      RollRequestChat._scopeId(message.id, slot), rollType, ids);
    if (!RollRequestChat._acquireRollSlot(rollSlotKey, actor.name)) return;
    gate.release = (committed) => {
      if (!rollSlotKey) return;
      if (committed) RollRequestChat._releaseWhenCommitted(message, rollSlotKey, rollType, ids, slot);
      else RollRequestChat._inFlight.delete(rollSlotKey);
    };
    const isRepick = !!existingSelection;

    // --- Selection instead of a roll ---
    // On a selectFromTable card the clicker picks a row of the result table and
    // that choice *is* the result. No dice are involved, so the roll-side
    // validations (trained-only, natural-20 feasibility) and Dice So Nice have
    // nothing to act on; the entry carries no rollData, which every display path
    // already treats as "no expandable details".
    if (currentFlags.selectFromTable) {
      const chosen = await RollRequestChat._promptTableSelection(currentFlags, existingSelection);
      if (!chosen) return; // Dialog dismissed

      await RollRequestChat._commitResult(message, rollType, {
        tokenId,
        actorId: actor.id,
        resultKey: rollType === "targeted" ? targetActorId : actor.id,
        actorName: actor.name,
        actorImg: actor.img,
        total: chosen.total,
        formula: null,
        naturalRoll: null,
        rollData: null,
        notes: [],
        selectedIndex: chosen.index,
        selectedLabel: chosen.label,
      }, currentFlags, { ...opts, isRepick });
      gate.committed = true;
      return;
    }

    // --- Validation: Trained-only check ---
    // Skipped for save-request-style cards (auto-generated from an attack card):
    // those behave exactly like a saving throw — every target always rolls,
    // regardless of ranks or feasibility.
    if (request.type === "skill" && !currentFlags.isSaveRequest) {
      const sklInfo = actor.getSkillInfo?.(request.key);
      if (sklInfo && sklInfo.rt && sklInfo.rank === 0) {
        // RAW: a Knowledge check of DC 10 or lower can be attempted untrained;
        // every other trained-only skill (and Knowledge above DC 10) still gates.
        const knowledgeUntrainedOk =
          RollRequestChat._isKnowledgeSkill(request.key) && dc != null && dc <= 10;
        if (!knowledgeUntrainedOk) {
          ui.notifications.warn(
            game.i18n.format("RR.Notif.TrainedOnly", { name: actor.name, check: request.name })
          );
          return;
        }
      }
    }

    // --- Validation: Natural-20 feasibility check ---
    if (dc != null && request.type !== "dice" && request.type !== "save" && !currentFlags.isSaveRequest) {
      const isAidRoll = rollType === "aid" || rollType === "targetedAid" || rollType === "multiAid";

      // "Allow un-passable checks" opens the gate for everyone (primary rollers
      // and aiders alike); "Ignore aid requirement" additionally frees aiders on
      // its own, for when the primary check should still be gated.
      const bypass = currentFlags.allowUnpassable
        || (isAidRoll && currentFlags.ignoreAidRequirement);

      if (!bypass) {
        let maxPossible = RollRequestChat._getMaxRoll(actor, request);
        if (maxPossible !== null) {
          // A primary roller counts the aid already banked toward this check, so
          // someone who can't reach the DC alone but can *with* aid may still roll.
          // (Mirrors the aid bonus pre-populated into their actual roll below.)
          // Aiders don't benefit — aid doesn't stack onto an aider's own feasibility.
          if (!isAidRoll && currentFlags.includeAid) {
            maxPossible += rollType === "targeted"
              ? RollRequestChat._calculateAidTotalForActor(currentFlags, targetActorId)
              : (currentFlags.aidTotal || 0);
          }
          if (maxPossible < dc) {
            const msg = isAidRoll
              ? game.i18n.format("RR.Notif.CannotAidImpossible", { name: actor.name })
              : game.i18n.format("RR.Notif.CannotSucceed", { name: actor.name });
            ui.notifications.warn(msg);
            return;
          }
        }
      }
    }

    // --- Perform the Roll ---
    let rollResult;
    try {
      if (rollType === "targeted" && currentFlags.includeAid) {
        // Pre-populate this actor's accumulated aid bonus into the roll dialog
        const aidTotal = RollRequestChat._calculateAidTotalForActor(currentFlags, targetActorId);
        rollResult = await RollRequestChat._rollWithAidBonus(actor, request, currentFlags, dc, aidTotal);
      } else if (rollType === "primary" && currentFlags.includeAid) {
        rollResult = await RollRequestChat._rollWithAidBonus(actor, request, currentFlags, dc);
      } else if (rollType === "multi" && currentFlags.includeAid) {
        // Use the current unredeemed aid pool (resets to 0 after each primary roll)
        const aidTotal = currentFlags.aidTotal || 0;
        rollResult = await RollRequestChat._rollWithAidBonus(actor, request, currentFlags, dc, aidTotal);
      } else {
        rollResult = await RollRequestChat._performRoll(actor, request, dc);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Roll error:`, err);
      ui.notifications.error(game.i18n.localize("RR.Notif.RollError"));
      return;
    }

    if (!rollResult) return; // User cancelled the dialog

    await RollRequestChat._showDiceSoNice(rollResult, currentFlags.rollMode);

    // Extract effect notes and footnotes
    const notes = await RollRequestChat._getEffectNotes(actor, request);

    // Build the result entry
    const resultEntry = {
      tokenId,
      actorId: actor.id,
      resultKey: rollType === "targeted" ? targetActorId : actor.id,
      actorName: actor.name,
      actorImg: actor.img,
      total: rollResult.total,
      formula: rollResult.formula,
      naturalRoll: rollResult.dice?.[0]?.results?.[0]?.result ?? null,
      rollData: rollResult.toJSON(),
      notes,
    };

    // For Aid rolls: calculate the bonus contributed
    if (rollType === "aid" || rollType === "targetedAid" || rollType === "multiAid") {
      if (resultEntry.total >= 10) {
        // Scaling +1 per 5 over the DC only applies when the uncap setting is enabled.
        const uncapped = game.settings.get(MODULE_ID, "uncap-aid-another");
        const extraBonus = uncapped ? Math.floor((resultEntry.total - 10) / 5) : 0;
        resultEntry.aidBonus = 2 + extraBonus;
        resultEntry.aidSuccess = true;
      } else {
        resultEntry.aidBonus = 0;
        resultEntry.aidSuccess = false;
      }
    }

    await RollRequestChat._commitResult(message, rollType, resultEntry, currentFlags, { ...opts, isRepick });
    gate.committed = true;
  }

  // ----------------------------------------------------------
  // Post a finished result to the card: applied directly by a GM, handed to one
  // over the socket by anyone else (only the GM writes to the message).
  // ----------------------------------------------------------

  static async _commitResult(message, rollType, resultEntry, currentFlags, opts = {}) {
    if (game.user.isGM) {
      await RollRequestChat._updateMessage(message, rollType, resultEntry, currentFlags, opts);
    } else {
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "rollResult",
        messageId: message.id,
        rollType,
        targetActorId: opts.targetActorId ?? null,
        isRepick: opts.isRepick ?? false,
        // Which request on the message this result belongs to; null = the card itself.
        slot: opts.slot ?? null,
        resultEntry,
      });
    }
  }

  // ----------------------------------------------------------
  // Perform a silent roll (no chat message)
  // ----------------------------------------------------------

  static async _performRoll(actor, request, dc, extraOpts = {}) {
    const opts = {
      skipDialog: false,
      chatMessage: false,
      ...extraOpts,
    };
    if (dc != null) opts.dc = dc;

    let msg;
    if (request.type === "ability") {
      msg = await actor.rollAbilityTest(request.key, opts);
    } else if (request.type === "save") {
      msg = await actor.rollSavingThrow(request.key, opts);
    } else if (request.type === "skill") {
      msg = await actor.rollSkill(request.key, opts);
    } else if (request.type === "dice") {
      // Plain dice roll
      const roll = new Roll(request.key);
      await roll.evaluate();
      return roll;
    }

    if (!msg) return null;

    // PF1 returns message data when chatMessage: false
    // Extract the Roll from msg.rolls (array of JSON strings or Roll instances)
    if (msg.rolls?.length) {
      const r = msg.rolls[0];
      if (r instanceof Roll) return r;
      if (typeof r === "string") return Roll.fromJSON(r);
      if (typeof r === "object") return Roll.fromData(r);
    }
    if (msg instanceof Roll) return msg;

    return null;
  }

  // ----------------------------------------------------------
  // Perform roll with aid bonus pre-populated in dialog
  // ----------------------------------------------------------

  static async _rollWithAidBonus(actor, request, flags, dc, aidTotalOverride = null) {
    const aidTotal = aidTotalOverride !== null
      ? aidTotalOverride
      : RollRequestChat._calculateAidTotal(flags);

    const opts = {
      skipDialog: false,    // Show the confirmation dialog
      chatMessage: false,
    };
    if (dc != null) opts.dc = dc;

    // Pre-populate the situational bonus with the aid total
    if (aidTotal > 0) {
      opts.bonus = `${aidTotal}[Aid Another]`;
    }

    let msg;
    if (request.type === "ability") {
      msg = await actor.rollAbilityTest(request.key, opts);
    } else if (request.type === "save") {
      msg = await actor.rollSavingThrow(request.key, opts);
    } else if (request.type === "skill") {
      msg = await actor.rollSkill(request.key, opts);
    } else if (request.type === "dice") {
      const formula = aidTotal > 0 ? `${request.key} + ${aidTotal}[Aid Another]` : request.key;
      const roll = new Roll(formula);
      await roll.evaluate();
      return roll;
    }

    if (!msg) return null;

    // PF1 returns message data when chatMessage: false
    if (msg.rolls?.length) {
      const r = msg.rolls[0];
      if (r instanceof Roll) return r;
      if (typeof r === "string") return Roll.fromJSON(r);
      if (typeof r === "object") return Roll.fromData(r);
    }
    if (msg instanceof Roll) return msg;

    return null;
  }

  // ----------------------------------------------------------
  // Whether a skill key is a Knowledge skill. Every Knowledge skill key —
  // system (kar, kdu, ken, …) and astora's custom kps — begins with "k", and no
  // other PF1 skill does, so the prefix is a reliable test. Used for the RAW
  // "Knowledge DC 10 or lower may be attempted untrained" exception.
  // ----------------------------------------------------------

  static _isKnowledgeSkill(key) {
    return typeof key === "string" && key.startsWith("k");
  }

  // ----------------------------------------------------------
  // Get the max possible roll (natural 20 + modifier)
  // ----------------------------------------------------------

  static _getMaxRoll(actor, request) {
    try {
      if (request.type === "skill") {
        const skl = actor.getSkillInfo?.(request.key);
        return skl ? 20 + skl.mod : null;
      } else if (request.type === "ability") {
        const abl = actor.system?.abilities?.[request.key];
        return abl ? 20 + abl.mod : null;
      } else if (request.type === "save") {
        const save = actor.system?.attributes?.savingThrows?.[request.key];
        return save ? 20 + save.total : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  // ----------------------------------------------------------
  // Obscure NPC token names on targeted cards via pf1-token-randomizer.
  // No-op when the module is absent/inactive or its API is missing. Runs
  // per-viewer in the render hook and delegates the whole policy to the
  // randomizer's permission-gated `getDisplayName` — so the GM and any observer
  // keep the real name, and only non-observers (with an obscured name set) see
  // the substituted one. Covers DM checks and any other targeted card that a
  // player can see.
  // ----------------------------------------------------------

  static _applyNameObscuring(card, flags) {
    if (flags.mode !== "targeted") return;
    const tr = game.modules.get("pf1-token-randomizer");
    const api = tr?.active ? tr.api : null;
    if (!api?.getDisplayName) return;

    for (const block of card.querySelectorAll(".arr-targeted-block")) {
      const entry = flags.targetedActors?.find(t => t.id === block.dataset.actorId);
      if (!entry?.tokenUUID) continue;
      const tokenDoc = fromUuidSync(entry.tokenUUID);
      if (!tokenDoc) continue;
      const display = api.getDisplayName(tokenDoc, game.user) || entry.name;
      if (display === entry.name) continue;
      const nameEl = block.querySelector(".arr-actor-name");
      if (nameEl) nameEl.textContent = display;
      const img = block.querySelector(".arr-actor-img");
      if (img) img.alt = display;
    }
  }

  // ----------------------------------------------------------
  // Get the check-kind label shown in the card title
  // (e.g. "Single Check", "Multi-Check", "Selected Check").
  // ----------------------------------------------------------

  static _getCheckKindLabel(flags) {
    // DM checks render as "targeted" cards but get their own tag.
    if (flags.isDMCheck) return game.i18n.localize("RR.Card.KindDM");
    // Auto-generated save-request cards are treated as their own thing (they also
    // skip the aggregate line), so we don't tag them with a check-kind label.
    if (flags.isSaveRequest) return "";
    switch (flags.mode) {
      case "single":   return game.i18n.localize("RR.Card.KindSingle");
      case "multi":    return game.i18n.localize("RR.Card.KindMulti");
      case "targeted": return game.i18n.localize("RR.Card.KindSelected");
      default:         return "";
    }
  }

  // ----------------------------------------------------------
  // Get display name for a roll mode + results visibility combo
  // ----------------------------------------------------------

  static _getModeName(rollMode, showResults) {
    if (rollMode === "publicblind") {
      return game.i18n.localize(showResults ? "RR.Mode.BlindRoll" : "RR.Mode.BlindRollHidden");
    }
    if (rollMode === "blindroll") return game.i18n.localize("RR.Mode.BlindGMRoll");
    if (rollMode === "gmroll") {
      return game.i18n.localize(showResults ? "RR.Mode.PrivateGMRoll" : "RR.Mode.PrivateGMRollHidden");
    }
    // "roll" (public) and any fallback
    return game.i18n.localize(showResults ? "RR.Mode.PublicRoll" : "RR.Mode.PublicRollHidden");
  }

  // ----------------------------------------------------------
  // Get effect notes for a request type
  // ----------------------------------------------------------

  static async _getEffectNotes(actor, request) {
    try {
      if (typeof actor.getContextNotesParsed !== "function") return [];

      let context;
      if (request.type === "skill") {
        context = `skill.${request.key}`;
      } else if (request.type === "save") {
        context = `savingThrow.${request.key}`;
      } else if (request.type === "ability") {
        context = `abilityChecks.${request.key}`;
      }

      if (!context) return [];

      const notes = await actor.getContextNotesParsed(context);
      return notes.map(n => n.text);
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------
  // Show Dice So Nice 3D animation for a roll
  // ----------------------------------------------------------

  static async _showDiceSoNice(roll, rollMode) {
    if (!game.dice3d) return;
    if (typeof game.dice3d.isEnabled === "function" && !game.dice3d.isEnabled()) return;
    if (!roll?.dice?.length) return;
    try {
      // Create a clean Roll copy to avoid any state issues with PF1's Roll subclass
      const cleanRoll = Roll.fromData(JSON.parse(JSON.stringify(roll.toJSON())));

      if (rollMode === "publicblind") {
        // Skip — GM triggers the blind animation from _updateMessage so all clients
        // (including the roller) receive it as a ? roll rather than seeing real dice.
        return;
      } else {
        const chatData = {};
        ChatMessage.applyRollMode(chatData, rollMode);
        const whisper = chatData.whisper?.length ? chatData.whisper : null;
        const blind = chatData.blind || false;
        await game.dice3d.showForRoll(cleanRoll, game.user, true, whisper, blind);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Dice So Nice error:`, err);
    }
  }

  // ----------------------------------------------------------
  // Calculate total aid bonus for the standard single-check card
  // ----------------------------------------------------------

  static _calculateAidTotal(flags) {
    const aidResults = flags.aidResults || {};
    let total = 0;
    for (const entry of Object.values(aidResults)) {
      if (entry.aidSuccess) total += entry.aidBonus;
    }
    return total;
  }

  // ----------------------------------------------------------
  // Calculate aid bonus accumulated for one specific targeted actor
  // ----------------------------------------------------------

  static _calculateAidTotalForActor(flags, targetActorId) {
    const aidMap = flags.actorAidResults?.[targetActorId] || {};
    let total = 0;
    for (const entry of Object.values(aidMap)) {
      if (entry.aidSuccess) total += entry.aidBonus;
    }
    return total;
  }

  // ----------------------------------------------------------
  // Update the ChatMessage with a new roll result
  // ----------------------------------------------------------

  static async _updateMessage(message, rollType, resultEntry, _flags, opts = {}) {
    // Serialize all updates to the same message. Without this, two roll results
    // arriving close together (the GM socket dispatcher does not await its
    // handlers) both read the same pre-update flags and the second write clobbers
    // the first — aid bonuses overwrite instead of stacking. Chaining the work
    // per-message forces each call to read state committed by the prior one.
    const prev = RollRequestChat._updateQueues.get(message.id) ?? Promise.resolve();
    // The passed-in `flags` snapshot is stale once queued, so _applyUpdate
    // re-reads fresh flags from the message at execution time. Swallow a prior
    // failure so one bad update doesn't poison the chain for later rolls.
    const next = prev
      .catch(() => {})
      .then(() => RollRequestChat._applyUpdate(message, rollType, resultEntry, opts));
    RollRequestChat._updateQueues.set(message.id, next);
    try {
      await next;
    } finally {
      // Drop the chain once idle so the Map doesn't grow unbounded.
      if (RollRequestChat._updateQueues.get(message.id) === next) {
        RollRequestChat._updateQueues.delete(message.id);
      }
    }
  }

  static async _applyUpdate(message, rollType, resultEntry, opts = {}) {
    const { targetActorId, slot = null } = opts;
    // Re-read flags now (after any prior queued update has committed) so this
    // update builds on the latest state rather than a snapshot taken at enqueue.
    const flags = RollRequestChat._readState(message, slot) ?? {};

    // Authoritative duplicate guard — the last word on whether a slot is
    // already spoken for. The client that rolled checked too, but against its
    // own view of the card: a player's result crosses the socket, so their view
    // is a round-trip old, and two clients eligible for the same slot (any
    // player on a single-check card, a GM and an owner on a targeted one) can
    // each believe they are first. This runs GM-side inside the per-message
    // queue on freshly committed flags, where neither is possible.
    //
    // A repick is a deliberate overwrite of the clicker's own slot, so it is
    // the one write allowed to land on an occupied one.
    const reject = (reason) => console.warn(
      `${MODULE_ID} | Discarded ${rollType} result for ${resultEntry?.actorName} on message ${message.id}: ${reason}.`
    );
    // A slot whose embed has since been closed has no request left to record on.
    if (!flags.request) return void reject("request no longer exists");
    if (flags.locked) return void reject("request is closed");
    if (!opts.isRepick && RollRequestChat._isRollSlotFilled(flags, rollType, {
      tokenId: resultEntry.tokenId,
      actorId: resultEntry.actorId,
      targetActorId: targetActorId ?? resultEntry.resultKey ?? resultEntry.actorId,
    })) return void reject("slot already has a result");

    // Changes are collected relative to the request's own flag scope, then
    // written through _statePath — which is what lets one code path serve both a
    // whole card and an embed several levels down in the same flags.
    const changes = {};

    if (rollType === "multi") {
      const rolledActors = foundry.utils.deepClone(flags.rolledActors || {});
      rolledActors[resultEntry.tokenId] = resultEntry;
      changes.rolledActors = rolledActors;

      if (flags.includeAid) {
        // Mark all currently unredeemed aid entries as consumed and reset the pool
        const aidResults = foundry.utils.deepClone(flags.aidResults || {});
        for (const entry of Object.values(aidResults)) {
          if (!entry.consumed) entry.consumed = true;
        }
        changes.aidResults = aidResults;
        changes.aidTotal = 0;
      }

    } else if (rollType === "multiAid") {
      const aidResults = foundry.utils.deepClone(flags.aidResults || {});
      aidResults[resultEntry.tokenId] = resultEntry;
      changes.aidResults = aidResults;
      changes.aidTotal = (flags.aidTotal || 0) + (resultEntry.aidBonus || 0);

    } else if (rollType === "aid") {
      const aidResults = foundry.utils.deepClone(flags.aidResults || {});
      aidResults[resultEntry.tokenId] = resultEntry;
      changes.aidResults = aidResults;
      changes.aidTotal = RollRequestChat._calculateAidTotal({ aidResults });

    } else if (rollType === "primary") {
      const rolledActors = foundry.utils.deepClone(flags.rolledActors || {});
      rolledActors[resultEntry.tokenId] = resultEntry;
      changes.rolledActors = rolledActors;

    } else if (rollType === "targeted") {
      const actorResults = foundry.utils.deepClone(flags.actorResults || {});
      const resultKey = resultEntry.resultKey ?? resultEntry.actorId;
      actorResults[resultKey] = resultEntry;
      changes.actorResults = actorResults;

      const usedActorIds = [...(flags.usedActorIds || [])];
      if (!usedActorIds.includes(resultKey)) usedActorIds.push(resultKey);
      changes.usedActorIds = usedActorIds;

    } else if (rollType === "targetedAid") {
      const actorAidResults = foundry.utils.deepClone(flags.actorAidResults || {});
      if (!actorAidResults[targetActorId]) actorAidResults[targetActorId] = {};
      actorAidResults[targetActorId][resultEntry.actorId] = resultEntry;
      changes.actorAidResults = actorAidResults;

      const usedActorIds = [...(flags.usedActorIds || [])];
      if (!usedActorIds.includes(resultEntry.actorId)) usedActorIds.push(resultEntry.actorId);
      changes.usedActorIds = usedActorIds;
    }

    const updatedFlags = foundry.utils.mergeObject(foundry.utils.deepClone(flags), changes);

    const updateData = {};
    for (const [key, value] of Object.entries(changes)) {
      updateData[RollRequestChat._statePath(slot, key)] = value;
    }
    // An embedded request never touches message.content — the host owns it, and
    // rewriting it would freeze whatever the host had injected at render time.
    // The flag write alone re-renders the message, which is all the host needs.
    if (!slot) updateData.content = await RollRequestChat._rebuildCardContent(updatedFlags);

    await message.update(updateData);

    // Fire hook for every roll result
    Hooks.callAll("pf1RollRequests.rollComplete", {
      messageId: message.id,
      slot,
      rollType,
      result: resultEntry,
      flags: updatedFlags,
    });

    // Invoke the streaming onResult callback (if any) with a normalized,
    // best-of-ready payload: every primary entry so far, each with a computed
    // pass/fail, plus the entry just rolled.
    const resultCallback = RollRequestChat._resultCallbacks.get(
      RollRequestChat._callbackKey(message.id, slot));
    if (resultCallback) {
      const dc = updatedFlags.dc;
      const withPass = (e) => ({ ...e, passed: dc != null ? e.total >= dc : null });
      try {
        resultCallback({
          messageId: message.id,
          slot,
          rollType,
          result: withPass(resultEntry),
          results: Object.values(updatedFlags.rolledActors || {}).map(withPass),
          aidResults: Object.values(updatedFlags.aidResults || {}),
          dc,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | onResult callback threw:`, err);
      }
    }

    // Resolve pending promise for single-check primary rolls. Embeds have no
    // awaitResult — a Promise held on one client dies on reload — so this is
    // whole-card only.
    if (!slot && rollType === "primary" && updatedFlags.mode === "single") {
      const pending = RollRequestChat._pendingResults.get(message.id);
      if (pending) {
        const dc = updatedFlags.dc;
        const passed = dc != null ? resultEntry.total >= dc : null;
        pending.resolve({
          messageId: message.id,
          total: resultEntry.total,
          actorId: resultEntry.actorId,
          actorName: resultEntry.actorName,
          actorImg: resultEntry.actorImg,
          passed,
          naturalRoll: resultEntry.naturalRoll,
          dc,
          formula: resultEntry.formula,
          aidTotal: updatedFlags.aidTotal || 0,
          aidResults: updatedFlags.aidResults || {},
          notes: resultEntry.notes || [],
        });
        RollRequestChat._pendingResults.delete(message.id);
      }
    }
  }

  // ----------------------------------------------------------
  // Rebuild the full card HTML from current flag state
  // ----------------------------------------------------------

  static async _rebuildCardContent(flags) {
    let template;
    if (flags.mode === "single") {
      template = `modules/${MODULE_ID}/src/templates/chat-card-single.html`;
    } else if (flags.mode === "targeted") {
      template = `modules/${MODULE_ID}/src/templates/chat-card-targeted.html`;
    } else {
      template = `modules/${MODULE_ID}/src/templates/chat-card-multi.html`;
    }

    const requestName = flags.request.name;
    const name = flags.flavor || requestName;
    const modeName = RollRequestChat._getModeName(flags.rollMode, flags.showResults);

    const templateData = {
      name,
      requestName,
      dc: flags.dc,
      showDC: flags.showDC,
      showResults: flags.showResults,
      flavor: flags.flavor,
      includeAid: flags.includeAid,
      modeName,
      targetedActors: flags.targetedActors ?? [],
      isSaveRequest: flags.isSaveRequest ?? false,
      isSelection: flags.selectFromTable ?? false,
      locked: flags.locked ?? false,
      checkKindLabel: RollRequestChat._getCheckKindLabel(flags),
      description: flags.description ?? "",
      tableHtml: RollRequestChat._renderResultTable(flags),
      summaryHtml: RollRequestChat._renderSummary(flags),
      aggregateHtml: RollRequestChat._renderAggregate(flags),
    };

    let html = await renderTemplate(template, templateData);

    // Parse the HTML and inject results
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const card = doc.querySelector(".arr-card");

    if (flags.mode === "multi") {
      await RollRequestChat._injectMultiResults(card, flags);
    } else if (flags.mode === "single") {
      await RollRequestChat._injectSingleResults(card, flags);
    } else if (flags.mode === "targeted") {
      await RollRequestChat._injectTargetedResults(card, flags);
    }

    return (flags.pf1HeaderHtml ?? "") + card.outerHTML + (flags.pf1FooterHtml ?? "");
  }

  // ----------------------------------------------------------
  // Inject multi-check results into the card DOM
  // ----------------------------------------------------------

  static async _injectMultiResults(card, flags) {
    const hideTotalFromPlayers = flags.rollMode === "publicblind";

    // Primary roll results
    const list = card.querySelector(".arr-results-list");
    if (list) {
      const rolledActors = flags.rolledActors || {};
      const dc = flags.dc;
      const showResults = flags.showResults;
      for (const entry of Object.values(rolledActors)) {
        list.insertAdjacentHTML("beforeend", await RollRequestChat._buildResultHTML(entry, dc, showResults, hideTotalFromPlayers, flags.resultTable));
      }
    }

    if (flags.includeAid) {
      // Aid results (all history; consumed ones are greyed via CSS class)
      const aidList = card.querySelector(".arr-aid-results");
      if (aidList) {
        const aidResults = flags.aidResults || {};
        for (const entry of Object.values(aidResults)) {
          aidList.insertAdjacentHTML("beforeend", await RollRequestChat._buildAidResultHTML(entry, hideTotalFromPlayers));
        }
      }

      // Aid bonus display (current unredeemed pool)
      const aidTotal = flags.aidTotal || 0;
      const bonusDisplay = card.querySelector(".arr-aid-bonus-display");
      const bonusValue = card.querySelector(".arr-aid-bonus-value");
      if (bonusDisplay && aidTotal > 0) {
        if (hideTotalFromPlayers) bonusDisplay.classList.add("gm-only");
        bonusDisplay.style.display = "inline";
        if (bonusValue) bonusValue.textContent = `+${aidTotal}`;
      }
    }
  }

  // ----------------------------------------------------------
  // Inject single-check results into the card DOM
  // ----------------------------------------------------------

  static async _injectSingleResults(card, flags) {
    const hideTotalFromPlayers = flags.rollMode === "publicblind";

    // Aid results
    const aidList = card.querySelector(".arr-aid-results");
    if (aidList) {
      const aidResults = flags.aidResults || {};
      for (const entry of Object.values(aidResults)) {
        aidList.insertAdjacentHTML("beforeend", await RollRequestChat._buildAidResultHTML(entry, hideTotalFromPlayers));
      }
    }

    // Primary result
    const primaryContainer = card.querySelector(".arr-primary-result");
    if (primaryContainer) {
      const rolledActors = flags.rolledActors || {};
      const dc = flags.dc;
      const showResults = flags.showResults;
      for (const entry of Object.values(rolledActors)) {
        primaryContainer.insertAdjacentHTML("beforeend", await RollRequestChat._buildResultHTML(entry, dc, showResults, hideTotalFromPlayers, flags.resultTable));
      }
    }

    // Update the aid bonus display
    const aidTotal = flags.aidTotal || 0;
    const bonusDisplay = card.querySelector(".arr-aid-bonus-display");
    const bonusValue = card.querySelector(".arr-aid-bonus-value");
    if (bonusDisplay && aidTotal > 0) {
      if (hideTotalFromPlayers) bonusDisplay.classList.add("gm-only");
      bonusDisplay.style.display = "inline";
      if (bonusValue) bonusValue.textContent = `+${aidTotal}`;
    }
  }

  // ----------------------------------------------------------
  // Inject targeted-check results into the card DOM (one block per actor)
  // ----------------------------------------------------------

  static async _injectTargetedResults(card, flags) {
    const actorResults = flags.actorResults || {};
    const actorAidResults = flags.actorAidResults || {};
    const dc = flags.dc;
    const showResults = flags.showResults;
    const hideTotalFromPlayers = flags.rollMode === "publicblind";

    for (const block of card.querySelectorAll(".arr-targeted-block")) {
      const actorId = block.dataset.actorId;

      // Inline primary result for this actor
      const result = actorResults[actorId];
      if (result) {
        const inlineDiv = block.querySelector('.arr-inline-result');
        const rollBtn = block.querySelector('.arr-roll-btn[data-action="rollTargeted"]');
        if (inlineDiv) {
          const passed = dc != null ? result.total >= dc : null;
          const passClass = passed === true ? "arr-pass" : passed === false ? "arr-fail" : "";
          const detailsClass = hideTotalFromPlayers ? " gm-only" : "";
          let passFailHtml = "";
          if (passed === true) {
            passFailHtml = showResults
              ? '<i class="fas fa-check arr-pass-icon"></i>'
              : '<i class="fas fa-check arr-pass-icon gm-only"></i>';
          } else if (passed === false) {
            passFailHtml = showResults
              ? '<i class="fas fa-times arr-fail-icon"></i>'
              : '<i class="fas fa-times arr-fail-icon gm-only"></i>';
          }
          // A result table replaces the number with its mapped label (see _buildResultHTML)
          const tableLabel = RollRequestChat._resolveEntryLabel(result, flags.resultTable);
          const shownTotal = tableLabel ?? result.total;
          const labelClass = tableLabel ? " arr-total-label" : "";
          const totalHtml = hideTotalFromPlayers
            ? `<span class="arr-total-value${labelClass} gm-only">${shownTotal}</span><span class="arr-total-value arr-player-only">?</span>`
            : `<span class="arr-total-value${labelClass}">${shownTotal}</span>`;

          // Render roll details
          let rollDetailsHtml = "";
          if (result.rollData) {
            try {
              const roll = Roll.fromData(result.rollData);
              rollDetailsHtml = await roll.render();
            } catch (err) {
              console.warn(`${MODULE_ID} | Could not render targeted roll details:`, err);
            }
          }
          let notesHtml = "";
          if (result.notes?.length) {
            notesHtml = `<div class="arr-notes">${result.notes.map(n => `<span class="arr-note-tag">${n}</span>`).join("")}</div>`;
          }
          const hasDetails = !!(rollDetailsHtml || notesHtml);
          const chevronHtml = hasDetails ? `<i class="fas fa-chevron-down arr-expand-icon${detailsClass}"></i>` : "";

          inlineDiv.className = `arr-inline-result arr-result-total ${passClass}`;
          inlineDiv.innerHTML = `${totalHtml}${passFailHtml}${chevronHtml}`;
          inlineDiv.removeAttribute("style");

          if (hasDetails) {
            const actorRow = block.querySelector('.arr-targeted-actor-row');
            if (actorRow) {
              actorRow.insertAdjacentHTML("afterend",
                `<div class="arr-roll-details arr-targeted-roll-details${detailsClass}">${rollDetailsHtml}${notesHtml}</div>`
              );
            }
          }
        }
        // Kept visible where the pick can still be changed.
        if (rollBtn && !(flags.selectFromTable && flags.allowRepick)) rollBtn.style.display = "none";
      }

      // Aid results for this actor's section
      const aidList = block.querySelector(".arr-aid-results");
      const aidMap = actorAidResults[actorId] || {};
      if (aidList) {
        for (const aidEntry of Object.values(aidMap)) {
          aidList.insertAdjacentHTML("beforeend",
            await RollRequestChat._buildAidResultHTML(aidEntry, hideTotalFromPlayers));
        }
      }

      // Aid bonus display
      const aidTotal = RollRequestChat._calculateAidTotalForActor(flags, actorId);
      const bonusDisplay = block.querySelector(".arr-aid-bonus-display");
      const bonusValue = block.querySelector(".arr-aid-bonus-value");
      if (bonusDisplay && aidTotal > 0) {
        if (hideTotalFromPlayers) bonusDisplay.classList.add("gm-only");
        bonusDisplay.style.display = "inline";
        if (bonusValue) bonusValue.textContent = `+${aidTotal}`;
      }
    }
  }

  // ----------------------------------------------------------
  // Build a result <li> HTML string (for insertAdjacentHTML)
  // ----------------------------------------------------------

  static async _buildResultHTML(entry, dc, showResults, hideTotalFromPlayers = false, resultTable = null) {
    const passed = dc != null ? entry.total >= dc : null;

    // With a result table the row shows the mapped label instead of the number;
    // the real roll and formula stay one click away in the expandable details.
    const tableLabel = RollRequestChat._resolveEntryLabel(entry, resultTable);

    let notesHtml = "";
    if (entry.notes?.length) {
      notesHtml = `<div class="arr-notes">${entry.notes.map(n =>
        `<span class="arr-note-tag">${n}</span>`
      ).join("")}</div>`;
    }

    // Render the roll details (formula + dice breakdown)
    let rollDetailsHtml = "";
    if (entry.rollData) {
      try {
        const roll = Roll.fromData(entry.rollData);
        rollDetailsHtml = await roll.render();
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not render roll details:`, err);
      }
    }

    // Build pass/fail icons — wrap in gm-only when results are hidden
    let passFailHtml = "";
    if (passed === true) {
      passFailHtml = showResults
        ? '<i class="fas fa-check arr-pass-icon"></i>'
        : '<i class="fas fa-check arr-pass-icon gm-only"></i>';
    } else if (passed === false) {
      passFailHtml = showResults
        ? '<i class="fas fa-times arr-fail-icon"></i>'
        : '<i class="fas fa-times arr-fail-icon gm-only"></i>';
    }

    // When results are hidden, apply pass/fail coloring only in a gm-only wrapper
    const totalClass = passed !== null && !showResults
      ? `arr-result-total`
      : `arr-result-total ${passed === true ? "arr-pass" : passed === false ? "arr-fail" : ""}`;

    // In publicblind mode the total is gm-only; players see a ? placeholder instead
    const shownTotal = tableLabel ?? entry.total;
    const labelClass = tableLabel ? " arr-total-label" : "";
    const totalHtml = hideTotalFromPlayers
      ? `<span class="arr-total-value${labelClass} gm-only">${shownTotal}</span><span class="arr-total-value arr-player-only">?</span>`
      : `<span class="arr-total-value${labelClass}">${shownTotal}</span>`;

    const hasDetails = rollDetailsHtml || notesHtml;
    const detailsClass = hideTotalFromPlayers ? " gm-only" : "";
    return `<li class="arr-result-entry flexrow" data-token-id="${entry.tokenId}">
      <div class="arr-result-row flexrow">
        <div class="arr-result-actor flexrow">
          <img class="arr-actor-img" src="${entry.actorImg}" alt="${entry.actorName}" />
          <span class="arr-actor-name">${entry.actorName}</span>
        </div>
        <div class="${totalClass}">
          ${totalHtml}
          ${passFailHtml}
          ${hasDetails ? `<i class="fas fa-chevron-down arr-expand-icon${detailsClass}"></i>` : ""}
        </div>
      </div>
      ${hasDetails ? `<div class="arr-roll-details${detailsClass}">${rollDetailsHtml}${notesHtml}</div>` : ""}
    </li>`;
  }

  // ----------------------------------------------------------
  // Build an Aid Another result <li> HTML string (for insertAdjacentHTML)
  // ----------------------------------------------------------

  static async _buildAidResultHTML(entry, hideTotalFromPlayers = false) {
    const successClass = hideTotalFromPlayers ? "" : (entry.aidSuccess ? "arr-pass" : "arr-fail");
    const bonusText = entry.aidSuccess ? `(+${entry.aidBonus})` : game.i18n.localize("RR.Aid.Failed");

    let notesHtml = "";
    if (entry.notes?.length) {
      notesHtml = `<div class="arr-notes">${entry.notes.map(n =>
        `<span class="arr-note-tag">${n}</span>`
      ).join("")}</div>`;
    }

    // Render the roll details (formula + dice breakdown)
    let rollDetailsHtml = "";
    if (entry.rollData) {
      try {
        const roll = Roll.fromData(entry.rollData);
        rollDetailsHtml = await roll.render();
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not render roll details:`, err);
      }
    }

    const totalHtml = hideTotalFromPlayers
      ? `<span class="arr-total-value gm-only">${entry.total}</span><span class="arr-total-value arr-player-only">?</span>`
      : `<span class="arr-total-value">${entry.total}</span>`;
    const bonusHtml = hideTotalFromPlayers
      ? `<span class="arr-aid-bonus gm-only">${bonusText}</span><span class="arr-aid-bonus arr-player-only">(?)</span>`
      : `<span class="arr-aid-bonus">${bonusText}</span>`;

    const hasDetails = rollDetailsHtml || notesHtml;
    const detailsClass = hideTotalFromPlayers ? " gm-only" : "";
    const consumedClass = entry.consumed ? " arr-aid-consumed" : "";
    return `<li class="arr-result-entry arr-aid-entry flexrow${consumedClass}" data-token-id="${entry.tokenId}">
      <div class="arr-result-row flexrow">
        <div class="arr-result-actor flexrow">
          <img class="arr-actor-img" src="${entry.actorImg}" alt="${entry.actorName}" />
          <span class="arr-actor-name">${entry.actorName}</span>
        </div>
        <div class="arr-result-total ${successClass}">
          ${totalHtml}
          ${bonusHtml}
          ${hasDetails ? `<i class="fas fa-chevron-down arr-expand-icon${detailsClass}"></i>` : ""}
        </div>
      </div>
      ${hasDetails ? `<div class="arr-roll-details${detailsClass}">${rollDetailsHtml}${notesHtml}</div>` : ""}
    </li>`;
  }

  // ----------------------------------------------------------
  // Create a result <li> element for a roll (DOM node for live render)
  // ----------------------------------------------------------

  static async _createResultElement(entry, dc, showResults, hideTotalFromPlayers = false, resultTable = null) {
    const li = document.createElement("li");
    li.classList.add("arr-result-entry", "flexrow");
    li.dataset.tokenId = entry.tokenId;

    const canSeeResults = showResults || game.user.isGM;
    const passed = (dc != null && canSeeResults) ? entry.total >= dc : null;
    const passClass = passed === true ? "arr-pass" : passed === false ? "arr-fail" : "";

    // In publicblind mode, players don't see the total number
    const showTotal = !hideTotalFromPlayers || game.user.isGM;

    // With a result table the row shows the mapped label instead of the number
    // (see _buildResultHTML, which does the same for the stored card content).
    const tableLabel = RollRequestChat._resolveEntryLabel(entry, resultTable);
    const shownTotal = tableLabel ?? entry.total;
    const labelClass = tableLabel ? " arr-total-label" : "";

    let notesHtml = "";
    if (entry.notes?.length) {
      notesHtml = `<div class="arr-notes">${entry.notes.map(n =>
        `<span class="arr-note-tag">${n}</span>`
      ).join("")}</div>`;
    }

    // Render the roll details
    let rollDetailsHtml = "";
    if (entry.rollData) {
      try {
        const roll = Roll.fromData(entry.rollData);
        rollDetailsHtml = await roll.render();
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not render roll details:`, err);
      }
    }

    const hasDetails = rollDetailsHtml || notesHtml;
    const showRollDetails = showTotal; // roll details are as sensitive as the total
    li.innerHTML = `
      <div class="arr-result-row flexrow">
        <div class="arr-result-actor flexrow">
          <img class="arr-actor-img" src="${entry.actorImg}" alt="${entry.actorName}" />
          <span class="arr-actor-name">${entry.actorName}</span>
        </div>
        <div class="arr-result-total ${passClass}">
          ${showTotal ? `<span class="arr-total-value${labelClass}">${shownTotal}</span>` : '<span class="arr-total-value">?</span>'}
          ${passed === true ? '<i class="fas fa-check arr-pass-icon"></i>' : ""}
          ${passed === false ? '<i class="fas fa-times arr-fail-icon"></i>' : ""}
          ${hasDetails && showRollDetails ? '<i class="fas fa-chevron-down arr-expand-icon"></i>' : ""}
        </div>
      </div>
      ${hasDetails && showRollDetails ? `<div class="arr-roll-details">${rollDetailsHtml}${notesHtml}</div>` : ""}
    `;
    return li;
  }

  // ----------------------------------------------------------
  // Create an Aid Another result <li> element (DOM node for live render)
  // ----------------------------------------------------------

  static async _createAidResultElement(entry, hideTotalFromPlayers = false) {
    const li = document.createElement("li");
    li.classList.add("arr-result-entry", "arr-aid-entry", "flexrow");
    if (entry.consumed) li.classList.add("arr-aid-consumed");
    li.dataset.tokenId = entry.tokenId;

    const showDetails = !hideTotalFromPlayers || game.user.isGM;
    const successClass = showDetails ? (entry.aidSuccess ? "arr-pass" : "arr-fail") : "";
    const bonusText = entry.aidSuccess ? `(+${entry.aidBonus})` : game.i18n.localize("RR.Aid.Failed");

    let notesHtml = "";
    if (entry.notes?.length) {
      notesHtml = `<div class="arr-notes">${entry.notes.map(n =>
        `<span class="arr-note-tag">${n}</span>`
      ).join("")}</div>`;
    }

    // Render the roll details
    let rollDetailsHtml = "";
    if (entry.rollData) {
      try {
        const roll = Roll.fromData(entry.rollData);
        rollDetailsHtml = await roll.render();
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not render roll details:`, err);
      }
    }

    const hasDetails = rollDetailsHtml || notesHtml;
    li.innerHTML = `
      <div class="arr-result-row flexrow">
        <div class="arr-result-actor flexrow">
          <img class="arr-actor-img" src="${entry.actorImg}" alt="${entry.actorName}" />
          <span class="arr-actor-name">${entry.actorName}</span>
        </div>
        <div class="arr-result-total ${successClass}">
          ${showDetails ? `<span class="arr-total-value">${entry.total}</span>` : '<span class="arr-total-value">?</span>'}
          ${showDetails ? `<span class="arr-aid-bonus">${bonusText}</span>` : '<span class="arr-aid-bonus">(?)</span>'}
          ${hasDetails && showDetails ? '<i class="fas fa-chevron-down arr-expand-icon"></i>' : ""}
        </div>
      </div>
      ${hasDetails && showDetails ? `<div class="arr-roll-details">${rollDetailsHtml}${notesHtml}</div>` : ""}
    `;
    return li;
  }

  // ----------------------------------------------------------
  // Render existing results (on re-render / reload)
  // ----------------------------------------------------------

  static async _renderExistingResults(_message, card, flags) {
    const hideTotalFromPlayers = flags.rollMode === "publicblind";

    if (flags.mode === "multi") {
      const list = card.querySelector(".arr-results-list");
      if (list) {
        list.innerHTML = "";
        const rolledActors = flags.rolledActors || {};
        for (const entry of Object.values(rolledActors)) {
          list.appendChild(await RollRequestChat._createResultElement(entry, flags.dc, flags.showResults, hideTotalFromPlayers, flags.resultTable));
        }
      }

      if (flags.includeAid) {
        const aidList = card.querySelector(".arr-aid-results");
        if (aidList) {
          aidList.innerHTML = "";
          const aidResults = flags.aidResults || {};
          for (const entry of Object.values(aidResults)) {
            aidList.appendChild(await RollRequestChat._createAidResultElement(entry, hideTotalFromPlayers));
          }
        }
        RollRequestChat._updateAidDisplay(card, flags, hideTotalFromPlayers, flags.aidTotal || 0);
      }

    } else if (flags.mode === "single") {
      // Aid results
      const aidList = card.querySelector(".arr-aid-results");
      if (aidList) {
        aidList.innerHTML = "";
        const aidResults = flags.aidResults || {};
        for (const entry of Object.values(aidResults)) {
          aidList.appendChild(await RollRequestChat._createAidResultElement(entry, hideTotalFromPlayers));
        }
      }

      // Primary result
      const primaryContainer = card.querySelector(".arr-primary-result");
      if (primaryContainer) {
        primaryContainer.innerHTML = "";
        const rolledActors = flags.rolledActors || {};
        for (const entry of Object.values(rolledActors)) {
          primaryContainer.appendChild(await RollRequestChat._createResultElement(entry, flags.dc, flags.showResults, hideTotalFromPlayers, flags.resultTable));
        }
      }

      // Update aid display
      RollRequestChat._updateAidDisplay(card, flags, hideTotalFromPlayers);

    } else if (flags.mode === "targeted") {
      const actorResults = flags.actorResults || {};
      const actorAidResults = flags.actorAidResults || {};

      for (const block of card.querySelectorAll(".arr-targeted-block")) {
        const actorId = block.dataset.actorId;

        // Inline primary result
        if (actorResults[actorId]) {
          await RollRequestChat._setInlineResult(block, actorResults[actorId], flags.dc, flags.showResults, hideTotalFromPlayers, flags.resultTable, !!(flags.selectFromTable && flags.allowRepick));
        }

        // Aid results
        const aidList = block.querySelector(".arr-aid-results");
        if (aidList) {
          aidList.innerHTML = "";
          const aidMap = actorAidResults[actorId] || {};
          for (const entry of Object.values(aidMap)) {
            aidList.appendChild(await RollRequestChat._createAidResultElement(entry, hideTotalFromPlayers));
          }
        }

        // Aid bonus display
        RollRequestChat._updateTargetedAidDisplay(card, flags, actorId, hideTotalFromPlayers);
      }
    }

    // Hide roll buttons for actors that already rolled
    RollRequestChat._updateButtonVisibility(card, flags);
  }

  // ----------------------------------------------------------
  // Bind click-to-expand on result rows
  // ----------------------------------------------------------

  static _bindExpandToggle(card) {
    card.querySelectorAll(".arr-result-row").forEach(row => {
      row.style.cursor = "pointer";
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const entry = row.closest(".arr-result-entry");
        if (!entry) return;
        entry.classList.toggle("arr-expanded");
        // Rotate the chevron icon
        const icon = row.querySelector(".arr-expand-icon");
        if (icon) icon.classList.toggle("fa-chevron-up", entry.classList.contains("arr-expanded"));
        if (icon) icon.classList.toggle("fa-chevron-down", !entry.classList.contains("arr-expanded"));
      });
    });

    // Targeted card: click the actor row to expand roll details.
    // Save-request cards handle their own combined dropdown in _bindTargetedExpand.
    if (card.classList.contains("arr-save-request")) return;
    card.querySelectorAll(".arr-targeted-actor-row").forEach(row => {
      row.addEventListener("click", (ev) => {
        const block = row.closest(".arr-targeted-block");
        if (!block) return;
        const details = block.querySelector(':scope > .arr-targeted-roll-details');
        if (!details) return;
        ev.preventDefault();
        ev.stopPropagation();
        const expanded = block.classList.toggle("arr-expanded");
        const icon = row.querySelector(".arr-expand-icon");
        if (icon) {
          icon.classList.toggle("fa-chevron-up", expanded);
          icon.classList.toggle("fa-chevron-down", !expanded);
        }
      });
    });
  }

  // ----------------------------------------------------------
  // Update the aid bonus display on a single-check card
  // ----------------------------------------------------------

  static _updateAidDisplay(card, flags, hideTotalFromPlayers = false, aidTotalOverride = null) {
    const aidTotal = aidTotalOverride !== null ? aidTotalOverride : RollRequestChat._calculateAidTotal(flags);
    const bonusDisplay = card.querySelector(".arr-aid-bonus-display");
    const bonusValue = card.querySelector(".arr-aid-bonus-value");
    if (bonusDisplay) {
      if (aidTotal > 0 && (!hideTotalFromPlayers || game.user.isGM)) {
        bonusDisplay.style.display = "inline";
        if (bonusValue) bonusValue.textContent = `+${aidTotal}`;
      } else {
        bonusDisplay.style.display = "none";
      }
    }
  }

  // ----------------------------------------------------------
  // Set inline result on a targeted actor's header row (live DOM path)
  // ----------------------------------------------------------

  static async _setInlineResult(block, result, dc, showResults, hideTotalFromPlayers = false, resultTable = null, keepRollButton = false) {
    const inlineDiv = block.querySelector('.arr-inline-result');
    const rollBtn = block.querySelector('.arr-roll-btn[data-action="rollTargeted"]');
    if (!inlineDiv) return;

    const canSeeResults = showResults || game.user.isGM;
    const passed = (dc != null && canSeeResults) ? result.total >= dc : null;
    const passClass = passed === true ? "arr-pass" : passed === false ? "arr-fail" : "";
    const showTotal = !hideTotalFromPlayers || game.user.isGM;

    // With a result table the row shows the mapped label instead of the number
    const tableLabel = RollRequestChat._resolveEntryLabel(result, resultTable);
    const shownTotal = tableLabel ?? result.total;
    const labelClass = tableLabel ? " arr-total-label" : "";

    let passFailHtml = "";
    if (passed === true) passFailHtml = '<i class="fas fa-check arr-pass-icon"></i>';
    else if (passed === false) passFailHtml = '<i class="fas fa-times arr-fail-icon"></i>';

    // Render roll details
    let rollDetailsHtml = "";
    if (result.rollData && showTotal) {
      try {
        const roll = Roll.fromData(result.rollData);
        rollDetailsHtml = await roll.render();
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not render targeted roll details:`, err);
      }
    }
    let notesHtml = "";
    if (result.notes?.length && showTotal) {
      notesHtml = `<div class="arr-notes">${result.notes.map(n => `<span class="arr-note-tag">${n}</span>`).join("")}</div>`;
    }
    const hasDetails = !!(rollDetailsHtml || notesHtml);
    const chevronHtml = hasDetails ? '<i class="fas fa-chevron-down arr-expand-icon"></i>' : "";

    inlineDiv.className = `arr-inline-result arr-result-total ${passClass}`;
    inlineDiv.innerHTML = `${showTotal ? `<span class="arr-total-value${labelClass}">${shownTotal}</span>` : '<span class="arr-total-value">?</span>'}${passFailHtml}${chevronHtml}`;
    inlineDiv.removeAttribute("style");

    // Inject roll details block after the actor row
    if (hasDetails) {
      let detailsDiv = block.querySelector(':scope > .arr-targeted-roll-details');
      if (!detailsDiv) {
        detailsDiv = document.createElement('div');
        detailsDiv.className = 'arr-roll-details arr-targeted-roll-details';
        const actorRow = block.querySelector('.arr-targeted-actor-row');
        if (actorRow) actorRow.insertAdjacentElement('afterend', detailsDiv);
        else block.appendChild(detailsDiv);
      }
      detailsDiv.innerHTML = `${rollDetailsHtml}${notesHtml}`;
      const actorRow = block.querySelector('.arr-targeted-actor-row');
      if (actorRow) actorRow.style.cursor = 'pointer';
    }

    // Kept visible where the pick can still be changed.
    if (rollBtn && !keepRollButton) rollBtn.style.display = "none";
  }

  // ----------------------------------------------------------
  // Update the aid bonus display for one targeted actor's block
  // ----------------------------------------------------------

  static _updateTargetedAidDisplay(card, flags, targetActorId, hideTotalFromPlayers = false) {
    const block = card.querySelector(`.arr-targeted-block[data-actor-id="${targetActorId}"]`);
    if (!block) return;
    const aidTotal = RollRequestChat._calculateAidTotalForActor(flags, targetActorId);
    const bonusDisplay = block.querySelector(".arr-aid-bonus-display");
    const bonusValue = block.querySelector(".arr-aid-bonus-value");
    if (bonusDisplay) {
      if (aidTotal > 0 && (!hideTotalFromPlayers || game.user.isGM)) {
        bonusDisplay.style.display = "inline";
        if (bonusValue) bonusValue.textContent = `+${aidTotal}`;
      } else {
        bonusDisplay.style.display = "none";
      }
    }
  }

  // ----------------------------------------------------------
  // Show/hide roll buttons based on who has already rolled
  // ----------------------------------------------------------

  static _updateButtonVisibility(card, flags) {
    // A re-pickable selection card keeps its button live: the control that
    // opens the dropdown has to survive making a choice with it.
    if (flags.selectFromTable && flags.allowRepick) return;

    if (flags.mode === "single") {
      const rolledActors = flags.rolledActors || {};
      if (Object.keys(rolledActors).length > 0) {
        const primaryBtn = card.querySelector('.arr-roll-btn[data-action="rollPrimary"]');
        if (primaryBtn) primaryBtn.style.display = "none";
        const aidBtn = card.querySelector('.arr-roll-btn[data-action="rollAid"]');
        if (aidBtn) aidBtn.style.display = "none";
      }

    } else if (flags.mode === "targeted") {
      const actorResults = flags.actorResults || {};
      const usedActorIds = flags.usedActorIds || [];
      const userActorId = game.user.character?.id;

      // Grey out roll button for any targeted actor who has used their action (rolled OR aided)
      for (const btn of card.querySelectorAll('.arr-roll-btn[data-action="rollTargeted"]')) {
        const actorId = btn.dataset.actorId;
        if (usedActorIds.includes(actorId)) btn.classList.add("arr-roll-btn-disabled");
      }

      // Grey out aid button for sections where the primary roll is already completed
      for (const btn of card.querySelectorAll('.arr-roll-btn[data-action="rollTargetedAid"]')) {
        const targetActorId = btn.dataset.targetActorId;
        if (actorResults[targetActorId]) btn.classList.add("arr-roll-btn-disabled");
      }

      // Also grey out all aid buttons for the current user if they've already used their action
      if (userActorId && usedActorIds.includes(userActorId)) {
        card.querySelectorAll('.arr-roll-btn[data-action="rollTargetedAid"]').forEach(btn => {
          btn.classList.add("arr-roll-btn-disabled");
        });
      }
    }
  }

  // ----------------------------------------------------------
  // Pending result management for awaitResult API
  // ----------------------------------------------------------

  /**
   * Register a pending result promise for a chat message.
   * Resolves when the primary roll is completed on that card.
   * @param {string} messageId
   * @returns {Promise<object|null>} Resolves with result data, or null if cancelled.
   */
  static registerPendingResult(messageId) {
    return new Promise((resolve) => {
      RollRequestChat._pendingResults.set(messageId, { resolve });
    });
  }

  /**
   * Cancel a pending result (e.g. when the message is deleted).
   * Resolves the promise with null.
   * @param {string} messageId
   */
  static cancelPendingResult(messageId) {
    const pending = RollRequestChat._pendingResults.get(messageId);
    if (pending) {
      pending.resolve(null);
      RollRequestChat._pendingResults.delete(messageId);
    }
  }

  /**
   * Register a streaming result callback for a request, invoked on every roll
   * completed on it (see the onResult option of createRequest / embed).
   * @param {string} messageId
   * @param {(payload: object) => void} callback
   * @param {string|null} [slot] - Embed slot, or null for the whole card.
   */
  static registerResultCallback(messageId, callback, slot = null) {
    RollRequestChat._resultCallbacks.set(RollRequestChat._callbackKey(messageId, slot), callback);
  }

  /**
   * Cancel a streaming result callback (e.g. when the message is deleted).
   * When a `reason` is given, the callback receives one final terminal event
   * before being unregistered, so consumers can tear down. The terminal payload
   * is full-shaped but empty (result: null, results/aidResults: []) so handlers
   * that iterate those collections without checking rollType don't blow up.
   * @param {string} messageId
   * @param {string|null} [reason]  Why the stream ended (e.g. "deleted"). Omit
   *   for a silent unregister.
   * @param {number|null} [dc]      The request's DC, carried through for parity
   *   with normal result payloads.
   * @param {string|null} [slot]    Embed slot, or null for the whole card.
   */
  static cancelResultCallback(messageId, reason = null, dc = null, slot = null) {
    const key = RollRequestChat._callbackKey(messageId, slot);
    const callback = RollRequestChat._resultCallbacks.get(key);
    RollRequestChat._resultCallbacks.delete(key);
    if (callback && reason) {
      try {
        callback({
          messageId,
          slot,
          rollType: "cancelled",
          reason,
          result: null,
          results: [],
          aidResults: [],
          dc,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | onResult terminal callback threw:`, err);
      }
    }
  }

  /**
   * Cancel every stream on a message — its own request and each embedded one —
   * each with its own DC. Used when the message goes away entirely.
   *
   * @param {ChatMessage|string} message - The message, or its ID (in which case
   *   it is looked up; a deleted message must be passed as the document).
   * @param {string|null} [reason]
   */
  static cancelMessageCallbacks(message, reason = null) {
    const doc = typeof message === "string" ? game.messages.get(message) : message;
    const id = typeof message === "string" ? message : message?.id;
    if (!id) return;
    const flags = doc?.flags?.[MODULE_ID] ?? {};
    RollRequestChat.cancelResultCallback(id, reason, flags.dc ?? null, null);
    for (const [slot, state] of Object.entries(flags.embeds ?? {})) {
      RollRequestChat.cancelResultCallback(id, reason, state?.dc ?? null, slot);
    }
  }

  // ----------------------------------------------------------
  // Select canvas tokens by save result (save requests only)
  // ----------------------------------------------------------

  static _selectSaveTokens(flags, which) {
    if (!canvas?.tokens) return;
    const actorResults = flags.actorResults || {};
    const dc = flags.dc;
    canvas.tokens.releaseAll();
    for (const target of (flags.targetedActors || [])) {
      const tokenDoc = fromUuidSync(target.tokenUUID);
      if (!tokenDoc?.object) continue;
      if (which === "all") {
        tokenDoc.object.control({ releaseOthers: false });
        continue;
      }
      const result = actorResults[target.id];
      if (!result) continue;
      const passed = dc != null ? result.total >= dc : null;
      if (which === "passed" && passed === true) tokenDoc.object.control({ releaseOthers: false });
      else if (which === "failed" && passed === false) tokenDoc.object.control({ releaseOthers: false });
    }
  }

  // ----------------------------------------------------------
  // Bulk-roll saves for all unrolled targets (GM only, no dialog)
  // ----------------------------------------------------------

  static async _bulkRollSave(message, which, slot = null) {
    if (!game.user.isGM) return;
    const flags = RollRequestChat._readState(message, slot);
    if (!flags?.isSaveRequest) return;

    for (const target of (flags.targetedActors || [])) {
      const currentFlags = RollRequestChat._readState(message, slot);
      if (!currentFlags) break;
      if ((currentFlags.usedActorIds || []).includes(target.id)) continue;

      const tokenDoc = fromUuidSync(target.tokenUUID);
      const actor = tokenDoc?.actor;
      if (!actor) continue;

      if (which === "npcs") {
        if (actor.type === "character") continue;
        const playerOwned = game.users.some(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
        if (playerOwned) continue;
      }

      let rollResult;
      try {
        rollResult = await RollRequestChat._performRoll(actor, flags.request, flags.dc, { skipDialog: true });
      } catch (err) {
        console.error(`${MODULE_ID} | Bulk save roll error for ${actor.name}:`, err);
        continue;
      }
      if (!rollResult) continue;

      const notes = await RollRequestChat._getEffectNotes(actor, flags.request);
      const resultEntry = {
        tokenId: tokenDoc.id,
        actorId: actor.id,
        resultKey: target.id,
        actorName: actor.name,
        actorImg: actor.img,
        total: rollResult.total,
        formula: rollResult.formula,
        naturalRoll: rollResult.dice?.[0]?.results?.[0]?.result ?? null,
        rollData: rollResult.toJSON(),
        notes,
      };

      await RollRequestChat._updateMessage(message, "targeted", resultEntry, currentFlags, { targetActorId: target.id, slot });
    }
  }

  // ----------------------------------------------------------
  // Bulk roll for targeted blind-roll cards (non-save)
  // ----------------------------------------------------------

  static async _bulkRollTargeted(message, { slot = null } = {}) {
    if (!game.user.isGM) return;
    const initialFlags = RollRequestChat._readState(message, slot);
    if (!initialFlags?.targetedActors?.length) return;
    // Nothing to roll on a selection card: each result is a choice a person
    // makes, so there is no sensible value to fill in on their behalf.
    if (initialFlags.selectFromTable) {
      console.warn(`${MODULE_ID} | Bulk roll skipped: card ${message.id} is a selection request.`);
      return;
    }

    for (const target of initialFlags.targetedActors) {
      const currentFlags = RollRequestChat._readState(message, slot);
      if (!currentFlags) break;
      if ((currentFlags.usedActorIds || []).includes(target.id)) continue;

      // Resolve actor: use tokenUUID when present (handles unlinked tokens).
      let actor, tokenId;
      if (target.tokenUUID) {
        const tokenDoc = fromUuidSync(target.tokenUUID);
        actor = tokenDoc?.actor;
        tokenId = tokenDoc?.id ?? null;
      } else {
        actor = game.actors.get(target.id);
        tokenId = actor?.getActiveTokens?.()?.[0]?.id ?? null;
      }
      if (!actor) continue;

      let rollResult;
      try {
        rollResult = await RollRequestChat._performRoll(actor, initialFlags.request, initialFlags.dc, { skipDialog: true });
      } catch (err) {
        console.error(`${MODULE_ID} | Bulk roll error for ${actor.name}:`, err);
        continue;
      }
      if (!rollResult) continue;

      const notes = await RollRequestChat._getEffectNotes(actor, initialFlags.request);
      const resultEntry = {
        tokenId,
        actorId: actor.id,
        resultKey: target.id,
        actorName: actor.name,
        actorImg: actor.img,
        total: rollResult.total,
        formula: rollResult.formula,
        naturalRoll: rollResult.dice?.[0]?.results?.[0]?.result ?? null,
        rollData: rollResult.toJSON(),
        notes,
      };

      await RollRequestChat._updateMessage(message, "targeted", resultEntry, currentFlags, { targetActorId: target.id, slot });
    }
  }
}
