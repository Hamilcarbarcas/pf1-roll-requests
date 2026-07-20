# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
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
