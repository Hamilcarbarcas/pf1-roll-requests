# Subject Modifiers — Spec

A request can name a **subject**: the token the check is *about*. Perception and Spellcraft
rolls on that request then take a **Distance** penalty of −1 per full 10 ft between the rolling
token and the subject, worked out for each roller. Nothing else about the request changes; a
request without a subject behaves exactly as today.

Status: **built 2026-09-27, untested in Foundry.** The code is in `src/module/subject.mjs` and
`src/module/house-rules.mjs`, wired through `RollRequestChat`, `ApplyRoll`, `RollRequestDialog`
and `OpposedCheck`. A vision penalty was built alongside and then **removed** for more design
(§9.1).

First consumer: astora-mod's Concealed Casting (Spellcraft to identify a spell being cast).
Built-in consumer: the Opposed Check quick action (§3.2).
Planned consumer: Stealth vs. Perception automation (§9.2).

---

## §1 Rules basis

- **Perception:** the DC modifier table gives +1 to the DC per 10 ft of distance.
- **Spellcraft:** identifying a spell as it is being cast is subject to all the usual penalties
  for distance, poor conditions and the like, so the distance term applies to it as well.

The penalty is applied to the **roll** rather than the DC, because one request has one DC and
every roller stands somewhere different. Poor conditions, distractions and sight stay with the GM
for now (§9).

---

## §2 Scope

| Check | Subject honored |
|---|---|
| `skill` / `per` | yes |
| `skill` / `spl` | yes |
| anything else | no. The subject is kept on the card but ignored, with a console warning at creation |

The list is one constant (`SUBJECT_CHECKS`). On a targeted card with per-row checks
(`targetedActors[].check`), the list is tested against **each row's own check**, so on an
opposed Stealth/Perception card only the Perception row is penalized.

---

## §3 API

`subject` is accepted by `createRequest`, `embed` and `openDialog`:

```js
game.pf1RollRequests.createRequest({
  type: "skill", key: "spl", dc: 18, mode: "multi",
  subject: casterToken.document.uuid,   // a token uuid, TokenDocument, or Token
});
```

Stored on the request's flags as `subject: { tokenUuid }`. The token is looked up again at each
roll, so a subject that moves between the request and the roll is measured where it stands then.
A uuid that no longer resolves (the token was deleted) behaves like no subject.

`updateEmbed(message, slot, { subject })` changes or clears it (`subject: null`).

### §3.1 A subject per row

On a targeted request, a `targetedActors` entry can carry its own `subject`, which overrides the
card's for that row. It takes the same forms and is stored the same way. It is tested against
the row's own check (§2), so a subject on a Stealth row is kept but has no effect.

```js
game.pf1RollRequests.createRequest({
  type: "skill", key: "ste", mode: "targeted", opposed: true,
  targetedActors: [
    { id: rogueToken.id, check: { type: "skill", key: "ste" } },
    { id: guardToken.id, check: { type: "skill", key: "per" }, subject: rogueToken.document.uuid },
  ],
});
```

An Aid Another roll aimed at a row uses that row's subject, since the aider is helping with the
same check.

### §3.2 Opposed Check quick action

The window already knows both tokens ([OpposedCheck.mjs](src/module/apps/OpposedCheck.mjs)). A
row whose check is in `SUBJECT_CHECKS` gets the **other** row's token as its subject,
automatically:

| Contest | Row with a subject |
|---|---|
| Stealth vs. Perception | Perception, subject = the Stealth side |
| Disguise vs. Perception | Perception, subject = the Disguise side |
| Bluff vs. Sense Motive, Forgery, Strength | none |

No new control in the window. Subjects are read from the sides when the request is posted, so
the swap button needs nothing of its own.

---

## §4 Measuring

At roll time, inside `_handleRollInner`, after the roller's actor and token are resolved:

1. **The roller's token:** the row's `tokenUUID` on a targeted card, the controlled token
   otherwise. The `use-configured-actor` fallback only has an actor, so it takes the actor's
   linked token on the subject's scene if there is exactly one.
2. **Same scene:** both token documents must share a parent Scene. If not, the penalty is 0.
3. **Distance:** `scene.grid.measurePath` between the **nearest occupied squares** of the two
   tokens, so a Huge subject is measured to its near edge rather than its center. This uses
   PF1's 5/10 diagonal rule, and works without the roller's canvas showing that scene.
4. **Elevation is included.** Each waypoint carries its token's `elevation`, and v13's square
   grid measures in 3D with the same diagonal rule (`common/grid/square.mjs`), so a caster flying
   60 ft overhead is 60 ft away. Hex and gridless scenes measure however core measures them.
5. **Penalty:** `Math.floor(feet / 10)`. Adjacent (5 ft) is 0.

Any failure (no token, no subject, no scene, an error) gives a penalty of 0 and logs to the
console. It never blocks the roll.

---

## §5 Applying the penalty

The penalty goes in the same place Aid Another does: PF1's situational `bonus` option, as a
labeled term.

```
-3[Distance]
```

`_performRoll` and `_rollWithAidBonus` both gain it, and a penalty of 0 is left out. With aid as
well, the terms are joined into one string (`2[Aid Another] - 3[Distance]`). It shows in the roll
dialog (where the player can see and edit it) and in the result's expanded breakdown.

- **Aid Another rolls** take the penalty too. The aider is perceiving the same thing from where
  they stand.
- **Natural-20 feasibility gate:** `maxPossible` subtracts the penalty, or a roller who cannot
  reach the DC once it is applied would be let through.

  The refusal runs **even when the DC is hidden**, unlike Quick Perception, which never gates.
  A player refused on a hidden-DC check learns the DC is high, and on a concealed spell that
  hints at its level. This is a table ruling: refusing matters more than that hint.
  **Allow un-passable checks** still lifts the gate per request.
- **Roll All** measures per target, the same way.
- **Result entry** records `distance: { feet, penalty }`, or `null` when not measured. It is
  visible to `onResult` and `rollComplete`.
- **Apply Roll** folds the penalty into the applied roll as a real term, the same way it already
  folds banked aid, measured from the source roll's speaker token at apply time.

---

## §6 Dialog

When the selected check is in `SUBJECT_CHECKS`, the left column gains a **Subject** section,
under Aid Another:

```
Subject
[ (img) Goblin Shaman  × ]
[ ⌖ Choose Subject       ]
```

- **Choose Subject** takes the single controlled token. None or several selected: a warning
  and no change.
- The **chip** shows the current subject; **×** clears it. There is no drop zone, since canvas
  tokens are not drag sources.
- Hidden for every other check. The subject stays set on the dialog while hidden, but is only
  sent with a request whose check is in the list.
- Not remembered between opens. A subject names a token in one moment; restoring it next session
  would be surprising. `openDialog({ subject })` seeds it.

Token Check and DM Check read the canvas selection when **Request Roll** is clicked. The order
that works is therefore: select the subject, click Choose Subject, select the rollers, then
Request Roll. The README says so in one line.

The chip is drawn in place rather than by re-rendering, since the DC and flavor inputs only save
on blur. The footer stays core's generic one. A first draft put the control in a custom footer
beside Request Roll, where it wrapped across the whole window; it was moved to the left column.

---

## §7 On the card

Players see nothing new beyond the `Distance` term in each roll's breakdown. The GM sees a small
"Subject: *name*" line under the title, so a card read later still shows what was measured
against. It is GM-only because the subject may be a hidden or name-obscured token (Token
Randomizer).

---

## §8 Settings and house rules

Distance needs no setting: it is RAW, and a request with no subject is unchanged.

**House Rules** (`house-rules`, world, default `false`) is one checkbox for every non-RAW rule
in the module. It **replaces `uncap-aid-another`**. It covers:

| Rule | RAW | With House Rules on |
|---|---|---|
| Aid Another | +2 flat | +2, and +1 more per 5 over DC 10 (the old uncap setting) |
| Identify a spell being cast (§8.1) | DC 15 + spell level | +5 DC for each of V and S the spell lacks |

**Migration:** at `ready`, on the first active GM, if a stored `uncap-aid-another` value exists
and `house-rules` has none, copy it across. The old key stays registered with `config: false`
for one release so the read works, then is dropped.

### §8.1 `spellcraftDC`

```js
game.pf1RollRequests.spellcraftDC({ level: 3, verbal: false, somatic: true }); // 23 with House Rules, 18 RAW
```

The DC to identify a spell as it is cast, with the house rule applied when it is on. Callers
(astora-mod's Concealed Casting) take the DC from here rather than reading this module's setting
themselves. `verbal` / `somatic` default to `true`, which adds nothing.

---

## §9 Deferred

### §9.1 A vision penalty

Built on 2026-09-27 and removed the same day, to be designed properly. What the draft did:

- **Spellcraft only**, and only with pf1-lighting active: −20 `Not Visible` when
  `game.modules.get("pf1-lighting").api.perceive(roller, subject).visible` was false. −20 was
  borrowed from the Perception modifier for an invisible creature and used for every way of not
  seeing. Perception got no vision term, since whether sight matters depends on the check
  (hearing only; a creature in view for part of its move that ended out of sight).
- `perceive` runs Foundry's detection modes for the **roller's** token, building a temporary
  vision source for a token the client does not own. That covers the invisible condition (PF1's
  `invisible` is Foundry's invisible status, so *see invisibility* / *true seeing* still succeed),
  walls, darkness against darkvision range, and a blinded roller.
- It needed the rolling client's canvas to show the subject's scene. Where it did not, the term
  was skipped and the result carried `vision: null`, drawn as a GM-only "Vision not checked" mark.

What testing found, and what the redesign has to answer:

- **A GM-hidden token read as visible.** Foundry's detection modes do not look at
  `TokenDocument#hidden`; that is `Token#isVisible`'s job, above them. Whether a GM-hidden
  subject counts as unseen is a table question anyway: a hidden token is often "not placed yet"
  rather than "invisible".
- **Degrees of not seeing.** Invisible, behind a wall, in darkness and blinded may not all
  deserve the same −20. Some may make the check impossible rather than harder (RAW asks that
  the spell be *seen* being cast).
- **Other senses.** Whether hearing the verbal component, or blindsight and tremorsense, should
  count toward identifying a spell.
- **Poor conditions generally** (fog, concealment, distraction), which RAW lists beside distance.

### §9.2 Stealth itself, and vision on Perception

Being unseen is what makes Stealth possible, so a Stealth automation reads vision as a gate,
not as a penalty. It is also where the Perception cases above (hearing only, a move that ended
out of sight) can be told apart. pf1-lighting's `perceivedBy(observed)` is the batch call for
that. Should share its answer to §9.1's questions.

---

## §10 Files

| File | Change |
|---|---|
| `src/module/main.mjs` | `subject` option on `createRequest` / `embed` / `openDialog`; normalize to a uuid; `house-rules` setting and migration; `spellcraftDC` |
| `src/module/subject.mjs` | New. Distance (§4) |
| `src/module/house-rules.mjs` | New. House Rules setting, Aid Another bonus, `spellcraftDC`, migration (§8) |
| `src/module/apps/RollRequestChat.mjs` | Call `subject.mjs`, apply (§5), feasibility gate, result `distance`, GM subject line (§7); read House Rules for aid |
| `src/module/apps/ApplyRoll.mjs` | Fold the penalty (§5); read House Rules for aid |
| `src/module/apps/RollRequestDialog.mjs` | Choose Subject action, chip, clear |
| `src/templates/roll-request-dialog.html` | Subject section in the left column |
| `src/templates/chat-card-*.html` | GM subject line |
| `src/module/apps/OpposedCheck.mjs` | Per-row subjects on the posted request (§3.2) |
| `src/styles/roll-requests.css` | Chip and subject line, scoped under the module's classes |
| `lang/en.json` | Subject strings; House Rules name/hint replace UncapAid (logged in README-EDITS.md) |
| `api.md`, `README.md`, `CHANGELOG.md` | Document it (Unreleased) |
