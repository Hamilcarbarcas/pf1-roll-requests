// ============================================================
// Pathfinder 1e Roll Requests — Socket Handler
// Allows players to send roll results to the GM for message updates.
// ============================================================

import { RollRequestChat } from "./apps/RollRequestChat.mjs";

const MODULE_ID = "pf1-roll-requests";

export class SocketHandler {

  static register() {
    game.socket.on(`module.${MODULE_ID}`, (data) => {
      SocketHandler._onMessage(data);
    });
    console.log(`${MODULE_ID} | Socket handler registered`);
  }

  static async _onMessage(data) {
    // The GM's reply to an amendment this client asked for.
    if (data.action === "amendResultDone") {
      if (data.userId === game.user.id) RollRequestChat._resolveAmendment(data.requestId, data.ok);
      return;
    }

    // Only the GM processes roll results (to avoid race conditions)
    if (!game.user.isGM) return;

    switch (data.action) {
      case "rollResult":
        await SocketHandler._handleRollResult(data);
        break;
      case "amendResult":
        await SocketHandler._handleAmendResult(data);
        break;
      default:
        console.warn(`${MODULE_ID} | Unknown socket action: ${data.action}`);
    }
  }

  static async _handleRollResult({ messageId, rollType, targetActorId, isRepick, slot = null, resultEntry }) {
    const message = game.messages.get(messageId);
    if (!message) {
      console.warn(`${MODULE_ID} | Message ${messageId} not found`);
      return;
    }

    // `slot` names which request on the message the result belongs to: an
    // embedded one, or null for the message's own card.
    const flags = RollRequestChat._readState(message, slot);
    if (!flags) {
      console.warn(`${MODULE_ID} | No ${slot ? `embed '${slot}'` : "flags"} found on message ${messageId}`);
      return;
    }

    await RollRequestChat._updateMessage(message, rollType, resultEntry, flags, { targetActorId, isRepick, slot });
  }

  // One GM answers: a second one replying would race the first's write.
  static async _handleAmendResult({ requestId, messageId, slot = null, key, amendment }) {
    if (!game.users.activeGM?.isSelf) return;
    const message = game.messages.get(messageId);
    const ok = message ? await RollRequestChat.amendResult(message, slot, key, amendment) : false;
    game.socket.emit(`module.${MODULE_ID}`, { action: "amendResultDone", requestId, userId: amendment?.userId, ok });
  }
}
