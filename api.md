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
  autoRoll: false,      // true = roll every target immediately, GM-side, no dialogs
});

// After setting any pending-result tracking, you can auto-roll all targets:
await game.pf1RollRequests.bulkRollTargeted(message);
```

`mode: "targeted"` pins one or more specific tokens to the card rather than letting any player roll — this is what the dialog's Selection Check and DM Check modes produce. It requires a non-empty `targetedActors`. Returns the created chat message.

Each `targetedActors` entry requires only `id` (the token document ID). All other fields are automatically resolved from the canvas token:

| Field | Auto-resolved from | Override effect |
|---|---|---|
| `tokenUUID` | `tokenDoc.uuid` | Use a different token document for actor/ownership lookup |
| `name` | `tokenDoc.name` | Show a different display name on the card |
| `img` | `tokenDoc.texture.src` (falls back to actor portrait) | Show a different portrait |
| `isHidden` | `tokenDoc.hidden` | Force a token visible or hidden on the card regardless of its canvas state |

`game.pf1RollRequests.bulkRollTargeted(message)` rolls all pending targets on a targeted card without a dialog, exactly like the Roll All button. Call it after any pending-result bookkeeping is in place. Pass `{ slot }` as a second argument to roll an [embedded request](#embedded-requests) instead of the card itself.

Passing `autoRoll: true` to `createRequest` does the same thing one step earlier — the card is posted and every target rolled before the call resolves, so the returned message's flags already carry the full results. Use `bulkRollTargeted` instead when you need to do something between posting the card and rolling it. Both are GM-side and dialog-free: the rolls execute on the GM's client regardless of who owns the token, which is also what **Roll All** does.

## Closing requests

```js
await game.pf1RollRequests.closeRequest(message);          // one card
await game.pf1RollRequests.closeRequest([msgA, msgB]);     // or several, in one broadcast
```

Deletes request cards that have served their purpose — a multi-step sequence that has finished collecting its rolls and written the outcome elsewhere, for instance. Accepts messages or message IDs, singly or as an array, and returns the IDs actually deleted (unknown ones are skipped).

Prefer this over deleting the messages yourself. `closeRequest` unregisters each card's `onResult` stream **before** deleting, so your handler does not receive the terminal `{ rollType: "cancelled", reason: "deleted" }` event for a request that in fact completed normally. Deleting directly always fires it. Any still-unresolved `awaitResult` promise resolves `null` either way.

Batching also matters cosmetically: one `deleteDocuments` call means a group of cards vanishes from players' logs at once rather than popping one at a time.

Call it from the resolution point — the awaited result, or the final `onResult` — rather than from a timer. Card updates run through a per-message queue, and resolving first guarantees it has drained. If a player happens to be mid-roll-dialog when you delete, their result arrives at a message that no longer exists and is logged and dropped.

### Closing without deleting (`lockRequest`)

```js
await game.pf1RollRequests.lockRequest(message);
```

Leaves the card exactly where it is and stops it accepting input. The roll and selection buttons disappear, a lock appears beside the title, and a click that races the re-render is refused with a notification. Use it where the card is worth keeping as a visible record — a re-pickable selection whose choices are now final, for instance.

Like `closeRequest` it unregisters the `onResult` stream first, so a locked request never delivers the terminal `cancelled` event. Any unresolved `awaitResult` promise resolves `null`, since the roll it was waiting on can no longer happen. Locking is one-way and idempotent; a locked card that is later deleted behaves like any other deleted message.

It also closes every [embedded request](#embedded-requests) on the card, and accepts a message that carries only embeds and no request of its own.

| | `closeRequest` | `lockRequest` |
|---|---|---|
| Card | deleted | stays, visibly locked |
| Buttons | gone with the card | hidden |
| Further results | impossible | refused |
| `onResult` | unregistered, no terminal event | unregistered, no terminal event |
| Batching | accepts an array | one card per call |

## Custom formulas and result tables

`type: "dice"` takes any valid roll formula as its `key`, not just a bare die:

```js
game.pf1RollRequests.createRequest({ type: "dice", key: "2d6+2", mode: "multi" });
```

The formula is validated when the request is created, so a typo surfaces on your call rather than on whichever player clicks the roll button.

### Mapping totals to labels

A `resultTable` maps the total onto a label, so the card shows **Banana** where it would otherwise show **2**:

```js
await game.pf1RollRequests.createRequest({
  type: "dice", key: "2d4-2", mode: "single",
  flavor: "Foraging",
  resultTable: [
    { label: "Nothing" },          // open-ended below — everything under the next min
    { min: 1, label: "Apple" },
    { min: 2, label: "Banana" },   // covers 2–3
    { min: 4, label: "Cherry" },
    { min: 5, label: "Everything" },  // open-ended above
  ],
  showTable: true,
});
```

Rows are **thresholds**, not explicit ranges: each row covers from its `min` up to the next row's `min - 1`, and the lowest row may omit `min` entirely. Two consequences worth knowing:

- **A table cannot contain a gap.** Writing `{min, max}` pairs by hand makes it easy to leave a value unmapped — the example above, expressed as "less than 0 / 1 / 2–3 / 4 / more than 5", silently drops **0** and **5**, two of the seven outcomes `2d4-2` can produce. Thresholds cover every value by construction.
- **Declaration order doesn't matter.** Rows are sorted when the request is created.

Non-integer totals (`1d6/2`) resolve fine. A total that somehow matches no row falls back to displaying the number.

Setting a table also forces `dc` to `null` — a mapped label has no numeric pass/fail — and suppresses the highest/average aggregate line, which would otherwise print an average of numbers that appear nowhere on the card.

Labels are rendered **unescaped**, so simple markup (`"<b>Cherry</b>"`) works.

### Displaying the table

`showTable: true` renders the whole table into the card: every row with its derived range, the rolled row highlighted, and the portrait of each actor who landed there appended to it. It recomputes on every roll, so the highlight maintains itself — no follow-up call needed. On a multi-check where several people roll, every matched row is highlighted and carries its own set of portraits.

| Option | Default | Effect |
|---|---|---|
| `showTable` | `false` | Render the table into the card |
| `clampTable` | `false` | Trim the open ends to the formula's reachable range — `≤0` → `0`, `5+` → `5–6` for `2d4-2` |

`clampTable` is off by default because a formula that can only reach part of its table should still display the table in full. Rows the formula cannot reach at all keep their open-ended form rather than rendering an inverted range.

On `publicblind` cards the highlight and portraits are GM-only while the table itself stays visible to everyone — otherwise the highlighted row would hand players the total the card is deliberately showing them as `?`.

The numeric roll is never lost: expanding a result row shows the full formula and dice breakdown as usual.

### Choosing instead of rolling

`selectFromTable: true` turns the card's roll into a **choice**. The die becomes a list button; clicking it opens a dropdown of the table's rows, and the picked row is recorded as that actor's result — same result row on the card, same `showTable` highlight and portrait, same `onResult` / `awaitResult` delivery.

```js
const message = await game.pf1RollRequests.createRequest({
  mode: "multi",
  flavor: "Choose your watch",
  selectFromTable: true,
  showTable: true,
  resultTable: [
    { label: "First watch" },
    { min: 1, label: "Second watch" },
    { min: 2, label: "Third watch" },
  ],
  onResult: ({ result }) => console.log(`${result.actorName} chose ${result.selectedLabel}`),
});
```

It requires a `resultTable` — that table is the list of choices — and works in `single`, `multi`, and `targeted` mode. Rows whose label is empty are not offered; labels carrying markup are flattened to plain text for the dropdown.

The result entry keeps the same shape as a rolled one, with three differences:

| Field | Value |
|---|---|
| `total` | The chosen row's threshold (`min`), so the table still maps it back to the label. The open-ended lowest row uses the value just below the next row's `min`. |
| `selectedIndex` / `selectedLabel` | The row picked, exactly — use these rather than re-deriving from `total`. |
| `rollData` / `formula` / `naturalRoll` | `null`. The result row has no expandable dice breakdown, because there are no dice. |

Because nothing is rolled, several roll-side behaviours drop out: `type` and `key` become optional (they default to an unused `dice` request, and the card is named from `flavor`), Aid Another is forced off, `clampTable` is ignored, trained-only and natural-20 feasibility gating do not apply, and no Dice So Nice animation fires. `showTable` also drops the range column, since the numbers behind the rows are bookkeeping rather than outcomes.

`autoRoll` and **Roll All** are unavailable on a selection card — every result is a person's deliberate choice, so there is nothing to fire on their behalf. Passing `autoRoll: true` logs a console warning and is ignored; `bulkRollTargeted()` returns without doing anything.

Dismissing the dropdown is treated exactly like cancelling a roll dialog: nothing is recorded and the actor can still choose later.

#### Changing a selection (`allowRepick`)

A pick is final by default, exactly like a roll. Set `allowRepick: true` to let it be changed for as long as the card is up: the button stays live after a choice, clicking it again reopens the dropdown on the current one, and confirming replaces the old entry in place. The card, the `showTable` highlight, and any summary all recompute from the new value.

```js
game.pf1RollRequests.createRequest({
  mode: "multi", flavor: "Choose your watch",
  selectFromTable: true, allowRepick: true, showTable: true,
  resultTable: [{ label: "First watch" }, { min: 1, label: "Second watch" }, { min: 2, label: "Third watch" }],
});
```

Re-picking is confined to the slot the clicker already filled — their own token in `single` and `multi` mode, and in `targeted` the target they were already allowed to roll for — so one player cannot overwrite another's choice. Everyone else still gets the usual "already used their action" warning.

Two consequences for consumers of a re-pickable request:

- **`onResult` fires again** for the same actor, carrying the new entry. Treat each payload as the current state of that actor's slot rather than a new participant — `results` still holds one entry per actor.
- **`awaitResult` resolves on the first pick only.** The promise is consumed at that point, so later changes are not delivered through it. Use `onResult` (or read the card's flags at the moment you need them) when a request is meant to stay open to changes.

Close the window for changes when it should end — while the card is live, `allowRepick` choices are editable by design. `closeRequest(message)` removes the card; [`lockRequest(message)`](#closing-without-deleting-lockrequest) leaves it up with the choices frozen, which is usually what you want when the picks themselves are the record.

## The description slot

`description` drops raw HTML into a slot near the top of the card, below the flavor line:

```js
const message = await game.pf1RollRequests.createRequest({
  type: "dice", key: "1d100", mode: "single",
  description: `<table><tr><td>01–50</td><td>Minor effect</td></tr>…</table>`,
});

// Later — e.g. once the roll is in, to highlight the row that came up
await game.pf1RollRequests.setDescription(message, updatedHtml);
```

It is **not escaped and not gated**: whatever you pass renders as-is and every player sees it. Intended for caller-supplied context — a lookup table you maintain yourself, a rules reminder, a link.

`setDescription(message, html)` replaces it on an existing card. It rebuilds and re-renders the card content, which a bare `setFlag` would not do — the card's HTML lives in `message.content`, regenerated from flags, so the flag and the content have to move together.

Note this is a different mechanism from a [card summary](#card-summaries-live-aggregates): a summary is a *registered formatter*, held in memory per-client, so a GM reload leaves the card without it. A description is stored on the message and survives reloads. Use a summary for something computed from results, a description for content you author.

`createRequest` returns the created `ChatMessage` in every mode, so you always have a handle for reading flags, correlating with `onResult` / the `rollComplete` hook, or later passing to `closeRequest`. It returns `undefined` only when the request was rejected — bad type, invalid formula, empty `targetedActors`, or a non-GM caller.

The one exception is `awaitResult: true` (single-check mode only), where it instead returns a Promise resolving with the roll result object once a player completes the roll, or `null` if the chat card is deleted before completion.

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

The three actor-passing modes are mutually ordered: `promptActors` (show picker) takes precedence, then `allActors` (send everyone), otherwise `actors` is `null`. The picker opens with nothing checked and offers **Select All** / **Select None** buttons; cancelling it, or confirming with an empty selection, aborts the quick action without invoking the callback.

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

## Embedded requests

A request normally *is* a card. It can instead be **embedded** — a live request placed inside a card another module owns, with neither module taking the other's card away from it.

This is a second, separate mechanism from the auto-save request that converts PF1 attack cards. That one works by rewriting `message.content`, which is right for converting a *finished* card once, and wrong for a host that redraws its card from its own flags on every render: the host's injections get snapshotted into the stored content and replayed forever, stale, and there is room for exactly one request per message. An embedded request **never reads or writes `message.content`**. Its state lives at `flags["pf1-roll-requests"].embeds.<slot>`, and it is drawn explicitly into an element the host supplies.

```js
// GM-side. Creates the request state; renders nothing by itself.
await game.pf1RollRequests.embed(message, {
  slot: "ce-crit-save",
  type: "save",
  key: "fort",
  dc: 22,
  mode: "targeted",
  targetedActors: [{ id: tokenDoc.id }],
  showDC: true,
  showResults: true,
  controls: false,
});

// Any client, from the host's own render hook, once its container exists.
await game.pf1RollRequests.renderEmbed(message, { slot: "ce-crit-save", into: element });
```

Two calls deliberately: **`embed()` owns state, `renderEmbed()` owns placement.** Because the host places the widget itself, from its own hook, after building the container, there is no hook-ordering dependency between the two modules and no retry loop.

| Call | Does |
|---|---|
| `embed(message, options)` | create the request state (GM only) |
| `renderEmbed(message, { slot, into })` | draw and bind it into `into`, replacing its contents (any client) |
| `getEmbed(message, slot)` | a copy of the slot's state, or `null` |
| `updateEmbed(message, slot, changes)` | patch state — a DC correction, a new target |
| `closeEmbed(message, slot, { lock })` | stop accepting rolls |
| `listEmbeds(message)` | the slot keys present on a message |

### Slots

A `slot` is the caller's key for one request on a host card. It is a flag key, so it must match `/^[\w-]+$/` — **no dots**, which Foundry would expand into nesting. Namespace it yourself, by convention, with something traceable to your module (`"ce-crit-save"`). Embedding onto a slot that already exists replaces it and logs a warning; a collision is never silent, but it is not prevented either.

### Options

`embed()` takes the `createRequest` option set minus the parts that are properties of *being a card*:

- no `flavor` or `description` — the host has its own header and prose;
- no `awaitResult` — a Promise held on one client dies on reload. Use the hook.
- `rollMode` is limited to `"roll"` and `"publicblind"`. The other two are whisper modes: they work by restricting who the *message* is delivered to, and an embed does not own the message. Passing one warns and falls back to `"roll"`; use `"publicblind"` to obscure the totals.

Two options are its own:

**`controls`** (default `true`). Setting it `false` strips the widget to its rows: no bulk action row (Roll All / Roll NPCs / Select All / Select Failed), no title, no GM mode footer. Those buttons exist because a whole-card request is usually a fireball against six tokens; an embedded one is usually a single target with a single row, where they are four buttons that each do what the one row already does. A `showDC` chip survives on its own, since a caller who asked for it meant it. `bulkRollTargeted(message, { slot })` stays available either way — suppressing the buttons is not the same as suppressing the capability.

**`mount`** — a CSS selector, resolved against the message's rendered element on this module's own render hook, to place the widget without a host hook of your own. A convenience path only: it can only find containers that already exist by the time our hook runs, and it skips silently when nothing matches. **Hosts that draw their card from flags should use `renderEmbed`.**

### Re-rendering

A roll writes to `flags["pf1-roll-requests"].embeds.<slot>.actorResults` and stops. Foundry re-renders the message, the host's render hook fires, the host rebuilds its block and calls `renderEmbed` again. No content update, no second re-render, and the host's own state and the request's stay independent.

Permissions are unchanged. `embed()` is GM-gated exactly like `createRequest`, and a player's roll crosses the existing socket to the GM — still the only writer to the message, and still serialised per message, so two embeds on one card cannot clobber each other.

### Results

`pf1RollRequests.rollComplete` carries **`slot`** in its payload, `null` for a whole-card request. Existing listeners that ignore it keep working; a host filters on it to pick out its own embed. `onResult` is accepted per embed and carries `slot` too, with the same caveat it already has: it lives in memory on the creating client, so a reload drops it. The hook is the durable channel.

### Closing

```js
await game.pf1RollRequests.closeEmbed(message, "ce-crit-save");                // remove the slot
await game.pf1RollRequests.closeEmbed(message, "ce-crit-save", { lock: true }); // keep the results
```

By default the slot is removed outright — the counterpart to `closeRequest`, for a request that has served its purpose. `renderEmbed` on a removed slot empties the container and returns `null`. With `lock: true` the state stays and is marked closed instead: the results remain on the host's card as a record, the roll buttons disappear, and a click racing the re-render is refused. Either way the slot's `onResult` stream is unregistered first, so a consumer never gets a terminal `"cancelled"` event for a request that completed.

`lockRequest` on the *host* message closes every embed on it as well — a card that stops accepting rolls should not still be handing them out. Deleting the message (or `closeRequest`) fires the terminal `"cancelled"` event on every stream it carried, each tagged with its own `slot`.

## Hook

`pf1RollRequests.rollComplete` fires whenever a roll is completed on a request card, passing the message ID, the `slot` (`null` unless the roll was on an [embedded request](#embedded-requests)), roll type, result data, and updated flags.
