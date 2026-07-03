// ============================================================
// PF1 Roll Requests — Save Auto-Request
// Converts PF1 action chat messages that contain a saving throw
// into an embedded targeted roll-request card on first render.
// ============================================================

import { RollRequestChat } from "./RollRequestChat.mjs";

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

    const saveType = message.system?.save?.type;
    if (!saveType) return;
    const targetUUIDs = message.system?.targets ?? [];
    if (!targetUUIDs.length) return;

    // Only the GM initializes (prevents race conditions on multi-client render)
    if (!game.user.isGM) return;

    // Prevent duplicate concurrent initializations for the same message
    if (SaveAutoRequest._pendingInit.has(message.id)) return;
    SaveAutoRequest._pendingInit.add(message.id);

    SaveAutoRequest._initialize(message, html).finally(() => {
      SaveAutoRequest._pendingInit.delete(message.id);
    });
  }

  // ----------------------------------------------------------
  // First-time conversion: extract PF1 content, build flags,
  // update message to a proper targeted roll-request card.
  // ----------------------------------------------------------

  static async _initialize(message, html) {
    const saveType = message.system.save.type;
    const dc = message.system.save.dc ?? null;
    const targetUUIDs = message.system.targets;

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

    const { headerHtml, footerHtml } = SaveAutoRequest._extractPf1Content(html);

    const rawLabel = pf1?.config?.savingThrows?.[saveType] ?? saveType;
    const saveName = game.i18n.localize(rawLabel) + " Save";

    const flagData = {
      mode: "targeted",
      isSaveRequest: true,
      request: { type: "save", key: saveType, name: saveName },
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
}
