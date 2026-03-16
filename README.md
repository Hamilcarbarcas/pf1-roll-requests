# Pathfinder 1e Roll Requests

A Foundry VTT module for the PF1e system that lets the GM request rolls from players via interactive chat cards.

## Requirements

- Foundry VTT v13+
- PF1e system v11.10+

## Features

### Roll Request Dialog

A GM-only dialog accessed via the dice button in the token controls toolbar, or by calling `game.pf1RollRequests.requestRoll()` from a macro.

The dialog lets you select:

- **Check type** — Ability checks, saving throws, skill checks, or raw dice
- **Mode** — Single-check or multi-check
- **DC** — Optional; can be shown or hidden from players
- **Roll mode** — Public, GM-only, or blind roll
- **Result visibility** — Whether pass/fail indicators are shown to players
- **Aid Another** — Whether other players can aid (single-check mode only)
- **Flavor text** — Optional label shown on the chat card

### Chat Cards

**Single-check mode:** One player rolls the primary check. Other players can contribute Aid Another rolls (DC 10) that add +2 each to the primary roll's total. Results update in real time.

**Multi-check mode:** Any number of players can each roll independently. Each result is appended to the card as it comes in.

The GM always sees the DC and pass/fail results. Players see them only if the GM enabled visibility for that request.

### API

Other modules can create roll requests programmatically:

```js
// Basic request
game.pf1RollRequests.createRequest({
  type: "skill",  // "ability", "save", "skill", or "dice"
  key: "per",     // system key (e.g. "str", "ref", "per", "d20")
  dc: 15,
});

// Full options
game.pf1RollRequests.createRequest({
  type: "skill",
  key: "dip",
  dc: 20,
  mode: "single",       // "single" or "multi" (default: "multi")
  showDC: false,         // show DC to players (default: false)
  showResults: false,    // show pass/fail to players (default: false)
  rollMode: "roll",      // "roll", "gmroll", or "blindroll" (default: "roll")
  flavor: "Diplomacy",   // optional flavor text
  includeAid: true,      // include Aid Another section (default: true)
  awaitResult: true,     // return a Promise with the roll result (single mode only)
});
```

When `awaitResult: true` is set (single-check mode only), `createRequest` returns a Promise that resolves with the roll result object once a player completes the roll, or `null` if the chat card is deleted before completion.

### Hook

`pf1RollRequests.rollComplete` fires whenever a roll is completed on a request card, passing the message ID, roll type, result data, and updated flags.
