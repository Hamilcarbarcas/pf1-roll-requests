// ============================================================
// Pathfinder 1e Roll Requests — Apply Roll
// ============================================================
//
// Takes a roll that already happened in chat and records it on a request card
// as though it had been rolled there. GM-only: a player cannot feed an outside
// roll into a request.
//
// Two entry points, one commit path:
//   * the card's Apply Roll button, which opens a picker of eligible rolls;
//   * a context-menu entry on the roll itself, which finds the requests it fits.
//
// Nothing here rolls dice. The source message's Roll is lifted whole into the
// result entry, so the card shows the same total, formula and breakdown the
// original card did.

import { RollRequestChat } from "./RollRequestChat.mjs";

const MODULE_ID = "pf1-roll-requests";

/** Newest-first scan depth through the chat log when collecting candidates. */
const SCAN_LIMIT = 500;

export class ApplyRoll {

  // ----------------------------------------------------------
  // What a request can accept
  // ----------------------------------------------------------

  /**
   * Whether a request can take an applied roll at all.
   *
   * Dice and selection requests are excluded: a selection has no dice to lift,
   * and a raw-formula request has no check type to match against, which would
   * make any d20 in the log a candidate for any dice card. Matching is strict
   * by design — an unrelated `/r 1d20` must never be pullable into a check.
   *
   * @param {object} flags - A request's flag state.
   * @returns {boolean}
   */
  static isApplicable(flags) {
    if (!flags?.request || flags.locked) return false;
    if (flags.selectFromTable) return false;
    return ["skill", "save", "ability"].includes(flags.request.type);
  }

  /**
   * The check a request expects from one particular roller. A card's rows
   * normally all share `flags.request`; a row carrying a `check` of its own
   * (an opposed card's two sides) is matched against that instead, so the
   * defender's Perception roll is not measured against the attacker's Stealth.
   *
   * @param {object} flags - A request's flag state.
   * @param {object|null} route - The route this roller would fill.
   * @returns {{type: string, key: string, name: string}}
   */
  static wantFor(flags, route) {
    const entry = route?.targetActorId
      ? (flags.targetedActors ?? []).find(t => t.id === route.targetActorId)
      : null;
    return entry?.check ?? flags.request;
  }

  /**
   * Every request living on a message — the card's own, plus any embedded ones.
   *
   * @param {ChatMessage} message
   * @returns {Array<{message: ChatMessage, slot: string|null, flags: object}>}
   */
  static requestsOn(message) {
    const out = [];
    const own = RollRequestChat._readState(message, null);
    if (own?.request) out.push({ message, slot: null, flags: own });
    for (const slot of Object.keys(own?.embeds ?? {})) {
      const state = RollRequestChat._readState(message, slot);
      if (state?.request) out.push({ message, slot, flags: state });
    }
    return out;
  }

  // ----------------------------------------------------------
  // Reading a source roll
  // ----------------------------------------------------------

  /**
   * The check a PF1 roll message represents, in the request's own vocabulary.
   * PF1 stamps this on every check it posts (`system.subject`), which is what
   * makes strict type matching possible without parsing formulas.
   *
   * @param {ChatMessage} msg
   * @returns {{type: string, key: string}|null}
   */
  static subjectOf(msg) {
    const subject = msg?.system?.subject;
    if (!subject) return null;
    if (subject.skill) return { type: "skill", key: subject.skill };
    if (subject.save) return { type: "save", key: subject.save };
    if (subject.ability) return { type: "ability", key: subject.ability };
    return null;
  }

  /**
   * Who made a roll. The token is preferred where the speaker names one, so an
   * unlinked duplicate resolves to its own actor rather than the prototype's.
   *
   * @param {ChatMessage} msg
   * @returns {{actor: Actor, tokenDoc: TokenDocument|null}|null}
   */
  static speakerOf(msg) {
    const speaker = msg?.speaker;
    if (!speaker) return null;
    const scene = speaker.scene ? game.scenes.get(speaker.scene) : null;
    const tokenDoc = (speaker.token && scene) ? scene.tokens.get(speaker.token) : null;
    const actor = tokenDoc?.actor ?? (speaker.actor ? game.actors.get(speaker.actor) : null);
    if (!actor) return null;
    return { actor, tokenDoc: tokenDoc ?? null };
  }

  /** The Roll to lift off a source message, or null when it carries none. */
  static rollOf(msg) {
    const roll = msg?.rolls?.[0];
    if (!roll) return null;
    if (roll instanceof Roll) return roll;
    try {
      return typeof roll === "string" ? Roll.fromJSON(roll) : Roll.fromData(roll);
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------
  // Routing: which slot on a request a given roller fills
  // ----------------------------------------------------------

  /**
   * Where a roll by this actor would land on a request.
   *
   * The roller decides the destination, which is why Apply Roll needs only one
   * button per card rather than one per row: a targeted card routes to the row
   * whose token matches, and a rosterless single/multi card routes to the
   * primary or the roller's own slot.
   *
   * @param {object} flags - The request's flag state.
   * @param {{actor: Actor, tokenDoc: TokenDocument|null}} who
   * @returns {object|null} Route descriptor, or null when this actor has no slot.
   */
  static routeFor(flags, who) {
    const { actor, tokenDoc } = who;

    if (flags.mode === "targeted") {
      const entry = (flags.targetedActors ?? []).find(t => t.tokenUUID
        ? t.tokenUUID === tokenDoc?.uuid
        : t.id === actor.id);
      if (!entry) return null;
      return {
        rollType: "targeted",
        targetActorId: entry.id,
        resultKey: entry.id,
        tokenId: tokenDoc?.id ?? actor.getActiveTokens?.()?.[0]?.id ?? actor.id,
        occupied: (flags.usedActorIds ?? []).includes(entry.id),
        aidRollType: null,
        label: entry.name ?? actor.name,
      };
    }

    // Single and multi cards have no roster — anyone who can roll them is a
    // candidate, and the duplicate guards below are the only gate.
    const tokenId = tokenDoc?.id ?? actor.getActiveTokens?.()?.[0]?.id ?? actor.id;

    if (flags.mode === "single") {
      return {
        rollType: "primary",
        targetActorId: null,
        resultKey: actor.id,
        tokenId,
        occupied: Object.keys(flags.rolledActors ?? {}).length > 0,
        aidRollType: flags.includeAid ? "aid" : null,
        aidOccupied: !!(flags.aidResults ?? {})[tokenId],
        label: actor.name,
      };
    }

    if (flags.mode === "multi") {
      // One action per token on a multi card, spent by rolling *or* aiding
      // (_isRollSlotFilled treats the two as the same slot). So both routes see
      // the same occupancy, and replacing either clears the other.
      const spent = !!(flags.rolledActors ?? {})[tokenId] || !!(flags.aidResults ?? {})[tokenId];
      return {
        rollType: "multi",
        targetActorId: null,
        resultKey: actor.id,
        tokenId,
        occupied: spent,
        aidRollType: flags.includeAid ? "multiAid" : null,
        aidOccupied: spent,
        label: actor.name,
      };
    }

    return null;
  }

  // ----------------------------------------------------------
  // Candidate collection
  // ----------------------------------------------------------

  /**
   * Eligible source rolls for a request, best first.
   *
   * Scanning the message collection is cheap — these are object reads, not DOM
   * — so the log's size is not a concern here; only the rendered list is capped.
   *
   * @param {ChatMessage} message
   * @param {string|null} slot
   * @returns {Array<object>} Candidate descriptors.
   */
  static candidatesFor(message, slot = null) {
    const flags = RollRequestChat._readState(message, slot);
    if (!ApplyRoll.isApplicable(flags)) return [];

    const out = [];
    const all = game.messages.contents;
    const start = Math.max(0, all.length - SCAN_LIMIT);

    for (let i = all.length - 1; i >= start; i--) {
      const msg = all[i];
      if (msg.id === message.id) continue;

      const subject = ApplyRoll.subjectOf(msg);
      if (!subject) continue;

      const roll = ApplyRoll.rollOf(msg);
      if (!roll) continue;

      const who = ApplyRoll.speakerOf(msg);
      if (!who) continue;

      // Routed before the check is matched, because which check the card wants
      // can depend on which row this roller lands in.
      const route = ApplyRoll.routeFor(flags, who);
      if (!route) continue;

      const want = ApplyRoll.wantFor(flags, route);
      if (subject.type !== want.type || subject.key !== want.key) continue;

      out.push({
        message: msg,
        roll,
        actor: who.actor,
        tokenDoc: who.tokenDoc,
        route,
        playerOwned: ApplyRoll._isPlayerOwned(who.actor),
        appliedAlready: ApplyRoll._appliedRecord(msg).length > 0,
      });
    }

    // Player-owned rolls first — on a rosterless card those are nearly always
    // the ones being pulled in — then newest within each group (already the
    // scan order).
    out.sort((a, b) => Number(b.playerOwned) - Number(a.playerOwned));
    return out;
  }

  /**
   * Open requests a given roll could be applied to, newest card first.
   *
   * @param {ChatMessage} sourceMessage
   * @returns {Array<object>}
   */
  static requestsFor(sourceMessage) {
    const subject = ApplyRoll.subjectOf(sourceMessage);
    if (!subject) return [];
    if (!ApplyRoll.rollOf(sourceMessage)) return [];
    const who = ApplyRoll.speakerOf(sourceMessage);
    if (!who) return [];

    const out = [];
    const all = game.messages.contents;
    const start = Math.max(0, all.length - SCAN_LIMIT);

    for (let i = all.length - 1; i >= start; i--) {
      const msg = all[i];
      if (msg.id === sourceMessage.id) continue;
      for (const req of ApplyRoll.requestsOn(msg)) {
        if (!ApplyRoll.isApplicable(req.flags)) continue;
        const route = ApplyRoll.routeFor(req.flags, who);
        if (!route) continue;
        const want = ApplyRoll.wantFor(req.flags, route);
        if (want.type !== subject.type || want.key !== subject.key) continue;
        out.push({ ...req, route, who });
      }
    }
    return out;
  }

  /** Whether any non-GM user owns this actor. */
  static _isPlayerOwned(actor) {
    return game.users.some(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
  }

  /** Where a source message has already been applied, as stored on that message. */
  static _appliedRecord(msg) {
    return msg?.flags?.[MODULE_ID]?.appliedTo ?? [];
  }

  // ----------------------------------------------------------
  // Commit
  // ----------------------------------------------------------

  /**
   * Record an existing roll on a request.
   *
   * Goes straight to _updateMessage rather than through _handleRoll: the dice
   * are already thrown, so the trained-only gate, the natural-20 feasibility
   * gate and the Dice So Nice animation all have nothing left to do. Being
   * GM-only, it also needs no socket hop — the GM is already the only writer.
   *
   * @param {ChatMessage} message - The request's message.
   * @param {string|null} slot - Embed slot, or null for a whole-card request.
   * @param {ChatMessage} sourceMessage - The roll to apply.
   * @param {object} [options]
   * @param {boolean} [options.asAid] - Record as an Aid Another result.
   * @param {boolean} [options.confirmed] - Skip the overwrite prompt (batch runs).
   * @returns {Promise<boolean>} Whether the result was recorded.
   */
  static async apply(message, slot, sourceMessage, { asAid = false, confirmed = false } = {}) {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.ApplyGMOnly"));
      return false;
    }

    const flags = RollRequestChat._readState(message, slot);
    if (!ApplyRoll.isApplicable(flags)) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.ApplyNotApplicable"));
      return false;
    }

    const who = ApplyRoll.speakerOf(sourceMessage);
    const roll = ApplyRoll.rollOf(sourceMessage);
    if (!who || !roll) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.ApplyNoRoll"));
      return false;
    }

    const route = ApplyRoll.routeFor(flags, who);
    if (!route) {
      ui.notifications.warn(game.i18n.format("RR.Notif.ApplyNoSlot", { name: who.actor.name }));
      return false;
    }

    // Enforced here and not only in the pickers: this is public API, and the
    // whole point of matching on PF1's own check subject is that an unrelated
    // roll can never be fed into a request. Matched against the row's own check
    // where it has one, which is why the route is resolved first.
    const want = ApplyRoll.wantFor(flags, route);
    const subject = ApplyRoll.subjectOf(sourceMessage);
    if (!subject || subject.type !== want.type || subject.key !== want.key) {
      ui.notifications.warn(game.i18n.format("RR.Notif.ApplyWrongCheck", { name: want.name }));
      return false;
    }

    const rollType = asAid ? route.aidRollType : route.rollType;
    if (!rollType) {
      ui.notifications.warn(game.i18n.localize("RR.Notif.ApplyNoAidSlot"));
      return false;
    }

    const occupied = asAid ? route.aidOccupied : route.occupied;
    if (occupied && !confirmed) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("RR.Apply.ReplaceTitle") },
        content: `<p>${game.i18n.format("RR.Apply.ReplaceBody", { name: route.label })}</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!ok) return false;
    }

    const resultEntry = await ApplyRoll._buildEntry(flags, route, who, roll, sourceMessage, rollType);

    await RollRequestChat._updateMessage(message, rollType, resultEntry, flags, {
      targetActorId: route.targetActorId,
      slot,
      isRepick: occupied,
      // Banked aid is read and patched inside the queued update, not here — see
      // RollRequestChat._applyUpdate.
      applyAid: !asAid && !!flags.includeAid,
    });

    await ApplyRoll._recordApplication(sourceMessage, message, slot, route.resultKey);
    await ApplyRoll._maybeDeleteSource(sourceMessage);
    return true;
  }

  /**
   * Build the result entry a roll lifted from chat produces.
   *
   * Notes are re-derived from the actor against this request's check rather
   * than scraped off the source card, so they read the same as they would have
   * had the roll been made here.
   */
  static async _buildEntry(flags, route, who, roll, sourceMessage, rollType) {
    const { actor } = who;
    const notes = await RollRequestChat._getEffectNotes(actor, ApplyRoll.wantFor(flags, route));

    const entry = {
      tokenId: route.tokenId,
      actorId: actor.id,
      resultKey: route.resultKey,
      actorName: actor.name,
      actorImg: actor.img,
      total: roll.total,
      formula: roll.formula,
      naturalRoll: roll.dice?.[0]?.results?.[0]?.result ?? null,
      rollData: roll.toJSON(),
      notes,
      // Marks the row as pulled in rather than rolled on the card.
      applied: {
        messageId: sourceMessage.id,
        time: sourceMessage.timestamp ?? Date.now(),
      },
    };

    // Aid scoring is a pure function of the total, so an applied roll is scored
    // exactly as a rolled one would be.
    if (rollType === "aid" || rollType === "multiAid" || rollType === "targetedAid") {
      if (entry.total >= 10) {
        const uncapped = game.settings.get(MODULE_ID, "uncap-aid-another");
        entry.aidBonus = 2 + (uncapped ? Math.floor((entry.total - 10) / 5) : 0);
        entry.aidSuccess = true;
      } else {
        entry.aidBonus = 0;
        entry.aidSuccess = false;
      }
    }

    return entry;
  }

  /**
   * Note on the source message where it was applied, so the picker can mark it
   * and a second application is a visible choice rather than an accident.
   */
  static async _recordApplication(sourceMessage, message, slot, resultKey) {
    try {
      const record = [...ApplyRoll._appliedRecord(sourceMessage),
        { messageId: message.id, slot, resultKey }];
      await sourceMessage.setFlag(MODULE_ID, "appliedTo", record);
    } catch (err) {
      console.error(`${MODULE_ID} | Could not mark the source message as applied:`, err);
    }
  }

  /** Delete the source message, where the setting asks for it. */
  static async _maybeDeleteSource(sourceMessage) {
    if (!game.settings.get(MODULE_ID, "apply-delete-source")) return;
    try {
      await sourceMessage.delete();
    } catch (err) {
      console.error(`${MODULE_ID} | Could not delete the applied source message:`, err);
    }
  }
}
