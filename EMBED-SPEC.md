# Embedded Requests — spec

**Status: built.** The reference is [`api.md` § Embedded requests](api.md#embedded-requests); this
file is kept only as the design record of why the mechanism looks like this. It is *not* a
description of the shipped API — where the two differ, api.md is right. The differences, all of
them resolutions of §7:

1. **`rollMode` per slot — yes, restricted.** `roll` and `publicblind` only. The other two are
   whisper modes: they restrict who the *message* reaches, which an embed does not own, so
   accepting them would show players a roll the caller believed was hidden. They warn and fall
   back to `roll`.
2. **`closeRequest`/`lockRequest` on the host — closes every embed.** A card that stops accepting
   rolls should not still be handing them out. A host that wants otherwise uses `closeEmbed`
   selectively, as the spec suggested.
3. **No `module` prefix on slots.** `<module>.<slot>` cannot work: a dot in a flag key is expanded
   into nesting by Foundry (see the same warning in `SaveAutoRequest._initialize`). Slots are
   instead validated against `/^[\w-]+$/`, namespaced by convention, and an overwrite warns rather
   than passing silently.

One thing the spec left implicit was settled the same way: `controls: false` suppresses the card's
chrome (title, flavor, GM mode footer) as well as the bulk row, per §4's "the rows and nothing
else" — but a `showDC` chip survives, because a caller who asked for the DC meant it.

A way for another module to put a live roll request **inside a card it owns**, without either
module taking the other's card away from it.

---

## 1. Why the current mechanism can't do this

There is already something that embeds a request into someone else's card: the auto-save request
(`apps/SaveAutoRequest.mjs`). It works by **rewriting `message.content`** —
`_extractPf1Content()` splits PF1's rendered card into two HTML strings, stores them in flags as
`pf1HeaderHtml` / `pf1FooterHtml`, and `_rebuildCardContent()` regenerates the whole content with
the request card between them. Every subsequent roll rebuilds and re-stores that content again
(`RollRequestChat._handleRollComplete`, ~line 1712).

That is fine for its actual job — converting a *finished* PF1 attack card, once, on first render —
and it is wrong for a host module that draws its card from its own flags on every render. Three
concrete failures:

| | What happens |
|---|---|
| **Snapshot freezing** | Anything a host injected at render time is captured into the stored `pf1HeaderHtml` / `pf1FooterHtml` strings and replayed forever after, stale, alongside the host's own live re-injection. |
| **Content ownership** | The message's `content` becomes ours. A host that also wants to write content has nowhere to put it. |
| **One per message** | State lives at `flags.pf1-roll-requests.*` with no namespace, and `onRenderChatMessage` bails on any message that already carries `request`. A card can hold exactly one request, ever. |

None of that is fixable by calling the existing path differently. It needs a second path.

## 2. Shape

```js
// GM-side. Creates the request state; renders nothing by itself.
await game.pf1RollRequests.embed(message, {
  slot: "ce-crit-save",          // required — namespaces the state, unique per message
  type: "save",
  key: "fort",
  dc: 22,
  mode: "targeted",
  targetedActors: [{ id: tokenDoc.id }],
  showDC: true,
  showResults: true,
  controls: false,               // suppress the bulk row — see §4
});

// Any client, from the host's own render hook, once its container exists.
await game.pf1RollRequests.renderEmbed(message, { slot: "ce-crit-save", into: element });
```

Two calls, deliberately: **`embed()` owns state, `renderEmbed()` owns placement.** The split is
what makes ordering a solved problem rather than a race — see §3.

Supporting calls:

| Call | Does |
|---|---|
| `getEmbed(message, slot)` | the slot's state, or `null` |
| `updateEmbed(message, slot, changes)` | patch state (DC correction, add a target) |
| `closeEmbed(message, slot, { lock })` | stop accepting rolls; `lock` keeps the results visible, matching `lockRequest` |
| `listEmbeds(message)` | slot keys present on the message |

`embed()` accepts the `createRequest` option set, minus the ones that are properties of *being a
card*: no `flavor` (the host has its own header), no `description` (ditto), no `awaitResult`
(a Promise held on one client dies on reload; use the hook).

## 3. Storage and rendering

**State** lives at `flags.pf1-roll-requests.embeds.<slot>` — the same object the standalone card
keeps in its flag scope today (`request`, `dc`, `showDC`, `showResults`, `targetedActors`,
`actorResults`, `rolledActors`, `usedActorIds`, …) minus `pf1HeaderHtml` / `pf1FooterHtml`, which
exist only to serve the rewrite.

**`message.content` is never read and never written.** This is the whole point of the mechanism and
should be enforced by review: an embed that touches content has become the thing it replaced.

**Rendering is explicit.** `renderEmbed(message, { slot, into })` renders the widget into the given
element and binds its handlers there. The host calls it from its own `renderChatMessageHTML` hook,
after building the container — so the container is guaranteed to exist, with no hook-ordering
dependency between the two modules and no retry loop. A host that re-renders its block on a later
draw simply calls `renderEmbed` again.

For consumers that don't need that control, `embed()` may take an optional `mount` selector and the
module can auto-render into the first match on its own hook, skipping silently when there is none.
That is a convenience path; **hosts drawing their card from flags should use `renderEmbed`.**

**Re-render on roll** is a flag update. A roll writes to
`flags.pf1-roll-requests.embeds.<slot>.actorResults` and stops; Foundry re-renders the message,
the host's hook fires, the host rebuilds its block and calls `renderEmbed` again. No content
update, no second re-render, and the host's own state and ours stay independent.

**Permissions are unchanged.** `embed()` is GM-gated exactly like `createRequest`. A player's roll
crosses the existing socket to the GM, who is still the only writer to the message, and inherits
the existing serialisation lock (`RollRequestChat`, ~line 1309). The socket payload gains one
field, `slot`, defaulting to `null` for a whole-card request.

## 4. `controls`

`controls: false` suppresses the bulk action row — Roll All, Roll NPCs, Select All, Select Failed.
Those exist because a whole-card request is usually a fireball against six tokens. An embedded one
is usually a single target with a single row, where the bulk controls are four buttons that each
do exactly what the one row already does.

Not a styling flag: with `controls: false` the widget should be the rows and nothing else, so a
host can sit it inside its own card without a second card's worth of chrome around it.
`bulkRollTargeted(message, { slot })` stays available to the caller regardless — suppressing the
buttons is not the same as suppressing the capability.

## 5. Results

`pf1RollRequests.rollComplete` gains **`slot`** in its payload, `null` for a whole-card request.
Existing listeners that ignore it keep working; a host filters on it to pick out its own embed.

`onResult` is likewise accepted per embed, with the same caveat it already carries: it is held in
memory on the creating client, so a reload drops it. The hook is the durable channel and is what a
host that survives reloads should use.

## 6. What this does not change

- **`createRequest` is untouched.** Whole-card requests remain the normal way to ask for a roll.
- **The auto-save request keeps working as it does today.** Re-implementing it on top of embeds is
  the obvious follow-up and would make PF1 attack cards composable with other modules for the first
  time — but it is a behaviour-preserving refactor of a working feature, and it should not ride
  along with the introduction of the mechanism it would be built on.
- **`excludeTargets` is auto-request-only** and stays that way. An embed's caller passes its target
  list directly, so there is nothing to exclude from.

## 7. Open questions

1. **Does a slot need its own `rollMode`?** A host may want a save rolled blind on a card that is
   otherwise public. Cheap to allow, and there is no reason it should inherit from a card it isn't.
2. **What does `closeRequest` on the host message do to embeds?** Closing the card should probably
   close every embed on it, but the host may reasonably outlive its request. Leaning: close them,
   and let a host that wants otherwise call `closeEmbed` selectively.
3. **Two embeds, same slot key, two modules.** A collision silently overwrites. Prefixing the slot
   with the caller's module id — `embed(message, { slot, module })`, stored as `<module>.<slot>` —
   makes it impossible; worth doing if it costs nothing.

## 8. First consumer

`pf1-critical-effects`, for the Fort save on a critical effect (its `DESIGN.md` §6). Single target,
DC derived from the attack's damage, sitting between the effect's two outcome branches on a card
that is itself drawn entirely from flags at render time. It needs every property above:
non-destructive, explicitly placed, re-renderable, and reporting through the hook rather than a
callback.
