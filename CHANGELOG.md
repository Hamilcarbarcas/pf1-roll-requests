# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **DM Check mode.** A new check mode for quickly resolving a check across a group of NPCs. Select the NPC tokens on the canvas, pick a check, and the module auto-rolls for every selected NPC (dialog-free, GM-side) and posts one card listing each result. Each token rolls independently so unlinked duplicates of one actor each get their own line. Aid Another is disabled and the roll mode defaults to Private GM Roll while the mode is selected (your prior roll mode is restored when you switch back to another mode); you can still override it to reveal results to players.
- **Obscured NPC names on targeted cards.** When [pf1-token-randomizer](https://github.com/Hamilcarbarcas/pf1-token-randomizer) is active, NPC token names shown on targeted/DM-check cards are run through its obscured-name gate, so non-observing players see the obscured name while the GM and observers still see the real one. No effect when the module isn't installed.
- **Check-kind label in the card title.** Request cards now show a small tag after the title indicating the check mode — `[Single Check]`, `[Multi-Check]`, or `[Selected Check]`. Auto-generated saving-throw cards are left untagged.
- **Custom roll formulas (API).** A `dice` request's `key` accepts any valid roll formula — `2d6+2`, `2d4-2` — not just a bare die. Formulas are validated when the request is created, so a typo surfaces on the GM's call rather than on whichever player clicks the roll button.
- **Result tables (API).** A request can carry a `resultTable` that maps the roll's total onto a label, so a card rolling `2d4-2` reports *Banana* instead of *2*. Rows are thresholds — each covers from its `min` up to the next row's `min - 1` — so a table cannot leave a value unmapped, and row order doesn't matter. With `showTable` the whole table renders into the card: every outcome with its range, the rolled row highlighted, and the portrait of each actor who landed there, updating live as results arrive. `clampTable` optionally trims the open ends to what the formula can actually roll (off by default, so a table larger than its formula still shows in full). The roll itself is never hidden — expanding a result row shows the formula and dice as usual. Setting a table forces the DC to null and suppresses the highest/average aggregate line, neither of which is meaningful for a mapped result. See [api.md](api.md#custom-formulas-and-result-tables).
- **Card description slot (API).** Requests take a `description` of raw, unescaped HTML, rendered near the top of the card and visible to every player — for dropping in a reference table or a rules reminder of your own. `game.pf1RollRequests.setDescription(message, html)` replaces it on an existing card and re-renders in place, so it can be swapped after a roll to highlight the result.
- **`game.pf1RollRequests.closeRequest()` (API).** Deletes one or more request cards that are no longer needed, taking messages or IDs singly or as an array. It unregisters each card's `onResult` stream first, so a consumer doesn't receive the terminal `"cancelled"` event for a request that actually completed, and removes a batch in a single broadcast so the cards vanish together rather than one at a time.
- **`excludeTargets` opt-out for auto-save requests.** A module or macro can set `flags["pf1-roll-requests"].excludeTargets` to a list of token uuids on an action's chat card, and those tokens are left off the generated roll-request rows even though they remain in `message.system.targets`. This keeps that field meaning "tokens this action was used against" — which other modules rely on — while letting a caller say a particular target shouldn't roll the check. The motivating case is a thrown splash weapon, where the token taking the direct hit is a real target of the action but only the creatures in the burst roll the Reflex save. See [api.md](api.md#excluding-targets-from-an-auto-save-request).

### Documentation
- **`autoRoll`, `targetedActors`, and `mode: "targeted"`** are now documented in [api.md](api.md#creating-requests) and in `createRequest`'s JSDoc. All three already worked; only the reference was missing them.

### Changed
- **`createRequest` always returns the card.** It previously returned the created `ChatMessage` only in `multi` and `targeted` modes and `undefined` for a single-check without `awaitResult`, leaving no handle for reading flags or closing the card afterwards. It now returns the message in every mode, and `undefined` only when the request was actually rejected. `awaitResult: true` still returns its result Promise instead.
- **Aid counts toward the feasibility gate.** The natural-20 feasibility check now adds the aid already banked toward a check before deciding whether the primary roller can succeed, so an actor who couldn't reach the DC alone but can with aid is no longer blocked.
- **Untrained Knowledge at low DCs.** A Knowledge check of DC 10 or lower can now be attempted without ranks, matching the rules-as-written exception; other trained-only skills (and Knowledge above DC 10) still require ranks.
- **Allow un-passable checks.** A DC sub-option that lets actors roll even when they cannot reach the DC on a natural 20 (the default behaviour still blocks them). Also lifts the aid requirement, so anyone may aid such a check. Trained-only skills without ranks stay gated.
- **Ignore aid requirement.** An Aid Another sub-option that lets anyone attempt to aid even when they couldn't succeed on the check themselves (the default still requires an aider to be able to make the check).
- **Skill & ability check actions.** An item action's **Saving Throw → Type** dropdown now offers **Skill Check** and **Ability Check** in addition to Fortitude / Reflex / Will. Picking one reveals a skill/ability picker, a DC field (formula-capable, like a save DC), and an optional effect note. Using the action against targets produces the same embedded targeted roll-request card that saving throws do — including a standalone check button in the card footer mirroring PF1's native save button (rolls the check for your selected token). From a player's perspective the card is indistinguishable from a saving throw: same button, placement, and behaviour, with no Aid Another and every target always able to roll. A check is mutually exclusive with a save on the same action, and the config is stored on the item so it travels with the item. Honours the existing **Auto-Request Saving Throws** setting.

## [1.2.0] - 2026-07-17

### Added
- **Monster Lore window.** A Knowledge-check helper, opened from the new **Monster Lore** Quick Action. Pick a creature type (auto-selects the relevant Knowledge skill), CR, and rarity — or drag/select a reference token to auto-fill CR and type — then fire a public multi-check whose DC is hidden from players. The card shows a live "Questions earned" tally that grows as party members pass.
- **Result aggregate on multi/selection cards.** A new **Multi-Check Result Aggregate** setting can show the running **highest** or **average** of the roll totals at the top of multi-check and selection-check cards, below the title/DC. It updates live as results come in and follows the same visibility as the individual totals. Default is off.

### Changed
- All user-facing text (settings, menus, dialogs, chat cards, Monster Lore window, defenses panel, notifications) is now localizable via `game.i18n` (English `lang/en.json` included).
- Reordered the module settings and adjusted several defaults for a clearer configuration flow.
- Reorganized the module's source into a `src/` directory (`src/module`, `src/templates`, `src/styles`); the packaged release layout and manifest paths were updated to match.

## [1.1.0] - 2026-06-30

### Added
- **Targeted check mode.** Request a check for specific targets, with results matched per-target. Blind rolls are properly obfuscated so players only see what they should, and save-request embeds include defensive info for the relevant target.
- **Quick Actions.** New Quick Actions section in settings for one-click common requests, a built-in Spot Checks action, and API support for adding your own buttons.
- **NPC support.** Player-owned NPCs now appear in the actor selection list, with a new NPC blacklist to hide specific NPCs.
- **Saving throws.** Chat messages that include a saving throw can carry a roll request directly, and saving-throw requests can be attached to existing chat messages.
- **Aid Another.** Multi-check requests now support Aid Another.
- **Roll options & summaries.** New Roll Options configuration for finer control over what is displayed in the request window, plus a summary registry across all roll modes (also exposed through the API).
- Expanded public API: callbacks for multi-request flows, quick actions, summary registry, and roll options.

### Changed
- Reworked ownership detection for non-save requests.
- Project renamed to PF1e; module title updated and manifest link added.
- Aid Another rules updated to match Pathfinder core, with an optional house-rule setting granting +1 for every 5 points a check exceeds 10.
- Updated README.

### Fixed
- Automatic cleanup when a request card is deleted, so no orphaned multi-request state is left behind.

## [1.0.2] - 2026-03-28

### Changed
- README updates.

## [1.0.1] - 2026-03-28

### Added
- Toggle option in module settings for the sidebar button.

## [1.0.0] - 2026-03-28

### Added
- Initial release.
