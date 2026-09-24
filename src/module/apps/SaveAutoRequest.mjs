// ============================================================
// PF1 Roll Requests — Save Auto-Request
// Converts PF1 action chat messages that contain a saving throw —
// or a configured skill/ability check (see ActionCheckConfig) —
// into embedded targeted roll requests, placed above the attack
// entries they belong to.
//
// PF1 renders its save button *inside every attack entry* (see the
// `{{#each attacks}}` loop in templates/chat/attack-roll.hbs), because each
// hit forces its own save. A card with two damage entries therefore carries
// two Reflex buttons, and one widget covering the whole card cannot record
// two rounds of saves. So there is one request per attack entry that has a
// save, each sitting directly above its entry.
//
// State lives in embed slots (`save-0`, `save-1`, …) and the widgets are
// placed at render time. Nothing here writes `message.content`: a card
// converted this way is still PF1's own card, which is what lets there be
// more than one request on it. Cards converted before this — whose request
// sits at the flag root, with the widget baked into their stored content —
// are left to RollRequestChat's whole-card path untouched.
// ============================================================

import { RollRequestChat } from "./RollRequestChat.mjs";
import { ActionCheckConfig } from "./ActionCheckConfig.mjs";
import { ApplyRoll } from "./ApplyRoll.mjs";

const MODULE_ID = "pf1-roll-requests";

/** Embed slots this feature owns, numbered by attack entry: `save-0`, `save-1`, … */
const SLOT_PREFIX = "save-";

/**
 * How long a save button's click stays a live destination for the roll it
 * starts. Generous, because PF1's roll dialog may sit open: the guard that does
 * the real work is the reference match, since the only saves carrying a card's
 * UUID are the ones its own buttons rolled.
 */
const ROUTE_TTL = 5 * 60 * 1000;

export class SaveAutoRequest {

  static _pendingInit = new Set();

  /**
   * The request a save rolled on this client should land on: set when one of
   * PF1's own save buttons is clicked, read when the check message it produces
   * is created. Client-local and deliberately not consumed on read — one click
   * rolls a save for every controlled token, and each of those results belongs
   * to that token's own row of the same request.
   *
   * @type {{messageId: string, slot: string, at: number}|null}
   */
  static _pendingRoute = null;

  // ----------------------------------------------------------
  // renderChatMessageHTML hook entry point
  // ----------------------------------------------------------

  static onRenderChatMessage(message, html) {
    if (!game.settings.get(MODULE_ID, "auto-save-request")) return;

    const flags = message.flags?.[MODULE_ID];

    // A request at the flag root is a card converted by the pre-embed rewrite:
    // its widget is already in the stored content and RollRequestChat draws it.
    if (flags?.request) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    // Already converted — every render just places the widgets again.
    if (SaveAutoRequest._slotsOn(message).length) {
      SaveAutoRequest._placeEmbeds(message, root)
        .catch((err) => console.error(`${MODULE_ID} | Could not place the save requests:`, err));
      return;
    }

    const targetUUIDs = SaveAutoRequest.requestTargets(message);
    if (!targetUUIDs.length) return;

    // Only the GM initializes (prevents race conditions on multi-client render)
    if (!game.user.isGM) return;

    // Resolve what to request: a system saving throw, or a configured
    // skill/ability check flagged on the originating action.
    let descriptor = SaveAutoRequest._resolveDescriptor(message);
    if (!descriptor) {
      // Nothing to roll. The list is still worth replacing when the GM has asked
      // for it — same rows, defenses and token controls, no roll button.
      if (!game.settings.get(MODULE_ID, "target-list-always")) return;
      // Only replace a list PF1 actually drew.
      if (!root.querySelector?.(".attack-targets")) return;
      descriptor = { type: "none", key: "", name: game.i18n.localize("RR.Card.TargetsTitle") };
    }

    // Prevent duplicate concurrent initializations for the same message
    if (SaveAutoRequest._pendingInit.has(message.id)) return;
    SaveAutoRequest._pendingInit.add(message.id);

    SaveAutoRequest._initialize(message, root, descriptor).finally(() => {
      SaveAutoRequest._pendingInit.delete(message.id);
    });
  }

  // ----------------------------------------------------------
  // The tokens that should actually be asked to roll: the action's targets,
  // minus any the posting module opted out via
  //   flags["pf1-roll-requests"].excludeTargets = [tokenUuid, ...]
  //
  // `message.system.targets` means "tokens this action was used against", and
  // other modules read it that way (Little Helper's apply-damage sanity check,
  // for one), so a module that needs a target left off the *check* should say
  // so here rather than lie about the target list. Example: a splash weapon,
  // where the token taking the direct hit is a genuine target of the action but
  // is not among those rolling the burst's Reflex save.
  //
  // Deliberately generic — nothing here knows why a target was excluded.
  // ----------------------------------------------------------

  static requestTargets(message) {
    const all = message.system?.targets ?? [];
    const excluded = message.flags?.[MODULE_ID]?.excludeTargets;
    if (!Array.isArray(excluded) || !excluded.length) return all;
    const skip = new Set(excluded);
    return all.filter((uuid) => !skip.has(uuid));
  }

  // ----------------------------------------------------------
  // Resolve the request descriptor for a chat message, or null when
  // there's nothing to convert. Saving throws take priority; failing
  // that, an ActionCheckConfig skill/ability flag on the source action.
  // ----------------------------------------------------------

  static _resolveDescriptor(message) {
    // Priority 1: a system saving throw.
    const saveType = message.system?.save?.type;
    if (saveType) {
      const rawLabel = pf1?.config?.savingThrows?.[saveType] ?? saveType;
      const saveName = game.i18n.format("RR.SaveName", { name: game.i18n.localize(rawLabel) });
      return {
        type: "save",
        key: saveType,
        name: saveName,
        dc: message.system.save.dc ?? null,
      };
    }

    // Priority 2: a configured skill/ability check on the originating action.
    const actionId = message.system?.action?.id;
    const itemId = message.system?.item?.id;
    if (!actionId || !itemId) return null;

    const actor = message.system.actor ? fromUuidSync(message.system.actor) : null;
    const item = actor?.items?.get(itemId) ?? null;
    if (!item) return null;

    const cfg = item.getFlag(MODULE_ID, "checks")?.[actionId];
    if (!cfg || (cfg.type !== "skill" && cfg.type !== "ability")) return null;

    return {
      type: cfg.type,
      key: cfg.key,
      name: ActionCheckConfig.checkName(cfg.type, cfg.key),
      dcFormula: cfg.dc ?? null,
      item,
      actor,
      actionId,
    };
  }

  // ----------------------------------------------------------
  // Resolve a check DC formula to a number, against the action's
  // (else item's, else actor's) roll data. Plain integers short-circuit.
  // ----------------------------------------------------------

  static _resolveCheckDC(descriptor) {
    const formula = descriptor.dcFormula;
    if (formula == null || formula === "") return null;
    if (typeof formula === "number") return Number.isFinite(formula) ? formula : null;

    const str = String(formula).trim();
    if (str === "") return null;
    if (/^\d+$/.test(str)) return Number(str);

    let rollData = {};
    try {
      const action = descriptor.item?.actions?.get?.(descriptor.actionId);
      rollData = action?.getRollData?.()
        ?? descriptor.item?.getRollData?.()
        ?? descriptor.actor?.getRollData?.()
        ?? {};
    } catch {
      rollData = {};
    }

    const RollCls = pf1?.dice?.RollPF ?? globalThis.RollPF;
    try {
      if (RollCls?.safeRollSync) {
        const total = RollCls.safeRollSync(str, rollData)?.total;
        return Number.isFinite(total) ? total : null;
      }
      // Fallback: a plain synchronous roll.
      const roll = new Roll(str, rollData);
      roll.evaluateSync();
      return Number.isFinite(roll.total) ? roll.total : null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------
  // Attack entries and slots
  // ----------------------------------------------------------

  /**
   * The attack entries that carry a save button, in card order — one request
   * each. Filtered on the button rather than taken as every `.chat-attack`,
   * because a notes-only entry draws no save and has none to ask for.
   *
   * @param {HTMLElement} root - The message's rendered element.
   * @returns {HTMLElement[]} The entries, each the element its request sits above.
   */
  static _saveBlocks(root) {
    const card = root.querySelector?.(".pf1.chat-card");
    if (!card) return [];
    return Array.from(card.querySelectorAll(":scope > .chat-attack"))
      .filter((el) => el.querySelector('button[data-action="save"]'));
  }

  /** This feature's embed slots on a message, in attack order. */
  static _slotsOn(message) {
    const embeds = message?.flags?.[MODULE_ID]?.embeds ?? {};
    return Object.keys(embeds)
      .filter((slot) => slot.startsWith(SLOT_PREFIX))
      .sort((a, b) => SaveAutoRequest._slotIndex(a) - SaveAutoRequest._slotIndex(b));
  }

  /** The attack index a slot belongs to. */
  static _slotIndex(slot) {
    return Number(slot.slice(SLOT_PREFIX.length)) || 0;
  }

  // ----------------------------------------------------------
  // First-time conversion: resolve the targets, then write one embed per
  // attack entry carrying a save. A single update, so the message re-renders
  // once and every client places the lot together.
  // ----------------------------------------------------------

  static async _initialize(message, root, descriptor) {
    const targetsOnly = descriptor.type === "none";
    const dc = descriptor.type === "save"
      ? (descriptor.dc != null ? Number(descriptor.dc) : null)
      : targetsOnly ? null : SaveAutoRequest._resolveCheckDC(descriptor);
    const targetUUIDs = SaveAutoRequest.requestTargets(message);

    // Resolve token UUIDs to targetedActors entries.
    // We use the full UUID as id so results are unique per token
    // even when multiple tokens share the same base actor.
    const targetedActors = [];
    for (const uuid of targetUUIDs) {
      const tokenDoc = fromUuidSync(uuid);
      if (!tokenDoc) continue;
      const actor = tokenDoc.actor;
      if (!actor) continue;
      // Use tokenDoc.id (safe hex string) as the key — full UUIDs contain dots which
      // Foundry's expandObject would shred into nested objects when used as property names.
      // tokenUUID is stored as a value (not a key) so it passes through safely.
      targetedActors.push({
        id: tokenDoc.id,
        tokenUUID: uuid,
        isHidden: !!tokenDoc.hidden,
        name: tokenDoc.name,
        // Actor art, not the token texture — see resolveTargetedActors in main.mjs
        img: actor.img ?? tokenDoc.texture?.src,
      });
    }
    if (!targetedActors.length) return;

    // One request per attack entry with a save. A target list with nothing to
    // roll is about the targets, not the attacks, so it stays a single widget;
    // so does a card whose save hangs off no attack entry at all.
    const blocks = SaveAutoRequest._saveBlocks(root);
    const count = targetsOnly ? 1 : Math.max(1, blocks.length);

    // A sole target's defenses panel opens by itself only on the card's first
    // request, and only where that entry rolled an attack — the panel is there
    // to read a hit against, and a save-only entry has no hit to read. A bare
    // target list keys off the card's first attack entry instead, having no
    // save button to hang a request on.
    const lead = blocks[0] ?? root.querySelector(".pf1.chat-card > .chat-attack");
    const leadRollsAttack = !!lead?.querySelector(".attack-flavor");

    const embeds = {};
    for (let i = 0; i < count; i++) {
      embeds[`${SLOT_PREFIX}${i}`] = SaveAutoRequest._buildState(descriptor, dc, targetedActors, {
        autoExpand: i === 0 && leadRollsAttack,
      });
    }

    await message.update({ [`flags.${MODULE_ID}.embeds`]: embeds });
  }

  /**
   * One request's flag state. Deliberately the same shape an embed created
   * through the public API gets, so every path in RollRequestChat that reads a
   * request reads this one too.
   *
   * @param {object} descriptor
   * @param {number|null} dc
   * @param {object[]} targetedActors
   * @param {object} options
   * @param {boolean} options.autoExpand - Whether a sole target's defenses panel
   *   should open by itself on this request.
   * @returns {object}
   */
  static _buildState(descriptor, dc, targetedActors, { autoExpand }) {
    return {
      mode: "targeted",
      isSaveRequest: true,
      // Nothing to roll: the card is the target list, its defenses and the token
      // controls. Suppresses the roll buttons and every bulk action that fires one.
      targetsOnly: descriptor.type === "none",
      request: { type: descriptor.type, key: descriptor.key, name: descriptor.name },
      dc: dc !== null ? Number(dc) : null,
      showDC: dc !== null,
      showResults: true,
      rollMode: "roll",
      flavor: "",
      includeAid: false,
      // Resolved by the caller: see _initialize.
      autoExpand,
      controls: true,
      mount: null,
      // Deep-cloned per slot: these are separate requests that happen to start
      // from the same targets, and they must not share one stored array.
      targetedActors: foundry.utils.deepClone(targetedActors),
      actorResults: {},
      actorAidResults: {},
      usedActorIds: [],
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
    };
  }

  // ----------------------------------------------------------
  // Placement (every client, every render)
  //
  // The widgets are render-time children of PF1's card, not part of the stored
  // content, so they are rebuilt from flags on each draw. A roll writes flags
  // only; Foundry re-renders the message and this runs again.
  // ----------------------------------------------------------

  static async _placeEmbeds(message, root) {
    const card = root.querySelector?.(".pf1.chat-card");
    if (!card) return;

    const slots = SaveAutoRequest._slotsOn(message);
    if (!slots.length) return;

    // Synthesize the check button before the first await: the request's own
    // render hook runs as soon as this one yields, and would otherwise draw
    // before the button exists.
    SaveAutoRequest._placeCheckButton(card, RollRequestChat._readState(message, slots[0]));

    // PF1's own target list is what the widget replaces — the same tokens, with
    // the defenses and roll buttons the plain list has no room for. Removed
    // after the hosts are placed, since the first one may anchor to it.
    const list = card.querySelector(":scope > .attack-targets");
    const blocks = SaveAutoRequest._saveBlocks(root);

    for (const slot of slots) {
      let host = card.querySelector(`:scope > .arr-save-insert[data-arr-slot="${slot}"]`);
      if (!host) {
        host = document.createElement("div");
        host.className = "arr-save-insert";
        host.dataset.arrSlot = slot;
        const before = blocks[SaveAutoRequest._slotIndex(slot)] ?? list;
        if (before) card.insertBefore(host, before);
        else card.appendChild(host);
      }
      SaveAutoRequest._routeNativeSave(message, blocks[SaveAutoRequest._slotIndex(slot)], slot);
      await RollRequestChat.renderEmbed(message, { slot, into: host });
    }

    list?.remove();
  }

  // ----------------------------------------------------------
  // Routing PF1's own save buttons into the request above them
  //
  // PF1's button rolls the save; this only notes where the result belongs, so
  // that a save rolled from attack 2's button fills attack 2's request instead
  // of leaving the player to roll the same save twice. The click is never
  // intercepted — the note is taken on the capture phase, PF1's own handler
  // runs on the bubble phase as always, and the roll it posts is applied by the
  // GM through the ordinary Apply Roll path once it exists.
  // ----------------------------------------------------------

  /** Note this request as the destination for saves rolled from its entry's button. */
  static _routeNativeSave(message, block, slot) {
    const btn = block?.querySelector('button[data-action="save"]');
    if (!btn || btn.dataset.arrRouted) return;
    btn.dataset.arrRouted = slot;
    btn.addEventListener("click", () => {
      SaveAutoRequest._pendingRoute = { messageId: message.id, slot, at: Date.now() };
    }, { capture: true });
  }

  /** The pending destination, if one was set recently enough to still mean it. */
  static _liveRoute() {
    const route = SaveAutoRequest._pendingRoute;
    if (!route) return null;
    if (Date.now() - route.at > ROUTE_TTL) {
      SaveAutoRequest._pendingRoute = null;
      return null;
    }
    return route;
  }

  /**
   * Stamp a save this client is about to post with the request it belongs to.
   *
   * Runs on the rolling client, which is the only one that knows which button
   * was pressed; the GM reads the stamp back off the created message. Matched
   * on PF1's own `system.reference` — the UUID of the card whose button rolled
   * it — so a save rolled from anywhere else is never claimed.
   *
   * @param {ChatMessage} message - The message being created.
   */
  static onPreCreateChatMessage(message) {
    if (message.type !== "check") return;
    if (!message.system?.subject?.save) return;

    const route = SaveAutoRequest._liveRoute();
    if (!route) return;

    const ref = message.system?.reference;
    if (!ref || fromUuidSync(ref)?.id !== route.messageId) return;

    message.updateSource({ [`flags.${MODULE_ID}.autoRoute`]: { slot: route.slot } });
  }

  /**
   * Record a stamped save on the request it was rolled for.
   *
   * GM-side, through Apply Roll, so this inherits its checks wholesale: the
   * roll is lifted whole, the check must match, and the request's own effect
   * notes are re-derived. Everything it declines is declined silently — nobody
   * asked for this, and the save's own card is still there to read.
   *
   * @param {ChatMessage} message - The check message just created.
   */
  static async onCreateChatMessage(message) {
    // The active GM owns the request card's flags and is its only writer.
    if (!game.users.activeGM?.isSelf) return;

    const slot = message.flags?.[MODULE_ID]?.autoRoute?.slot;
    if (!slot) return;

    const target = message.system?.reference ? fromUuidSync(message.system.reference) : null;
    if (!target) return;

    const state = RollRequestChat._readState(target, slot);
    if (!ApplyRoll.isApplicable(state)) return;

    const who = ApplyRoll.speakerOf(message);
    if (!who) return;

    // "Where applicable": this roller has a row on that request and has not
    // filled it yet. A save rolled by someone the action never targeted has no
    // row, and one rolled against a row that already has a result is a reroll —
    // which Apply Roll would offer to overwrite, and which nothing here should
    // decide on the GM's behalf.
    const route = ApplyRoll.routeFor(state, who);
    if (!route || route.occupied) return;

    const subject = ApplyRoll.subjectOf(message);
    const want = ApplyRoll.wantFor(state, route);
    if (subject?.type !== want.type || subject?.key !== want.key) return;

    await ApplyRoll.apply(target, slot, message, { confirmed: true });
  }

  // ----------------------------------------------------------
  // Build the standalone check button (mirrors PF1's native save button) and
  // append it to the card. Bound here rather than left to RollRequestChat's
  // sweep, which runs before this element exists on a re-render. Deliberately
  // carries no `data-action` so PF1's own button binder doesn't also fire on it.
  // ----------------------------------------------------------

  static _placeCheckButton(card, state) {
    // A saving throw already has PF1's own button on every attack entry, and a
    // bare target list has nothing to roll.
    const type = state?.request?.type;
    if (type !== "skill" && type !== "ability") return;
    if (card.querySelector(":scope > .arr-check-buttons")) return;

    const dc = state.dc;
    const label = dc != null
      ? game.i18n.format("RR.Card.CheckButton", { name: state.request.name, dc })
      : state.request.name;

    const group = document.createElement("div");
    group.className = "card-buttons flexcol arr-check-buttons";
    const inner = document.createElement("div");
    inner.className = "card-button-group flexcol";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rr-check-button";
    btn.dataset.checkType = state.request.type;
    btn.dataset.checkKey = state.request.key;
    btn.dataset.dc = dc != null ? String(dc) : "";
    btn.dataset.bound = "1";
    btn.textContent = label;
    btn.addEventListener("click", (ev) => RollRequestChat._onCheckButton(ev));

    inner.appendChild(btn);
    group.appendChild(inner);
    card.appendChild(group);
  }
}
