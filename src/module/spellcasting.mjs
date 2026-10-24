// ============================================================
// Spellcasting checks — concentration and caster level checks as a request
// type ("spellcasting", keys "concentration" / "cl"). PF1 rolls both per
// spellbook, so an actor casting from several books is asked which.
// ============================================================

export const SPELLCASTING_KEYS = ["concentration", "cl"];

/** Last book picked per actor uuid, offered first next time and used for notes. */
const lastBook = new Map();

/** Display name of a spellcasting check. */
export function spellcastingName(key) {
  return game.i18n.localize(key === "cl" ? "RR.Spellcasting.CasterLevel" : "RR.Spellcasting.Concentration");
}

/** Spellbooks in use: `[[bookId, book]]`. */
export function booksOf(actor) {
  return Object.entries(actor?.system?.attributes?.spells?.spellbooks ?? {}).filter(([, b]) => b?.inUse);
}

function bookLabel(actor, id, book) {
  const cls = book.class ? actor.classes?.[book.class]?.name : null;
  const label = book.label || id;
  return cls && cls !== label ? `${cls} (${label})` : label;
}

/** The book last used for this actor, or its only/first in-use book. */
export function lastSpellbook(actor) {
  const books = booksOf(actor);
  const remembered = lastBook.get(actor?.uuid);
  if (books.some(([id]) => id === remembered)) return remembered;
  return books[0]?.[0] ?? null;
}

/**
 * The spellbook to roll from: the only one, or the caster's choice.
 *
 * @param {Actor} actor
 * @returns {Promise<string|null>} Null when there is none or the prompt was closed.
 */
export async function pickSpellbook(actor) {
  const books = booksOf(actor);
  if (!books.length) {
    ui.notifications.warn(game.i18n.format("RR.Spellcasting.NoBooks", { name: actor.name }));
    return null;
  }
  if (books.length === 1) return books[0][0];

  const preferred = lastSpellbook(actor);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("RR.Spellcasting.PickTitle"), icon: "fa-solid fa-book" },
    content: `<p>${game.i18n.format("RR.Spellcasting.PickPrompt", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
    buttons: books.map(([id, book]) => ({
      action: id,
      label: bookLabel(actor, id, book),
      default: id === preferred,
    })),
    rejectClose: false,
    close: () => null,
  });
  if (choice) lastBook.set(actor.uuid, choice);
  return choice ?? null;
}

/** Roll a spellcasting check, asking for the book first when there are several. */
export async function rollSpellcasting(actor, key, opts) {
  const book = await pickSpellbook(actor);
  if (!book) return null;
  lastBook.set(actor.uuid, book);
  if (key === "cl") return actor.rollCL(book, opts);
  return actor.rollConcentration(book, opts);
}

/** The highest modifier among the actor's books, for the natural-20 gate. */
export function bestModifier(actor, key) {
  const totals = booksOf(actor).map(([, b]) => (key === "cl" ? b.cl?.total : b.concentration?.total));
  const valid = totals.filter((t) => Number.isFinite(t));
  return valid.length ? Math.max(...valid) : null;
}

/** Context-note key PF1 uses for this check on the actor's last book. */
export function notesContext(actor, key) {
  const book = lastSpellbook(actor);
  if (!book) return null;
  return key === "cl" ? `spell.cl.${book}` : `spell.concentration.${book}`;
}

/** The book a PF1 check message was rolled from, remembered for its notes. */
export function rememberBook(actor, book) {
  if (actor?.uuid && book) lastBook.set(actor.uuid, book);
}
