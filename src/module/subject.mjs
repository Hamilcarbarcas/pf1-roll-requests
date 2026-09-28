// ============================================================
// Pathfinder 1e Roll Requests — Subject modifiers (SUBJECT-SPEC.md)
//
// A request may name a subject: the token its check is about. Perception and
// Spellcraft rolls then take a Distance penalty, worked out per roller at roll
// time.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

/** Checks that take the distance term (§2). */
export const SUBJECT_CHECKS = new Set(["per", "spl"]);

/**
 * Whether a check can take a subject at all.
 *
 * @param {{type: string, key: string}|null|undefined} check
 * @returns {boolean}
 */
export function takesSubject(check) {
  return check?.type === "skill" && SUBJECT_CHECKS.has(check.key);
}

/**
 * A subject from whatever a caller had to hand: a token uuid, a TokenDocument,
 * a Token, or an already-normalized `{ tokenUuid }`.
 *
 * @param {*} value
 * @returns {{tokenUuid: string}|null}
 */
export function normalizeSubject(value) {
  if (!value) return null;
  if (typeof value === "string") return { tokenUuid: value };
  if (typeof value.tokenUuid === "string") return { tokenUuid: value.tokenUuid };
  const doc = value.document ?? value;
  if (doc?.documentName === "Token" && doc.uuid) return { tokenUuid: doc.uuid };
  return null;
}

/**
 * The subject governing one roll: the row's own where it has one (§3.1),
 * otherwise the card's.
 *
 * @param {object} flags - The request's flag state.
 * @param {string|null} [targetActorId] - The targeted row being rolled or aided.
 * @returns {{tokenUuid: string}|null}
 */
export function subjectFor(flags, targetActorId = null) {
  if (targetActorId) {
    const row = flags?.targetedActors?.find(t => t.id === targetActorId);
    if (row && Object.hasOwn(row, "subject")) return row.subject ?? null;
  }
  return flags?.subject ?? null;
}

/**
 * The roller's token on the subject's scene. An explicit token wins; an actor
 * alone resolves to its token there only when there is exactly one (§4).
 *
 * @param {object} args
 * @param {TokenDocument|null} [args.tokenDoc]
 * @param {Actor|null} [args.actor]
 * @param {Scene} scene - The subject's scene.
 * @returns {TokenDocument|null}
 */
function rollerTokenOn({ tokenDoc, actor }, scene) {
  if (tokenDoc) return tokenDoc;
  if (!actor || !scene) return null;
  if (actor.isToken) return actor.token?.parent === scene ? actor.token : null;
  const found = scene.tokens.filter(t => t.actorLink && t.actorId === actor.id);
  return found.length === 1 ? found[0] : null;
}

/**
 * The centre of every grid space a token covers, with its elevation. Fractional
 * sizes (a Tiny token) still yield their one true centre.
 *
 * @param {TokenDocument} doc
 * @param {number} size - Grid size in pixels.
 * @returns {Array<{x: number, y: number, elevation: number}>}
 */
function footprint(doc, size) {
  const cols = Math.max(1, Math.round(doc.width));
  const rows = Math.max(1, Math.round(doc.height));
  const stepX = (doc.width * size) / cols;
  const stepY = (doc.height * size) / rows;
  const elevation = doc.elevation ?? 0;
  const points = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      points.push({ x: doc.x + (i + 0.5) * stepX, y: doc.y + (j + 0.5) * stepY, elevation });
    }
  }
  return points;
}

/**
 * Feet between the nearest occupied spaces of two tokens, elevation included
 * (§4.1). Measured on the scene's own grid, so the roller's canvas need not show it.
 *
 * @param {Scene} scene
 * @param {TokenDocument} a
 * @param {TokenDocument} b
 * @returns {number}
 */
function distanceBetween(scene, a, b) {
  const grid = scene.grid;
  const size = grid.size || scene.dimensions?.size || 100;
  let best = Infinity;
  for (const p of footprint(a, size)) {
    for (const q of footprint(b, size)) {
      const d = grid.measurePath([p, q]).distance;
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * The subject penalties for one roll.
 *
 * Never throws and never blocks: anything that cannot be worked out is simply
 * not applied (§4).
 *
 * @param {object} args
 * @param {{type: string, key: string}} args.check - The check being rolled.
 * @param {{tokenUuid: string}|null} args.subject
 * @param {TokenDocument|null} [args.tokenDoc] - The roller's token, when known.
 * @param {Actor|null} [args.actor] - The roller, for the one-token fallback.
 * @returns {{distance: {feet: number, penalty: number}|null,
 *            terms: Array<{value: number, flavor: string}>, total: number}}
 */
export function subjectModifiers({ check, subject, tokenDoc = null, actor = null }) {
  const none = { distance: null, terms: [], total: 0 };
  if (!subject?.tokenUuid || !takesSubject(check)) return none;

  try {
    const subjectDoc = fromUuidSync(subject.tokenUuid);
    const scene = subjectDoc?.parent;
    if (!subjectDoc || !scene) return none;

    const roller = rollerTokenOn({ tokenDoc, actor }, scene);
    if (!roller || roller.parent !== scene) return none;

    const out = { distance: null, terms: [], total: 0 };

    const feet = distanceBetween(scene, roller, subjectDoc);
    if (Number.isFinite(feet)) {
      const penalty = Math.floor(feet / 10);
      out.distance = { feet, penalty };
      if (penalty) out.terms.push({ value: -penalty, flavor: game.i18n.localize("RR.Subject.Distance") });
    }

    out.total = out.terms.reduce((sum, t) => sum + t.value, 0);
    return out;
  } catch (err) {
    console.error(`${MODULE_ID} | Could not work out the subject modifiers:`, err);
    return none;
  }
}

/**
 * Labeled terms as one situational-bonus string: `2[Aid Another] - 3[Distance]`.
 *
 * @param {Array<{value: number, flavor: string}>} terms
 * @returns {string} Empty when there are none.
 */
export function joinTerms(terms) {
  const parts = terms.filter(t => t.value);
  return parts.map((t, i) => {
    const abs = Math.abs(t.value);
    const sign = t.value < 0 ? "-" : "+";
    if (i === 0) return `${t.value < 0 ? "-" : ""}${abs}[${t.flavor}]`;
    return `${sign} ${abs}[${t.flavor}]`;
  }).join(" ");
}
