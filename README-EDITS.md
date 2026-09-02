# README Edits — pending review

Log of changes to user-facing docs and to setting hint/tooltip prose. Delete an
entry once reviewed. Never rewritten wholesale — new entries append at the end.

---

## 2026-09-02 — Defenses icons, token hover, actor art

### `README.md` — GM view, targeted card

Before:

> - Clicking any token portrait selects that token on the canvas.
> - Clicking a target's **row** expands a collapsible dropdown. Before a roll it shows that creature's defenses; after a roll it shows the roll breakdown on top with the defenses below. Defenses include AC / touch / FF AC, CMD / flat-footed CMD, all three saving throws, plus spell resistance, damage reduction, energy resistance, active conditions, and any AC / CMD / save notes.

After:

> - Hovering a target's portrait or name highlights that token on the canvas, the same way PF1's own target boxes do. Clicking the portrait selects it.
> - Clicking a target's **row** expands a collapsible dropdown. Before a roll it shows that creature's defenses; after a roll it shows the roll breakdown on top with the defenses below. Defenses include AC / touch / FF AC, CMD / flat-footed CMD, all three saving throws, plus spell resistance, damage reduction, energy resistance, active conditions, and any AC / CMD / save notes. The stats are labelled with the same icons PF1 uses in its target boxes — shield for AC, pointing hand for touch, shoe-prints for flat-footed, and PF1's own heart / arrow / brain for Fortitude / Reflex / Will. The two CMD stats take a leading fist to mark them out from AC, keeping PF1's shield and shoe-prints as their second glyph. Hover any of them for the full name.

### `README.md` — Player view, targeted card

Before:

> - Tokens the player has at least Observer permission on appear as normal rows with a roll button. Clicking the token's **row** expands the same dropdown available to the GM (defenses, plus the roll breakdown once rolled).

After:

> - Tokens the player has at least Observer permission on appear as normal rows with a roll button. Clicking the token's **row** expands the same dropdown available to the GM (defenses, plus the roll breakdown once rolled), and hovering the portrait or name highlights the token on the canvas.

### `api.md` — `targetedActors` auto-resolution table

Before:

> | `img` | `tokenDoc.texture.src` (falls back to actor portrait) | Show a different portrait |

After:

> | `img` | `tokenDoc.actor.img` (falls back to the token texture) | Show a different portrait |

### `lang/en.json` — defenses panel stat labels

These strings moved from visible labels to tooltips, so the abbreviations were
expanded to full names. `RR.Def.SR` is unchanged — spell resistance has no
system glyph and keeps a written label on the card.

| Key | Before | After |
|---|---|---|
| `RR.Def.AC` | `AC` | `Armor Class` |
| `RR.Def.Touch` | `Touch` | `Touch AC` |
| `RR.Def.FF` | `FF` | `Flat-Footed AC` |
| `RR.Def.CMD` | `CMD` | `Combat Maneuver Defense` |
| `RR.Def.FFCMD` | `FF CMD` | `Flat-Footed CMD` |
| `RR.Def.Fort` | `Fort` | `Fortitude` |
| `RR.Def.Ref` | `Ref` | `Reflex` |
| `RR.Def.Will` | `Will` | `Will` (unchanged) |

### `CHANGELOG.md` — three new entries under Unreleased → Changed

New text, no prior version: the defenses icon swap, the portrait/name token
hover, and the actor-art-over-token-image change (with the note that cards
posted before the change keep the image they were created with).

---

## 2026-09-02 — Target-list setting, defenses card link, sole-target expand

### `lang/en.json` — new setting

New keys, no prior text:

- `RR.Settings.TargetListAlways.Name`: `Replace All Target Lists`
- `RR.Settings.TargetListAlways.Hint`: `Also replace the target list on actions with no saving throw or check, giving a list with no roll button. Requires Auto-Request Saving Throws.`

### `lang/en.json` — new card strings

New keys, no prior text:

- `RR.Card.TargetsTitle`: `Targets` — the header of a roll-less target list, matching PF1's own `<h2>Targets</h2>`.
- `RR.Def.PostCard`: `Post a defenses card to chat` — tooltip on the clickable Defenses heading.

### `README.md` — new subsection under Auto Save Requests

New text, no prior version. Covers: what **Replace All Target Lists** does, what
the roll-less card keeps (rows, portraits, defenses dropdown, canvas hover and
click, Select All), what it drops and why (roll button, Roll All / Roll NPCs,
Select Passed / Select Failed — the last two partition results the card never
gets), that it is off by default, that it requires Auto-Request Saving Throws,
and that only lists PF1 actually drew are replaced.

### `README.md` — GM view, targeted card

Added bullet (new):

> - The dropdown's **Defenses** heading posts PF1's own defenses card to chat, whispered to you — the same card PF1's target boxes produce when you click a target's AC. It appears as a link only for actors you own, since PF1 refuses the card otherwise.

Before:

> - When there is only one target, all bulk and selection buttons are suppressed (no point in Roll All or Select Passed with a single token).

After:

> - When there is only one target, all bulk and selection buttons are suppressed (no point in Roll All or Select Passed with a single token), and that target's dropdown is expanded from the start.

### `README.md` — Player view, targeted card

Before:

> - Tokens the player has at least Observer permission on appear as normal rows with a roll button. Clicking the token's **row** expands the same dropdown available to the GM (defenses, plus the roll breakdown once rolled), and hovering the portrait or name highlights the token on the canvas.

After:

> - Tokens the player has at least Observer permission on appear as normal rows with a roll button. Clicking the token's **row** expands the same dropdown available to the GM (defenses, plus the roll breakdown once rolled), and hovering the portrait or name highlights the token on the canvas. A player seeing exactly one row gets it expanded from the start.

### `CHANGELOG.md` — three new entries under Unreleased

New text, no prior version: the **Replace All Target Lists** setting (under
Added), the clickable Defenses heading, and the sole-target auto-expand.

---

## 2026-09-02 — Token Check mode, Quick Perception, bulk roll on every targeted card

### `README.md` — Roll Request Dialog, mode list

Before:

> - **Mode** — Single-check, multi-check, selection-check (prompt specific actors), or DM check (auto-roll for your selected NPCs)

After:

> - **Mode** — Single-check, multi-check, selection-check (prompt specific actors), token check (prompt your selected tokens), or DM check (auto-roll for your selected NPCs)

### `README.md` — new subsection after "Prompt Actors (Selection Check)"

Added:

> #### Token Check
>
> **Token Check** posts the same per-target card a Selection Check does, but takes its targets from the tokens you have **selected on the canvas** rather than from the checklist. There is no list to tick — select the tokens, pick the check, click **Request Roll**.
>
> Because the card is built from tokens rather than actors, unlinked duplicates of the same actor each get their own row and result, and each row can be rolled by whoever owns that token (the GM can roll any of them). Any token type is eligible, not just NPCs. Aid Another, the DC, and the roll mode all work exactly as they do for a Selection Check — the difference is only where the target list comes from. Cards are tagged `[Token Check]`.

### `README.md` — card title tags

Before:

> Every request card tags its title with the check mode — `[Single Check]`, `[Multi-Check]`, or `[Selected Check]` — so the kind of check is clear at a glance. (Auto-generated saving-throw cards are left untagged.)

After:

> Every request card tags its title with the check mode — `[Single Check]`, `[Multi-Check]`, `[Selected Check]`, `[Token Check]`, or `[DM Check]` — so the kind of check is clear at a glance. (Auto-generated saving-throw cards are left untagged.)

### `README.md` — GM view, Roll All

Before:

> - **Roll All** — rolls the saving throw for every unrolled target, skipping the roll dialog. Also available for blind-roll targeted cards created via the API.

After:

> - **Roll All** — rolls the saving throw for every unrolled target, skipping the roll dialog. Present on every targeted card, not just auto-generated saves: selection, token and API-created cards get the same pair. (A one-target card keeps **Roll All** — the per-row button opens the roll dialog and this one never does — but drops **Roll NPCs**, which has nothing to partition.)

### `README.md` — Quick Actions list

Added:

> - **Quick Perception** — the same Perception check, taken from the tokens **selected on the canvas** instead of a picker (a Token Check, in effect). A small popup asks for a **DC** and **flavor text** first; both are optional, so clicking **OK** on an empty form is a normal use. The card is public with totals hidden from players, and has no Aid Another. Any DC you enter is used for the GM's pass/fail marks only — it is not shown to players, and nobody is blocked from rolling a check they cannot pass.

### `api.md` — `bulkRollTargeted`

Before:

> Pass `{ slot }` as a second argument to roll an [embedded request](#embedded-requests) instead of the card itself.

After:

> Pass `{ slot }` as a second argument to roll an [embedded request](#embedded-requests) instead of the card itself, and `{ which: "npcs" }` to skip every character-type actor and every target an active player owns — what the card's **Roll NPCs** button does.

### `api.md` — Registering Quick Actions

Added `useSelectedTokens` and `promptOptions` to the option block and the callback context (`options: { dc, flavor }`), and:

Before:

> The three actor-passing modes are mutually ordered: `promptActors` (show picker) takes precedence, then `allActors` (send everyone), otherwise `actors` is `null`.

After:

> The actor-passing modes are mutually ordered: `promptActors` (show picker) takes precedence, then `useSelectedTokens` (canvas selection), then `allActors` (send everyone), otherwise `actors` is `null`. […] `useSelectedTokens` likewise aborts with a warning when nothing is selected on the canvas.
>
> `promptOptions` opens its popup *after* the actor list is settled, so a click that has nothing to act on fails before anything is typed into it. Both fields may be left blank; cancelling the popup aborts the action.

### New UI prose (`lang/en.json`)

- `RR.Dialog.TokenCheck` — "Token Check"
- `RR.Dialog.TokenCheckHint` — "Prompts the tokens you have selected on the canvas."
- `RR.Dialog.QuickOptionsTitle` — "{label} — Options"
- `RR.QuickOptions.Hint` — "Both optional — leave blank and click OK."
- `RR.Notif.SelectTokens` — "Select one or more tokens on the canvas first."
- `RR.Quick.Perception` — "Quick Perception"
- `RR.Card.KindToken` — "Token Check"
