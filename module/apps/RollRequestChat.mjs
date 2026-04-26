// ============================================================
// Pathfinder 1e Roll Requests — Chat Card Logic
// Handles creating the card, binding buttons, processing rolls,
// and updating the message with results.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

export class RollRequestChat {

  // Pending result promises for awaitResult API (messageId → { resolve })
  static _pendingResults = new Map();

  // ----------------------------------------------------------
  // Create and post the chat card
  // ----------------------------------------------------------

  static async createChatCard(requestData) {
    let template;
    if (requestData.mode === "single") {
      template = `modules/${MODULE_ID}/templates/chat-card-single.html`;
    } else if (requestData.mode === "targeted") {
      template = `modules/${MODULE_ID}/templates/chat-card-targeted.html`;
    } else {
      template = `modules/${MODULE_ID}/templates/chat-card-multi.html`;
    }

    // Build the display name for the request
    const requestName = requestData.request.name;
    const name = requestData.flavor || requestName;

    // Roll mode display name (shown in GM-only footer)
    const modeName = RollRequestChat._getModeName(requestData.rollMode, requestData.showResults);

    const templateData = {
      name,
      requestName,
      dc: requestData.dc,
      showDC: requestData.showDC,
      showResults: requestData.showResults,
      flavor: requestData.flavor,
      includeAid: requestData.includeAid,
      modeName,
      targetedActors: requestData.targetedActors ?? [],
    };

    const html = await renderTemplate(template, templateData);

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

    return ChatMessage.create(chatData);
  }

  // ----------------------------------------------------------
  // Hook: renderChatMessage — bind interactivity to the card
  // ----------------------------------------------------------

  static async onRenderChatMessage(message, html, _data) {
    const card = html.querySelector?.(".arr-card") ?? html[0]?.querySelector?.(".arr-card");
    if (!card) return;

    // Remove GM-only elements for non-GMs; remove player-only elements for GMs
    if (game.user.isGM) {
      card.querySelectorAll(".arr-player-only").forEach(el => el.remove());
    } else {
      card.querySelectorAll(".gm-only").forEach(el => el.remove());
    }

    const flags = message.flags?.[MODULE_ID];
    if (!flags || !flags.request) return;

    const mode = flags.mode;

    if (mode === "multi") {
      RollRequestChat._bindMultiCheck(message, card, flags);
    } else if (mode === "single") {
      RollRequestChat._bindSingleCheck(message, card, flags);
    } else if (mode === "targeted") {
      RollRequestChat._bindTargetedCheck(message, card, flags);
    }

    // Re-render results from flag data (await so DOM is populated before cleanup/binding)
    await RollRequestChat._renderExistingResults(message, card, flags);

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

  // ----------------------------------------------------------
  // Multi-Check: bind the roll button
  // ----------------------------------------------------------

  static _bindMultiCheck(message, card, flags) {
    const rollBtn = card.querySelector('.arr-roll-btn[data-action="roll"]');
    if (!rollBtn) return;

    rollBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await RollRequestChat._handleRoll(message, flags, "multi");
    });
  }

  // ----------------------------------------------------------
  // Single-Check: bind both buttons
  // ----------------------------------------------------------

  static _bindSingleCheck(message, card, flags) {
    // Aid Another button
    const aidBtn = card.querySelector('.arr-roll-btn[data-action="rollAid"]');
    if (aidBtn) {
      aidBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await RollRequestChat._handleRoll(message, flags, "aid");
      });
    }

    // Primary Roll button
    const primaryBtn = card.querySelector('.arr-roll-btn[data-action="rollPrimary"]');
    if (primaryBtn) {
      primaryBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await RollRequestChat._handleRoll(message, flags, "primary");
      });
    }

    // Update aid bonus display
    RollRequestChat._updateAidDisplay(card, flags);
  }

  // ----------------------------------------------------------
  // Targeted-Check: bind per-actor roll and aid buttons
  // ----------------------------------------------------------

  static _bindTargetedCheck(message, card, flags) {
    // Primary roll buttons — one per targeted actor
    card.querySelectorAll('.arr-roll-btn[data-action="rollTargeted"]').forEach(btn => {
      const targetActorId = btn.dataset.actorId;

      // Dim the button for users who don't own this actor
      if (!game.user.isGM && game.user.character?.id !== targetActorId) {
        btn.classList.add("arr-roll-btn-disabled");
      }

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await RollRequestChat._handleRoll(message, flags, "targeted", { targetActorId });
      });
    });

    // Aid buttons — one per targeted actor's section, usable by anyone
    card.querySelectorAll('.arr-roll-btn[data-action="rollTargetedAid"]').forEach(btn => {
      const targetActorId = btn.dataset.targetActorId;
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await RollRequestChat._handleRoll(message, flags, "targetedAid", { targetActorId });
      });
    });

    // Initialise aid bonus displays
    for (const block of card.querySelectorAll(".arr-targeted-block")) {
      RollRequestChat._updateTargetedAidDisplay(card, flags, block.dataset.actorId);
    }
  }

  // ----------------------------------------------------------
  // Core Roll Handler
  // ----------------------------------------------------------

  static async _handleRoll(message, _flags, rollType, opts = {}) {
    const { targetActorId } = opts;

    // Re-read flags from the message to get the latest state
    const currentFlags = message.flags?.[MODULE_ID];
    if (!currentFlags || !currentFlags.request) {
      ui.notifications.error("Could not read roll request data from this message.");
      return;
    }

    const request = currentFlags.request;
    const dc = currentFlags.dc;

    // --- Acquire actor and tokenId based on roll type ---
    let actor, tokenId;
    if (rollType === "targeted") {
      // Actor is fixed — it's the specific targeted actor regardless of selection
      actor = game.actors.get(targetActorId);
      if (!actor) { ui.notifications.warn("Target actor not found."); return; }
      tokenId = actor.getActiveTokens?.()?.[0]?.id ?? null;
    } else {
      // All other roll types use the currently controlled token
      const token = canvas.tokens.controlled[0];
      if (!token) { ui.notifications.warn("Please select a token first."); return; }
      actor = token.actor;
      if (!actor) { ui.notifications.warn("Selected token has no actor."); return; }
      tokenId = token.id;
    }

    // --- Permission check: targeted primary rolls are actor-specific ---
    if (rollType === "targeted" && !game.user.isGM) {
      if (game.user.character?.id !== targetActorId) {
        ui.notifications.warn("You can only roll for your own character.");
        return;
      }
    }

    // --- Prevent self-aid in targeted sections ---
    if (rollType === "targetedAid" && actor.id === targetActorId) {
      ui.notifications.warn("You cannot aid your own roll.");
      return;
    }

    // --- Duplicate / one-action-per-actor checks ---
    if (rollType === "multi") {
      const rolledActors = currentFlags.rolledActors || {};
      if (rolledActors[tokenId]) {
        ui.notifications.warn(`${actor.name} has already rolled.`);
        return;
      }
    } else if (rollType === "aid") {
      const aidResults = currentFlags.aidResults || {};
      if (aidResults[tokenId]) {
        ui.notifications.warn(`${actor.name} has already provided aid.`);
        return;
      }
    } else if (rollType === "primary") {
      const rolledActors = currentFlags.rolledActors || {};
      if (Object.keys(rolledActors).length > 0) {
        ui.notifications.warn("The primary check has already been rolled.");
        return;
      }
    } else if (rollType === "targeted") {
      const usedActorIds = currentFlags.usedActorIds || [];
      if (usedActorIds.includes(actor.id)) {
        ui.notifications.warn(`${actor.name} has already used their action in this request.`);
        return;
      }
    } else if (rollType === "targetedAid") {
      const usedActorIds = currentFlags.usedActorIds || [];
      if (usedActorIds.includes(actor.id)) {
        ui.notifications.warn(`${actor.name} has already used their action in this request.`);
        return;
      }
    }

    // --- Validation: Trained-only check ---
    if (request.type === "skill") {
      const sklInfo = actor.getSkillInfo?.(request.key);
      if (sklInfo && sklInfo.rt && sklInfo.rank === 0) {
        ui.notifications.warn(
          `${actor.name} cannot roll ${request.name} — it requires training and they have no ranks.`
        );
        return;
      }
    }

    // --- Validation: Natural-20 feasibility check ---
    if (dc != null && request.type !== "dice") {
      const maxPossible = RollRequestChat._getMaxRoll(actor, request);
      if (maxPossible !== null && maxPossible < dc) {
        const msg = (rollType === "aid" || rollType === "targetedAid")
          ? `${actor.name}: Success not possible, unable to aid another.`
          : `${actor.name} cannot succeed on this check, even with a natural 20.`;
        ui.notifications.warn(msg);
        return;
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
      } else {
        rollResult = await RollRequestChat._performRoll(actor, request, dc);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Roll error:`, err);
      ui.notifications.error("An error occurred while rolling.");
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
      actorName: actor.name,
      actorImg: actor.img,
      total: rollResult.total,
      formula: rollResult.formula,
      naturalRoll: rollResult.dice?.[0]?.results?.[0]?.result ?? null,
      rollData: rollResult.toJSON(),
      notes,
    };

    // For Aid rolls: calculate the bonus contributed
    if (rollType === "aid" || rollType === "targetedAid") {
      if (resultEntry.total >= 10) {
        const overAmount = resultEntry.total - 10;
        const extraBonus = Math.floor(overAmount / 5);
        resultEntry.aidBonus = 2 + extraBonus;
        resultEntry.aidSuccess = true;
      } else {
        resultEntry.aidBonus = 0;
        resultEntry.aidSuccess = false;
      }
    }

    // Send update via socket (if not GM) or update directly
    if (game.user.isGM) {
      await RollRequestChat._updateMessage(message, rollType, resultEntry, currentFlags, opts);
    } else {
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "rollResult",
        messageId: message.id,
        rollType,
        targetActorId: opts.targetActorId ?? null,
        resultEntry,
      });
    }
  }

  // ----------------------------------------------------------
  // Perform a silent roll (no chat message)
  // ----------------------------------------------------------

  static async _performRoll(actor, request, dc) {
    const opts = {
      skipDialog: false,
      chatMessage: false,
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
  // Get display name for a roll mode + results visibility combo
  // ----------------------------------------------------------

  static _getModeName(rollMode, showResults) {
    if (rollMode === "publicblind") {
      return showResults ? "Blind Roll" : "Blind Roll, Results Hidden";
    }
    const baseNames = {
      roll: "Public Roll",
      gmroll: "Private GM Roll",
      blindroll: "Blind GM Roll",
    };
    const base = baseNames[rollMode] || "Public Roll";
    if ((rollMode === "roll" || rollMode === "gmroll") && !showResults) {
      return `${base}, Results Hidden`;
    }
    return base;
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

  static async _updateMessage(message, rollType, resultEntry, flags, opts = {}) {
    const { targetActorId } = opts;
    const updateData = {};

    if (rollType === "multi") {
      const rolledActors = foundry.utils.deepClone(flags.rolledActors || {});
      rolledActors[resultEntry.tokenId] = resultEntry;
      updateData[`flags.${MODULE_ID}.rolledActors`] = rolledActors;

    } else if (rollType === "aid") {
      const aidResults = foundry.utils.deepClone(flags.aidResults || {});
      aidResults[resultEntry.tokenId] = resultEntry;
      updateData[`flags.${MODULE_ID}.aidResults`] = aidResults;
      updateData[`flags.${MODULE_ID}.aidTotal`] = RollRequestChat._calculateAidTotal({ aidResults });

    } else if (rollType === "primary") {
      const rolledActors = foundry.utils.deepClone(flags.rolledActors || {});
      rolledActors[resultEntry.tokenId] = resultEntry;
      updateData[`flags.${MODULE_ID}.rolledActors`] = rolledActors;

    } else if (rollType === "targeted") {
      const actorResults = foundry.utils.deepClone(flags.actorResults || {});
      actorResults[resultEntry.actorId] = resultEntry;
      updateData[`flags.${MODULE_ID}.actorResults`] = actorResults;

      const usedActorIds = [...(flags.usedActorIds || [])];
      if (!usedActorIds.includes(resultEntry.actorId)) usedActorIds.push(resultEntry.actorId);
      updateData[`flags.${MODULE_ID}.usedActorIds`] = usedActorIds;

    } else if (rollType === "targetedAid") {
      const actorAidResults = foundry.utils.deepClone(flags.actorAidResults || {});
      if (!actorAidResults[targetActorId]) actorAidResults[targetActorId] = {};
      actorAidResults[targetActorId][resultEntry.actorId] = resultEntry;
      updateData[`flags.${MODULE_ID}.actorAidResults`] = actorAidResults;

      const usedActorIds = [...(flags.usedActorIds || [])];
      if (!usedActorIds.includes(resultEntry.actorId)) usedActorIds.push(resultEntry.actorId);
      updateData[`flags.${MODULE_ID}.usedActorIds`] = usedActorIds;
    }

    // Rebuild the card HTML content with results included
    const updatedFlags = foundry.utils.mergeObject(
      foundry.utils.deepClone(flags),
      Object.fromEntries(
        Object.entries(updateData)
          .map(([k, v]) => [k.replace(`flags.${MODULE_ID}.`, ""), v])
      )
    );
    const newContent = await RollRequestChat._rebuildCardContent(updatedFlags);

    await message.update({
      content: newContent,
      ...updateData,
    });

    // Fire hook for every roll result
    Hooks.callAll("pf1RollRequests.rollComplete", {
      messageId: message.id,
      rollType,
      result: resultEntry,
      flags: updatedFlags,
    });

    // Resolve pending promise for single-check primary rolls
    if (rollType === "primary" && updatedFlags.mode === "single") {
      const pending = RollRequestChat._pendingResults.get(message.id);
      if (pending) {
        const dc = updatedFlags.dc;
        const passed = dc != null ? resultEntry.total >= dc : null;
        pending.resolve({
          messageId: message.id,
          total: resultEntry.total,
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
      template = `modules/${MODULE_ID}/templates/chat-card-single.html`;
    } else if (flags.mode === "targeted") {
      template = `modules/${MODULE_ID}/templates/chat-card-targeted.html`;
    } else {
      template = `modules/${MODULE_ID}/templates/chat-card-multi.html`;
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

    return card.outerHTML;
  }

  // ----------------------------------------------------------
  // Inject multi-check results into the card DOM
  // ----------------------------------------------------------

  static async _injectMultiResults(card, flags) {
    const list = card.querySelector(".arr-results-list");
    if (!list) return;

    const rolledActors = flags.rolledActors || {};
    const dc = flags.dc;
    const showResults = flags.showResults;
    const hideTotalFromPlayers = flags.rollMode === "publicblind";

    for (const entry of Object.values(rolledActors)) {
      list.insertAdjacentHTML("beforeend", await RollRequestChat._buildResultHTML(entry, dc, showResults, hideTotalFromPlayers));
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
        primaryContainer.insertAdjacentHTML("beforeend", await RollRequestChat._buildResultHTML(entry, dc, showResults, hideTotalFromPlayers));
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
          const totalHtml = hideTotalFromPlayers
            ? `<span class="arr-total-value gm-only">${result.total}</span><span class="arr-total-value arr-player-only">?</span>`
            : `<span class="arr-total-value">${result.total}</span>`;
          inlineDiv.className = `arr-inline-result arr-result-total ${passClass}`;
          inlineDiv.innerHTML = `${totalHtml}${passFailHtml}`;
          inlineDiv.removeAttribute("style");
        }
        if (rollBtn) rollBtn.style.display = "none";
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

  static async _buildResultHTML(entry, dc, showResults, hideTotalFromPlayers = false) {
    const passed = dc != null ? entry.total >= dc : null;

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
    const totalHtml = hideTotalFromPlayers
      ? `<span class="arr-total-value gm-only">${entry.total}</span><span class="arr-total-value arr-player-only">?</span>`
      : `<span class="arr-total-value">${entry.total}</span>`;

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
    const bonusText = entry.aidSuccess ? `(+${entry.aidBonus})` : "(Failed)";

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
    return `<li class="arr-result-entry arr-aid-entry flexrow" data-token-id="${entry.tokenId}">
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

  static async _createResultElement(entry, dc, showResults, hideTotalFromPlayers = false) {
    const li = document.createElement("li");
    li.classList.add("arr-result-entry", "flexrow");
    li.dataset.tokenId = entry.tokenId;

    const canSeeResults = showResults || game.user.isGM;
    const passed = (dc != null && canSeeResults) ? entry.total >= dc : null;
    const passClass = passed === true ? "arr-pass" : passed === false ? "arr-fail" : "";

    // In publicblind mode, players don't see the total number
    const showTotal = !hideTotalFromPlayers || game.user.isGM;

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
          ${showTotal ? `<span class="arr-total-value">${entry.total}</span>` : '<span class="arr-total-value">?</span>'}
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
    li.dataset.tokenId = entry.tokenId;

    const showDetails = !hideTotalFromPlayers || game.user.isGM;
    const successClass = showDetails ? (entry.aidSuccess ? "arr-pass" : "arr-fail") : "";
    const bonusText = entry.aidSuccess ? `(+${entry.aidBonus})` : "(Failed)";

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
          list.appendChild(await RollRequestChat._createResultElement(entry, flags.dc, flags.showResults, hideTotalFromPlayers));
        }
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
          primaryContainer.appendChild(await RollRequestChat._createResultElement(entry, flags.dc, flags.showResults, hideTotalFromPlayers));
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
          RollRequestChat._setInlineResult(block, actorResults[actorId], flags.dc, flags.showResults, hideTotalFromPlayers);
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
  }

  // ----------------------------------------------------------
  // Update the aid bonus display on a single-check card
  // ----------------------------------------------------------

  static _updateAidDisplay(card, flags, hideTotalFromPlayers = false) {
    const aidTotal = RollRequestChat._calculateAidTotal(flags);
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

  static _setInlineResult(block, result, dc, showResults, hideTotalFromPlayers = false) {
    const inlineDiv = block.querySelector('.arr-inline-result');
    const rollBtn = block.querySelector('.arr-roll-btn[data-action="rollTargeted"]');
    if (!inlineDiv) return;

    const canSeeResults = showResults || game.user.isGM;
    const passed = (dc != null && canSeeResults) ? result.total >= dc : null;
    const passClass = passed === true ? "arr-pass" : passed === false ? "arr-fail" : "";
    const showTotal = !hideTotalFromPlayers || game.user.isGM;

    let passFailHtml = "";
    if (passed === true) passFailHtml = '<i class="fas fa-check arr-pass-icon"></i>';
    else if (passed === false) passFailHtml = '<i class="fas fa-times arr-fail-icon"></i>';

    inlineDiv.className = `arr-inline-result arr-result-total ${passClass}`;
    inlineDiv.innerHTML = `${showTotal ? `<span class="arr-total-value">${result.total}</span>` : '<span class="arr-total-value">?</span>'}${passFailHtml}`;
    inlineDiv.removeAttribute("style");

    if (rollBtn) rollBtn.style.display = "none";
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
}
