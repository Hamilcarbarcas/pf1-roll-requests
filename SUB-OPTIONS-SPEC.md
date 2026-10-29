# Sub-Options – Spec

A request can carry **sub-options** on its check: a skill use ("Acrobatics – to jump") or
the categories a save is against ("Will – against fear, poison"). The roll is made with
them, so a bonus that targets that use or category applies. A request without
sub-options behaves exactly as today.

Status: **built 2026-10-23, untested.** `src/module/sub-options.mjs` (registry, labels,
roll options) and `src/module/apps/SubOptionFlyout.mjs` (tiles and flyout), wired through
`main.mjs`, `RollRequestDialog`, `RollRequestChat` and `SaveAutoRequest`.

First consumer: astora-mod's Situational Targets
([situational-targets/DESIGN.md](../astora-mod/situational-targets/DESIGN.md)), which
owns the vocabulary, the change targets, and the bonus math.

---

## §1 Who owns what

roll-requests owns **no vocabulary**. It stores, shows, and passes on a list of string
ids; a registered **provider** says which ids exist for a check, what they are called,
and what roll options they turn into. With no provider registered, nothing in this
spec appears.

| roll-requests | Provider (astora-mod) |
|---|---|
| Flyout on the dialog tiles, request state, card labels, passing options to the roll | Which sub-options a check has, labels and groups, roll options, auto-fill from a source card, the full tag window |

## §2 API

```js
game.pf1RollRequests.registerSubOptions({
  id: "astora-situational",
  types: ["save", "skill"],

  // Sub-options for one check. [] = the tile gets no flyout.
  options: (type, key) => [{ id: "jump", label: "Jump", group: "Uses" }, …],

  // Saves take several, skills one.
  multiple: (type) => type === "save",

  // Optional: the ids shown in the flyout when the full list is long (§4.3).
  common: (type, key) => ["spells", "poison", "fear", …],

  // Optional: open the provider's full selector; resolves to the new id list, or null.
  pick: async (type, key, current) => [...],

  // Turned into options for rollSkill / rollSavingThrow.
  rollOptions: (type, key, ids) => ({ astoraTags: ids }),

  // Optional: ids implied by the card a save request came from (§7).
  forMessage: (message) => [...],
});
```

One provider per type; a second registration for the same type replaces the first with
a console warning. `game.pf1RollRequests.unregisterSubOptions(id)` removes one.

## §3 Request state

`selectedRequest` and every stored request gain one field:

```js
{ type: "skill", key: "acr", name: "Acrobatics", tags: ["jump"] }
```

- Absent or `[]` = a plain check.
- `name` stays the check's own name; labels are built from `tags` at display time
  (§6), so a renamed sub-option shows its current label.
- `_saveSettings` persists `tags` with the rest of `selectedRequest`. Ids the provider
  no longer knows (provider disabled, custom tag deleted) are dropped on load.
- `createRequest({ …, tags: [...] })` takes the same field, and a per-row
  `check: { type, key, tags }` override carries its own.

## §4 The dialog

### §4.1 Tiles

A tile whose check has sub-options gets a small chevron in its corner. Nothing else
about the grid changes.

- **Click the tile** – selects the plain check and clears its sub-options.
- **Hover the tile** (short delay) – opens the flyout beside it. Leaving both the tile
  and the flyout closes it after a short grace period, so the pointer can cross the gap.
- **Right-click the tile** – opens the same flyout **pinned**: it stays until a click
  outside, Escape, or (for skills) a pick.

A selected tile shows its sub-options on a second, smaller line:

```
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Acrobatics  ▾ │ │ Appraise      │ │ Bluff       ▾ │
│ Jump          │ │               │ │               │
└───────────────┘ └───────────────┘ └───────────────┘
```

### §4.2 Skills – single pick

```
┌───────────────┐┌──────────────┐
│ Acrobatics  ▾ ││ General      │
└───────────────┘│ Balance      │
                 │ Jump       ✓ │
                 │ Tumble       │
                 │ Fall         │
                 └──────────────┘
```

Clicking a use selects the tile with that use and closes the flyout. "General" is the
plain check, same as clicking the tile.

### §4.3 Saves – several

Checkboxes. Each click toggles a tag and selects the tile; the flyout stays open so
several can be ticked.

The full save list is ~45 tags, too long for a hover menu. The flyout shows the
provider's `common` set (about a dozen, from the survey: spells, spell-like abilities,
poison, disease, fear, mind-affecting, charm, compulsion, death, energy, traps), any
already-selected tags outside it, and a last row **All tags…** that calls `pick` and
opens the provider's full selector window.

```
┌───────────────┐┌─────────────────────┐
│ Will        ▾ ││ ☐ Spells            │
│ fear, poison  ││ ☐ Spell-like        │
└───────────────┘│ ☑ Fear              │
                 │ ☐ Mind-affecting    │
                 │ ☑ Poison            │
                 │ …                   │
                 │ All tags…           │
                 └─────────────────────┘
```

Without `common`, the flyout lists everything, grouped, and scrolls.

### §4.4 Not filtered by actor

The roll dialog offers only the sub-options a roller has bonuses for. The request
dialog does not: the GM is choosing for several actors, and the tag also labels the
card (§6) whether or not anyone has a bonus for it.

## §5 Rolling

Both roll paths in `RollRequestChat` (the `rollAbilityTest` / `rollSavingThrow` /
`rollSkill` branches near lines 1964 and 2015) merge
`provider.rollOptions(type, key, tags)` into `opts`. A row's `check.tags` wins over the
card's.

- **Aid Another** rolls carry no sub-options: aiding is its own DC 10 check, not the
  use being aided.
- **Apply Roll** matches on `type` and `key` as today and ignores sub-options, so an
  existing plain roll can still be fed to a tagged row.

## §6 On the card

The card header and per-row check labels append the sub-option labels:
"Acrobatics (Jump)", "Will Save – against fear, poison". `_getEffectNotes` stays
as is; tag-scoped notes reach the roll's own card through the provider's roll hook.

## §7 Auto-save requests

`SaveAutoRequest` already resolves the source message → item. With a provider,
`forMessage(message)` fills the request's `tags` (a spell's descriptors, school, and
subschool; an action's own tags), and the header shows them. Not editable on the card;
a GM who wants other tags makes a request from the dialog.

## §8 Out of scope

Opposed Check and Monster Lore quick actions keep plain checks. Opposed uses (feint vs.
Sense Motive) can come later through the same `tags` field.

## §10 Spellcasting checks (2026-10-23)

A `spellcasting` request type, keys `concentration` / `cl` (`src/module/spellcasting.mjs`),
takes sub-options like skills do (single pick). Rolling it asks for a spellbook when the
roller has more than one in use (DialogV2, one button per book, last pick preselected).
Feasibility uses the best book; notes use the last book. Providers gained an optional
`notes(type, key, roll)`, since a request roll's own card is never posted and notes that
ride the roll would otherwise be lost.

## §11 Creatures and hidden tags (2026-10-27)

Monster Lore's check is about a creature, and a provider can map a creature to ids (a
Knowledge check identifying undead). Providers gained an optional
`forCreature(type, key, { type, subtypes })`, PF1 creature type and subtype keys;
`creatureTags()` calls it. Monster Lore passes the chosen type (kebab key to PF1's
camelCase) and, when the reference monster is of that type, its subtypes.

Naming the tag on the cards would tell players the type where the skill alone doesn't
(Arcana covers constructs, dragons and magical beasts). A request field `hideTags` keeps
`displayName` to the plain check name and reaches the provider as
`rollOptions(type, key, ids, { hidden })`, so it can keep its own labels general too.
Monster Lore sets it.

## §9 Decisions

1. Save flyout: `common` subset plus **All tags…** (§4.3); everything grouped only when a
   provider gives no `common`.
2. Hover: 250 ms open, 200 ms close. Tune in play.
3. Card titles use `RR.SubOptions.SaveName` / `CheckName`: "{name} (against {tags})" and
   "{name} ({tags})", rather than the dash form sketched in §6.
