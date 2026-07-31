# PF1 Roll Requests — API

Developer reference for driving the module from other modules or macros.

## Creating requests

Other modules or scripts can create roll requests programmatically:

```js
// Basic request
game.pf1RollRequests.createRequest({
  type: "skill",  // "ability", "save", "skill", or "dice"
  key: "per",     // system key (e.g. "str", "ref", "per", "d20")
  dc: 15,
});

// Full options (multi / single mode)
game.pf1RollRequests.createRequest({
  type: "skill",
  key: "dip",
  dc: 20,
  mode: "single",       // "single", "multi", or "targeted" (default: "multi")
  showDC: false,        // show DC to players (default: false)
  showResults: false,   // show pass/fail to players (default: false)
  rollMode: "roll",     // "roll", "gmroll", "publicblind", or "blindroll" (default: "roll")
  flavor: "Diplomacy",  // optional flavor text
  includeAid: true,     // include Aid Another section (default: true; forced off for saves and dice)
  awaitResult: true,    // return a Promise with the roll result (single mode only)
  onResult: (payload) => {},  // streaming callback fired on every roll (any mode; best for "multi")
});

// Targeted mode — pin specific actors/tokens to the card
const message = await game.pf1RollRequests.createRequest({
  type: "save",
  key: "fort",
  dc: 15,
  mode: "targeted",
  showDC: true,
  showResults: true,
  flavor: "Massive Damage Save",
  targetedActors: [{ id: tokenDoc.id }],
});

// After setting any pending-result tracking, you can auto-roll all targets:
await game.pf1RollRequests.bulkRollTargeted(message);
```

`mode: "targeted"` pins one or more specific tokens to the card rather than letting any player roll. Returns the created chat message.

Each `targetedActors` entry requires only `id` (the token document ID). All other fields are automatically resolved from the canvas token:

| Field | Auto-resolved from | Override effect |
|---|---|---|
| `tokenUUID` | `tokenDoc.uuid` | Use a different token document for actor/ownership lookup |
| `name` | `tokenDoc.name` | Show a different display name on the card |
| `img` | `tokenDoc.texture.src` (falls back to actor portrait) | Show a different portrait |
| `isHidden` | `tokenDoc.hidden` | Force a token visible or hidden on the card regardless of its canvas state |

`game.pf1RollRequests.bulkRollTargeted(message)` rolls all pending targets on a targeted card without a dialog, exactly like the Roll All button. Call it after any pending-result bookkeeping is in place.

When `awaitResult: true` is set (single-check mode only), `createRequest` returns a Promise that resolves with the roll result object once a player completes the roll, or `null` if the chat card is deleted before completion.

### Streaming results from a multi-check (`onResult`)

A multi-check has no single "done" moment — any number of actors roll whenever they like — so instead of a Promise it takes an `onResult` callback, invoked on **every** roll completed on the card. `createRequest` also returns the created `ChatMessage` in `multi` mode, so you have a handle to read flags or correlate with the hook.

```js
const message = await game.pf1RollRequests.createRequest({
  type: "skill", key: "kna", dc: 18, mode: "multi", includeAid: true,
  flavor: "Identify Monster Components",
  onResult: ({ result, results, dc }) => {
    // `result` = the entry just rolled; `results` = every primary entry so far.
    // Both carry a computed `passed` (total >= dc, or null when no DC).
    const best = results.reduce((b, r) => (r.total > b.total ? r : b));
    console.log(`Best so far: ${best.actorName} rolled ${best.total} (${best.passed ? "pass" : "fail"})`);
  },
});
```

Callback payload: `{ messageId, rollType, result, results, aidResults, dc }`. `rollType` distinguishes primary multi rolls (`"multi"`) from Aid Another rolls (`"multiAid"`). The callback runs on the GM client that created the request (even when a player performs the roll); like `awaitResult` it is held in memory, so a GM reload mid-sequence drops it (the card and its stored results persist).

**Terminal event.** If the chat card is deleted, `onResult` fires one final time with `rollType: "cancelled"` and a `reason` (currently `"deleted"`), so you can tear down. This terminal payload is empty-shaped — `result: null`, `results: []`, `aidResults: []` — so always branch on `rollType` before reading the roll fields:

```js
onResult: (payload) => {
  if (payload.rollType === "cancelled") return; // or clean up; payload.reason tells you why
  // ...payload.result / payload.results are guaranteed populated here...
}
```

(A GM reload still drops the callback silently — there's no memory left to fire from — so `"cancelled"` covers deletion, not reload.)

## Registering Quick Actions

Other modules can contribute their own buttons to the **Quick Actions** category. The module decides entirely what the button does — this API only provides the slot and, optionally, the actor selection.

```js
game.pf1RollRequests.registerQuickAction({
  key: "my-mod-darkvision-check",   // required, unique
  label: "Darkvision Check",        // button label (defaults to key)
  icon: "fa-eye-low-vision",        // optional Font Awesome icon (default: fa-bolt)
  promptActors: true,               // optional: show the actor picker first (default: false)
  allActors: false,                 // optional: pass all eligible actors without prompting
                                    //           (default: false; ignored if promptActors is true)
  closeOnUse: false,                // optional: close the dialog afterwards (default: false)
  callback: ({ app, actors, event }) => {
    // app    — the RollRequestDialog instance (call app.close() to dismiss it,
    //          or app.getEligibleActors() for the full eligible list)
    // actors — [{ id, name, img }]: the picker selection (promptActors) or the full
    //          eligible list (allActors); null when neither option is set
    // event  — the originating click event
    myModule.doSomething(actors);
  },
});
```

The three actor-passing modes are mutually ordered: `promptActors` (show picker) takes precedence, then `allActors` (send everyone), otherwise `actors` is `null`.

- Register during the `ready` hook (or later) so `game.pf1RollRequests` exists.
- The `callback` may be async; it is awaited, and the dialog is closed afterward only if `closeOnUse` is `true` (you can also call `app.close()` yourself at any time).
- Registered actions appear in **Configure Roll Options** and can be hidden there like the built-ins.
- `game.pf1RollRequests.unregisterQuickAction(key)` removes one; `game.pf1RollRequests.getQuickActions()` returns the current list.

## Card Summaries (live aggregates)

A request can display a running aggregate line in its card — for example, a cumulative tally derived from every roll as results come in. Register a formatter and reference it by key on the request:

```js
// Register once (e.g. in your "ready" hook)
game.pf1RollRequests.registerSummary("monster-lore", (flags) => {
  const dc = flags.dc;
  let questions = 0;
  for (const r of Object.values(flags.rolledActors ?? {})) {
    if (dc != null && r.total >= dc) questions += 1 + Math.floor((r.total - dc) / 5);
  }
  return `<strong>Questions earned:</strong> ${questions}`;
});

// Then create a request that uses it
game.pf1RollRequests.createRequest({
  type: "skill", key: "kna", dc: 18,
  mode: "multi",
  summaryKey: "monster-lore",
});
```

- The formatter receives the card's current `flags` (including `rolledActors`, `dc`, `rollMode`, etc.) and returns an HTML string, or `""` for nothing. **Recompute from the results each call** rather than accumulating — the formatter runs on every roll, so it stays correct through re-rolls or deletions.
- The summary is recomputed and re-rendered automatically on every roll result.
- **Player visibility follows `showResults`**: when results are hidden from players (`showResults: false`), the summary is GM-only; when results are public, players see it too.
- The summary slot is present in all card types (single, multi-check, and targeted).
- `game.pf1RollRequests.unregisterSummary(key)` removes a formatter.

## Excluding targets from an auto-save request

An action's chat card lists the tokens it was used against in `message.system.targets`, and the [auto-save request](README.md#auto-save-requests) turns that list into the card's roll rows. Sometimes a token belongs in that list — other modules read it as "who this action was used against", for instance Little Helper's apply-damage sanity check — but should *not* be asked to roll the check.

Set `excludeTargets` in the module's flag scope on the message, and those uuids are skipped when the card is built:

```js
// At message-creation time (e.g. from an ActionUse pipeline):
chatData["flags.pf1-roll-requests.excludeTargets"] = [token.document.uuid];

// Or on an existing message:
await message.setFlag("pf1-roll-requests", "excludeTargets", [token.document.uuid]);
```

- Values are **token uuids**, matching the entries in `message.system.targets`.
- Applies to the automatic conversion only — it does not affect requests you create yourself with `createRequest`, where you pass the actor list directly.
- If every target is excluded, no request card is created at all.
- The module never asks *why* a target was excluded; the caller decides.

The motivating case is a thrown splash weapon: the token taking the direct hit is a genuine target of the action, but only the creatures caught in the burst roll the Reflex save.

## Hook

`pf1RollRequests.rollComplete` fires whenever a roll is completed on a request card, passing the message ID, roll type, result data, and updated flags.
