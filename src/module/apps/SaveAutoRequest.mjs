// ============================================================
// PF1 Roll Requests — Save Auto-Request
// Converts PF1 action chat messages that contain a saving throw —
// or a configured skill/ability check (see ActionCheckConfig) —
// into an embedded targeted roll-request card on first render.
// ============================================================

import { RollRequestChat } from "./RollRequestChat.mjs";
import { ActionCheckConfig } from "./ActionCheckConfig.mjs";

const MODULE_ID = "pf1-roll-requests";

export class SaveAutoRequest {

  static _pendingInit = new Set();

  // ----------------------------------------------------------
  // renderChatMessageHTML hook entry point
  // ----------------------------------------------------------

  static onRenderChatMessage(message, html) {
    // Already a roll-request — nothing to do
    if (message.flags?.[MODULE_ID]?.request) return;

    if (!game.settings.get(MODULE_ID, "auto-save-request")) return;

    const targetUUIDs = SaveAutoRequest.requestTargets(message);
    if (!targetUUIDs.length) return;

    // Only the GM initializes (prevents race conditions on multi-client render)
    if (!game.user.isGM) return;

    // Resolve what to request: a system saving throw, or a configured
    // skill/ability check flagged on the originating action.
    const descriptor = SaveAutoRequest._resolveDescriptor(message);
    if (!descriptor) return;

    // Prevent duplicate concurrent initializations for the same message
    if (SaveAutoRequest._pendingInit.has(message.id)) return;
    SaveAutoRequest._pendingInit.add(message.id);

    SaveAutoRequest._initialize(message, html, descriptor).finally(() => {
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
  // First-time conversion: extract PF1 content, build flags,
  // update message to a proper targeted roll-request card.
  // ----------------------------------------------------------

  static async _initialize(message, html, descriptor) {
    const dc = descriptor.type === "save"
      ? (descriptor.dc != null ? Number(descriptor.dc) : null)
      : SaveAutoRequest._resolveCheckDC(descriptor);
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
        img: tokenDoc.texture?.src ?? actor.img,
      });
    }
    if (!targetedActors.length) return;

    const { headerHtml, footerHtml: rawFooterHtml } = SaveAutoRequest._extractPf1Content(html);
    let footerHtml = rawFooterHtml;

    // For skill/ability checks, PF1 renders no native "save" button (there is no
    // system save), so synthesize an equivalent button in the same footer slot —
    // a standalone check roll for the clicker's selected token, mirroring the
    // native "Fortitude DC 12" button that saving throws get for free.
    if (descriptor.type !== "save") {
      footerHtml = SaveAutoRequest._appendCheckButton(footerHtml, descriptor, dc);
    }

    const flagData = {
      mode: "targeted",
      isSaveRequest: true,
      request: { type: descriptor.type, key: descriptor.key, name: descriptor.name },
      dc: dc !== null ? Number(dc) : null,
      showDC: dc !== null,
      showResults: true,
      rollMode: "roll",
      flavor: "",
      includeAid: false,
      targetedActors,
      actorResults: {},
      actorAidResults: {},
      usedActorIds: [],
      rolledActors: {},
      aidResults: {},
      aidTotal: 0,
      pf1HeaderHtml: headerHtml,
      pf1FooterHtml: footerHtml,
    };

    // _rebuildCardContent returns the wrapped content (including pf1 header/footer)
    // when pf1HeaderHtml/pf1FooterHtml are present in flags.
    const newContent = await RollRequestChat._rebuildCardContent(flagData);

    await message.update({
      content: newContent,
      flags: { [MODULE_ID]: flagData },
    });
  }

  // ----------------------------------------------------------
  // Split the PF1 chat card into the content we want to keep:
  //   headerHtml — opening of pf1.chat-card + everything before .attack-targets
  //   footerHtml — everything after .card-buttons + closing tag
  // The roll-request card is concatenated between them.
  // ----------------------------------------------------------

  static _extractPf1Content(html) {
    const card = html.querySelector?.(".pf1.chat-card");
    if (!card) return { headerHtml: "", footerHtml: "" };

    const children = Array.from(card.children);
    const targetsIdx = children.findIndex(el => el.classList.contains("attack-targets"));

    const beforeTargets = targetsIdx >= 0 ? children.slice(0, targetsIdx) : [];
    const afterContent  = targetsIdx >= 0 ? children.slice(targetsIdx + 1) : [];

    // Open the pf1 wrapper; roll-request card will be inserted between header and footer.
    const headerHtml = `<div class="${card.className}">`
      + beforeTargets.map(el => el.outerHTML).join("");

    const footerHtml = afterContent.map(el => el.outerHTML).join("") + `</div>`;

    return { headerHtml, footerHtml };
  }

  // ----------------------------------------------------------
  // Build the standalone check button (mirrors PF1's native save button)
  // and splice it into the preserved footer, inside the .pf1.chat-card
  // wrapper so it inherits PF1's card-button styling. Bound at render time
  // by RollRequestChat (see `.rr-check-button`). Deliberately carries no
  // `data-action` so PF1's own button binder doesn't also fire on it.
  // ----------------------------------------------------------

  static _appendCheckButton(footerHtml, descriptor, dc) {
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const label = dc != null
      ? game.i18n.format("RR.Card.CheckButton", { name: descriptor.name, dc })
      : descriptor.name;

    const group =
      `<div class="card-buttons flexcol"><div class="card-button-group flexcol">` +
      `<button type="button" class="rr-check-button" data-check-type="${esc(descriptor.type)}" ` +
      `data-check-key="${esc(descriptor.key)}" data-dc="${dc != null ? dc : ""}">${esc(label)}</button>` +
      `</div></div>`;

    const CLOSE = "</div>";
    return footerHtml.endsWith(CLOSE)
      ? footerHtml.slice(0, -CLOSE.length) + group + CLOSE
      : footerHtml + group;
  }
}
