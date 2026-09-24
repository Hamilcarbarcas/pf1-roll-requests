# PF1 Roll Requests

A Foundry VTT module for the PF1e system that lets the GM request rolls from players via interactive chat cards.

**Manifest URL:** `https://github.com/Hamilcarbarcas/pf1-roll-requests/releases/latest/download/module.json`

## Requirements

- Foundry VTT v13
- PF1e system v11.10

## Features

### Roll Request Dialog

A GM-only dialog accessed via the dice button in the token controls toolbar, or by calling `game.pf1RollRequests.requestRoll()` from a macro.

![Request window](assets/request-roll-window.png)

The dialog lets you select:

- **Check type** — Ability checks, saving throws, skill checks, or raw dice
- **Mode** — Single-check, multi-check, selection-check (prompt specific actors), token check (prompt your selected tokens), or DM check (auto-roll for your selected NPCs)
- **DC** — Optional; can be shown or hidden from players
  - **Allow un-passable checks** — By default an actor who cannot reach the DC even on a natural 20 is blocked from rolling. Tick this to let them roll anyway (this also lifts the aid requirement below). Trained-only skills without ranks are still blocked (see below).
- **Roll mode** — Public, GM-only, or blind roll.
- **Result visibility** — Whether pass/fail indicators are shown to players
- **Aid Another** — Whether other players can aid (single-check mode only; forced off for saves and dice)
  - **Ignore aid requirement** — By default an aider must themselves be able to succeed on the check to aid. Tick this to let anyone attempt Aid Another regardless (also implied by *Allow un-passable checks*).
- **Flavor text** — Optional line shown on the chat card beneath the title. The title itself always names the check being rolled.

#### Prompt Actors (Selection Check)

In **Selection Check** mode a checklist of actors appears. It is rebuilt each time the dialog opens from two sources:

- **Configured player characters** — every non-GM user's assigned character (including offline players). Always listed.
- **Player-owned NPCs** — NPC-type actors that a player owns (Owner permission) and that have a *linked* token on the scene you are currently viewing. These cover cohorts, animal companions, familiars, and similar — no per-actor setup is needed beyond the ownership you already grant. Rows from this source are marked with a paw icon. If no scene is active, none are added.

To hide a player-owned NPC you don't want prompted, **right-click its row** and choose **Exclude from List**. Excluded actors are stored per-world and can be reviewed or restored under **Settings → Module Settings → Manage Excluded Actors**.

#### Token Check

**Token Check** posts the same per-target card a Selection Check does, but takes its targets from the tokens you have **selected on the canvas** rather than from the checklist. There is no list to tick — select the tokens, pick the check, click **Request Roll**.

Because the card is built from tokens rather than actors, unlinked duplicates of the same actor each get their own row and result, and each row can be rolled by whoever owns that token (the GM can roll any of them). Any token type is eligible, not just NPCs. Aid Another, the DC, and the roll mode all work exactly as they do for a Selection Check — the difference is only where the target list comes from. Cards are tagged `[Token Check]`.

#### Target Preview (Token Check / DM Check)

Both canvas-driven modes show a read-only list in the slot the Prompt Actors checklist occupies, naming the tokens the request will go to — portrait and token name per row. **Token Check** lists every selected token; **DM Check** lists only the selected NPC tokens, which is the subset it will actually roll for. The list follows the canvas live, so selecting or deselecting tokens with the dialog open updates it immediately, and it reads *No tokens selected* when there is nothing to send to.

### Chat Cards

![Chat Message](assets/request-roll-chat-message-blank.png) 

![Chat Message Filled](assets/request-roll-chat-message-completed.png)

**Single-check mode:** One player rolls the primary check. Other players can contribute Aid Another rolls (DC 10) that add +2 each to the primary roll's total, if enabled. Results update in real time. Aid already banked toward the check counts toward the feasibility gate below, so an actor who couldn't reach the DC alone but can *with* the accumulated aid is allowed to roll.

**Feasibility & training gates:** When a DC is set, an actor who cannot reach it even on a natural 20 is blocked from rolling (override per-request with **Allow un-passable checks**). Independently, a trained-only skill cannot be rolled without ranks — with one rules-as-written exception: a **Knowledge** check of **DC 10 or lower** may be attempted untrained. The training gate is never lifted by *Allow un-passable checks*.

**Multi-check mode:** Any number of players can each roll independently. Each result is appended to the card as it comes in.

**DM check mode:** For quickly resolving a check across a group of NPCs — e.g. having a room full of guards roll Perception. Select the NPC tokens on the canvas, pick the check, and click **Request Roll**: the module immediately rolls for every selected NPC (no dialogs, no player interaction) and posts a single card listing each result. Each selected token rolls independently, so unlinked duplicates of the same actor each get their own line. Aid Another is disabled, and the roll mode automatically switches to **Private GM Roll** when you select this mode (your previous roll mode is restored if you switch to another mode). You can still override the roll mode afterward — for example set it to Public if you want the party to see the results. When [pf1-token-randomizer](https://github.com/Hamilcarbarcas/pf1-token-randomizer) is active, NPC names on the card respect its obscured-name setting, so players see the obscured name (and the GM/observers see the real one).

Every request card tags its title with the check mode — `[Single Check]`, `[Multi-Check]`, `[Selected Check]`, `[Token Check]`, or `[DM Check]` — so the kind of check is clear at a glance. (Auto-generated saving-throw cards are left untagged.)

The GM always sees the DC and pass/fail results. Players see them only if the GM enabled visibility for that request.

**Result aggregate:** On multi-check and selection-check cards, an optional line below the title/DC can show the running **highest** or **average** of the roll totals, updating live as results arrive (it appears once more than one result is in). Choose *None* (default), *Average result*, or *Highest result* under **Settings → Module Settings → Multi-Check Result Aggregate**. The average is rounded to the nearest whole number, and the line follows the same visibility as the totals themselves — the GM always sees it, and players see it unless the card hides totals (obscured/blind rolls).

**Rolling without a selected token:** Clicking a roll button rolls for your currently selected token. By default, when no token is selected it instead rolls for the actor set in your User Configuration; the GM can disable this under **Settings → Module Settings → Use Configured Actor When None Selected**, in which case clicking with no token selected warns you to select one. This does not affect per-target roll buttons on targeted cards, which are always tied to a specific token.

**Skipping the roll dialog:** Clicking a roll button on a request card opens PF1's roll dialog, where you can add situational bonuses or change the roll mode before rolling. **Shift-click** skips the dialog and rolls straight away. Each user can flip this under **Settings → Module Settings → Skip Roll Dialog on Request Cards**: with it on, a plain click rolls straight away and Shift-click opens the dialog. The setting is per user, so it follows you to any computer you log in from. Aid Another bonuses already banked on the card are added to the roll either way. This covers the Roll and Aid Another buttons on every request card; selection requests (pick from a list) and raw-formula rolls have no dialog to skip.

#### Apply Roll

For when the roll already happened — a player rolled Perception on their sheet before the request went up, or an NPC's save was rolled by hand. **Apply Roll** records that existing chat roll on the request as though it had been rolled there: same total, same formula, same expandable dice breakdown, with the request's own effect notes filled in. GM-only, in both directions.

There are two ways in:

- **From the card** — the **Apply Roll** control in the card's GM footer opens a list of the eligible rolls in the chat log, newest first. Tick as many as you like and apply them together, which is the quick way to fill a targeted card where several targets have already rolled.
- **From the roll** — right-click the roll in chat and choose **Apply to Roll Request**. When only one open request fits it applies immediately; when several do, you pick which.

A roll is only offered where it genuinely matches. The check must be the same one the request asks for — an unrelated `/r 1d20` is never a candidate — and the roller must have a slot on that request. Targeted cards route the roll to the row whose token made it; single and multi cards route it to the primary slot or to that token's own. An actor with no place on the request simply doesn't appear.

If the slot already holds a result, you're asked before it's replaced. Where a card offers Aid Another and both slots are free, you choose whether the roll counts as the check or as an aid attempt; aid already banked on the card is folded into an applied check as a real term on the roll, so the breakdown still adds up to the total shown beside it. Applied rows carry a small mark, visible to the GM only, naming where the roll came from.

Requests that roll a raw formula and selection requests take no applied roll — neither has a check type to match against.

**Settings → Module Settings → Delete Roll After Applying** additionally deletes the roll's original chat message once it has been applied. Off by default: the delete can't be undone, and that message is the only record of a roll the players watched happen. It runs only after the result is recorded, so a cancelled apply never removes anything.

### Auto Save Requests

![Chat Message Filled](assets/auto-save-request.png)

When a PF1e attack action that includes a saving throw is posted to chat, the module automatically converts it into an embedded targeted roll-request card. PF1's own card is kept around it intact — damage buttons, effect notes and all.

PF1 puts its save button inside *every* attack entry on the card, because each hit forces its own save. The conversion follows suit: a spell with two damage entries, or a full attack with three attack rolls, gets its own request above each entry, so a target's save against the second hit is recorded separately from its save against the first. Each request keeps its own results, **Roll All** / **Roll NPCs**, and **Apply Roll**.

A one-target request opens that target's defenses dropdown by itself only where the dropdown has something to answer: it must be the card's first request *and* sit on an entry that rolled an attack. On the requests below it, that would be the same creature's defenses repeated down the card; on a save-only entry — a spell that rolls damage and calls for a Reflex save, with no attack roll anywhere on the card — there is no hit to read the defenses against in the first place. Both start collapsed, and one click opens either.

This feature is enabled by default and can be toggled in **Settings → Module Settings → Auto-Request Saving Throws**.

PF1's own **Reflex DC 15** button inside each attack entry keeps working, and now feeds the request above it. Roll a save from it and the result is recorded on that entry's request automatically — same total, same breakdown, same pass/fail mark as a save rolled on the card itself. One click still rolls for every token you have selected, so each of them fills its own row. This only happens where it fits: the roller must have a row on that request and not have filled it yet. A save by a creature the action never targeted is left alone, and so is a reroll for a row that already has a result — replacing one stays a deliberate act through **Apply Roll**. Note that **Delete Roll After Applying**, if you have it on, applies here too: the save's own chat card is removed once it lands on the request.

Another module can leave a specific target off the generated card while keeping it in the action's target list — see [`excludeTargets`](api.md#excluding-targets-from-an-auto-save-request) in the API reference.

#### Replacing Every Target List

**Settings → Module Settings → Replace All Target Lists** extends the conversion to actions that have no saving throw and no configured check — a plain attack, say. The card gets the same list PF1's own target boxes would have occupied: portraits, names, the defenses dropdown, the canvas hover and click, and **Select All**. There is nothing to roll, so there is no roll button, no **Roll All** / **Roll NPCs**, and no **Select Passed** / **Select Failed** — those partition a set of results the card will never have.

Off by default, and it requires **Auto-Request Saving Throws** to be on. Only lists PF1 actually drew are replaced.

#### Skill & Ability Check Actions

The same auto-request pipeline can be driven by a **skill check** or **ability check** instead of a saving throw. On any item action's **Saving Throw** tab, the **Type** dropdown now includes **Skill Check** and **Ability Check** alongside Fortitude / Reflex / Will:

- Selecting **Skill Check** reveals a skill picker and a DC field.
- Selecting **Ability Check** reveals an ability picker and a DC field.
- The DC accepts a formula (resolved against the acting actor at roll time), just like a save DC. A plain number works too.
- An optional **Check Effect** note mirrors the save's effect description.

A check is **mutually exclusive** with a saving throw on the same action — the Type field holds one choice. When the action is used against targets, it produces the same embedded targeted roll-request card that saves do (per-target rows, Roll All / Roll NPCs, pass/fail against the DC, etc.), and the same standalone check button PF1 gives saves — a "Strength DC 15" button in the card footer that rolls the check for your selected token. The configuration is stored on the item, so it travels with copied/imported items.

From a player's perspective the card is indistinguishable from a saving throw — same button, same placement, same behaviour — it simply rolls the chosen skill or ability check instead of Fort/Ref/Will. There is no Aid Another on these checks (matching saves), and every target can always roll regardless of ranks or feasibility (again, matching saves).

**GM view:**

- Each targeted token gets a compact row with their portrait, name, and a roll button.
- **Roll All** — rolls the saving throw for every unrolled target, skipping the roll dialog. Present on every targeted card, not just auto-generated saves: selection, token and API-created cards get the same pair. (A one-target card keeps **Roll All** — the per-row button opens the roll dialog and this one never does — but drops **Roll NPCs**, which has nothing to partition.)
- **Roll NPCs** — like Roll All, but skips any NPC token that an active player has ownership of (so player-owned creatures roll themselves).
- **Select All / Select Passed / Select Failed** — canvas token-selection shortcuts that highlight the relevant tokens based on current results.
- Hovering a target's portrait or name highlights that token on the canvas, the same way PF1's own target boxes do. Clicking the portrait selects it.
- Clicking a target's **row** expands a collapsible dropdown. Before a roll it shows that creature's defenses; after a roll it shows the roll breakdown on top with the defenses below. Defenses include AC / touch / FF AC, CMD / flat-footed CMD, all three saving throws, plus spell resistance, damage reduction, energy resistance, active conditions, and any AC / CMD / save notes. The stats are labelled with the same icons PF1 uses in its target boxes — shield for AC, pointing hand for touch, shoe-prints for flat-footed, and PF1's own heart / arrow / brain for Fortitude / Reflex / Will. The two CMD stats take a leading fist to mark them out from AC, keeping PF1's shield and shoe-prints as their second glyph. Hover any of them for the full name. Each stat's glyph and value is coloured — red for AC, CMD and Fortitude, blue for touch AC and Will, green for flat-footed AC, flat-footed CMD and Reflex — with the AC row darkest and the saves row lightest, so a colour names the defense and its depth names the row.
- With **[PF1 Combat Maneuvers](https://github.com/Hamilcarbarcas/pf1-combat-maneuvers)** installed, the **CMD row becomes expandable** whenever a maneuver's CMD differs from the creature's general CMD. It starts collapsed and looks exactly as it does without the module, so nothing changes until you open it. Expanding lists one row per deviating maneuver — the maneuver's own icon in place of the CMD shield, with the maneuver-specific CMD and flat-footed CMD beside it. Hovering either names both the maneuver and the defense — "Trip CMD", "Trip Flat-Footed CMD" — since the icon already says which maneuver the row is. Maneuvers that match the baseline are left out; they would only restate the number already above them. Without the module the row is an ordinary one, unchanged.
- Clicking one of the **three saving throws** rolls it for that token straight away, posting PF1's normal save card. NPCs roll through without the dialog; a player-owned actor gets PF1's roll dialog so situational bonuses can be added. Hold **Shift** to invert that either way. Only actors you own are clickable, since PF1 refuses the roll otherwise. The roll uses your current roll mode, so set that first if an NPC's save shouldn't be public.
- The dropdown's **Defenses** heading posts PF1's own defenses card to chat, whispered to you — the same card PF1's target boxes produce when you click a target's AC. It appears as a link only for actors you own, since PF1 refuses the card otherwise.
- When there is only one target, all bulk and selection buttons are suppressed (no point in Roll All or Select Passed with a single token), and that target's dropdown is expanded from the start.

**Player view:**

- Tokens the player has at least Observer permission on appear as normal rows with a roll button. Clicking the token's **row** expands the same dropdown available to the GM (defenses, plus the roll breakdown once rolled), and hovering the portrait or name highlights the token on the canvas. A player seeing exactly one row gets it expanded from the start.
- Tokens the player can see but lacks Observer permission on appear as a compact centered portrait grid (names and results hidden).
- Tokens that are hidden from the player are removed from the card entirely.

#### Quick Actions

An optional **Quick Actions** category at the bottom of the options grid holds common, pre-configured rolls. Unlike the other categories, clicking a Quick Action **executes immediately** with its own baked-in settings — it ignores the left-hand panel and does not wait for the **Request Roll** button. This category can be enabled or disabled in the mod settings.

Available Quick Actions:

- **Spot Checks** — prompts a Perception check from selected actors. Opens an actor picker (the same list as Prompt Actors, nothing checked to start, with **Select All** / **Select None** buttons below the list), then posts a **public** request card whose roll totals are hidden from players (the GM sees them), with no DC and no Aid Another.
- **Quick Perception** — the same Perception check, taken from the tokens **selected on the canvas** instead of a picker (a Token Check, in effect). A small popup asks for a **DC** and **flavor text** first; both are optional, so clicking **OK** on an empty form is a normal use. The card is public with totals hidden from players, and has no Aid Another. Any DC you enter is used for the GM's pass/fail marks only — it is not shown to players, and nobody is blocked from rolling a check they cannot pass.
- **Monster Lore** — opens the Monster Lore window (see below) instead of posting a card directly, and closes the Roll Request dialog.
- **Opposed Check** — opens the Opposed Check window (see below) instead of posting a card directly, and closes the Roll Request dialog.

Custom quick actions can be made via the mod API.

#### Monster Lore

A GM-only window (opened from the **Monster Lore** Quick Action) for running a Knowledge check to identify a monster. Pick a **monster type**, **CR**, and **rarity** (Common/Normal/Rare); a reference monster can be set by selecting a token or dragging an actor onto the drop zone (auto-filled on open from a single selected token), which auto-populates **CR** and **creature type** — sync re-pulls, clear removes it.

The type selects the relevant Knowledge skill — Arcana (constructs, dragons, magical beasts), Dungeoneering (aberrations, oozes), Local (humanoids), Nature (animals, fey, monstrous humanoids, plants, vermin), The Planes (outsiders), Religion (undead). **Request Knowledge Checks** then fires a **public multi-check** (Aid Another off); DC = rarity base (5/10/15) + CR (fractional CRs count as 1), hidden from players while results are public.

The card shows a live **"Questions earned"** tally (via the card-summary system): each passing check earns 1 question, +1 per full 5 by which it beats the DC, tallied across the party as results come in.

#### Opposed Check

A GM-only window (opened from the **Opposed Check** Quick Action) for contests decided by comparing two rolls rather than by a DC.

Pick a **contest** from the list:

| Contest | Initiator rolls | Responder rolls |
| --- | --- | --- |
| Stealth vs. Perception | Stealth | Perception |
| Bluff vs. Sense Motive | Bluff | Sense Motive |
| Disguise vs. Perception | Disguise | Perception |
| Forgery (Linguistics) | Linguistics | Linguistics |
| Strength vs. Strength | Strength | Strength |

(Escape Artist has no entry: it is rolled against the binder's CMD, which is a static number rather than a roll.)

Below the contest, every token on the current scene is listed — hidden ones included, marked with an eye-slash. Click a token to assign it to a side; click it again to free that side. The two sides are shown above the list with the check each one will roll, and the **swap** button between them flips the assignment. If you had two tokens selected (or targeted) when you opened the window, they are assigned for you. The **roll mode** and **flavor text** work as they do in the main dialog.

**Request Opposed Roll** posts a two-row card. Each row rolls its own half of the contest — the check it rolls is printed beside the name — and the card carries no DC, so there are no pass/fail marks. Once both rolls are in, the card names the winner in a banner and marks the winning row with a crown. The banner and crown follow the same visibility as the rest of the card's results: on a card whose results are hidden from players, only the GM sees who won.

Ties follow the book: the higher check modifier wins, and if those are also equal the card reports a **dead tie** and calls for a reroll.

The card behaves like any other targeted card otherwise — **Roll All** / **Roll NPCs**, portrait hover highlighting, and **Apply Roll** all work, and Apply Roll matches each row against that row's own check rather than the card's.

#### Configuring Roll Options

Under **Settings → Module Settings → Configure Roll Options** you can show or hide:

- **Whole categories** — Ability Checks, Saving Throws, Skill Checks, Dice, and Quick Actions.
- **Individual Quick Actions** — toggle each entry on or off (applies only while the Quick Actions category is shown).

### Custom Formulas & Result Tables

*API only — there is no dialog control for these.*

A request can roll an arbitrary formula (`2d6+2`, `2d4-2`) rather than a check, and map the total onto a **label** instead of a number: roll `2d4-2` and the card reports *Banana* rather than *2*. The table is written as a list of thresholds, so it can never leave a value unmapped, and it can optionally be rendered into the card in full — every possible outcome with its range, the rolled row highlighted, and the portrait of each actor who landed there. The underlying roll is never hidden; expanding the result row shows the formula and dice as usual.

A table can also be **chosen from instead of rolled on**. With `selectFromTable`, the card's die becomes a list button: clicking it opens a small dropdown of the table's outcomes, and the pick is recorded exactly as a roll would be — same result row, same live table highlight, same portrait. Useful when the party is picking something rather than leaving it to chance (who takes which watch, which door each character opens) but you still want it collected on one card. Available in every check mode. A pick is final by default; requests can opt into `allowRepick`, which keeps the button live so a choice can be changed while the card is up — but only your own, so nobody can change someone else's.

A card can also carry a free-form **description** — raw HTML shown to every player, useful for dropping in a reference table of your own — which can be replaced after the roll to highlight what came up.

See **[api.md](api.md#custom-formulas-and-result-tables)**.

### API

Other modules and macros can drive Roll Requests programmatically — creating requests (including auto-rolled and custom-formula ones), streaming multi-check results, closing finished cards, and registering Quick Actions, card summaries, and hooks. See **[api.md](api.md)** for the full developer reference.

A module can also **[embed a live request inside a chat card it owns](api.md#embedded-requests)** — a save sitting in the middle of another module's card, rolled and reported like any other request, with neither module taking the other's card away from it.
