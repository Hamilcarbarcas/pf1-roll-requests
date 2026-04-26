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
    // Only the GM processes roll results (to avoid race conditions)
    if (!game.user.isGM) return;

    switch (data.action) {
      case "rollResult":
        await SocketHandler._handleRollResult(data);
        break;
      default:
        console.warn(`${MODULE_ID} | Unknown socket action: ${data.action}`);
    }
  }

  static async _handleRollResult({ messageId, rollType, targetActorId, resultEntry }) {
    const message = game.messages.get(messageId);
    if (!message) {
      console.warn(`${MODULE_ID} | Message ${messageId} not found`);
      return;
    }

    const flags = message.flags?.[MODULE_ID];
    if (!flags) {
      console.warn(`${MODULE_ID} | No flags found on message ${messageId}`);
      return;
    }

    await RollRequestChat._updateMessage(message, rollType, resultEntry, flags, { targetActorId });
  }
}
