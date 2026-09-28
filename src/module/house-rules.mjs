// ============================================================
// Pathfinder 1e Roll Requests — House Rules (SUBJECT-SPEC.md §8)
//
// One world setting gates every non-RAW rule in the module. Callers ask here
// rather than reading the setting, so each rule lives in one place.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

export const HOUSE_RULES_SETTING = "house-rules";

/** The setting it replaced; still registered, hidden, so its stored value can be read once. */
export const LEGACY_UNCAP_SETTING = "uncap-aid-another";

/** @returns {boolean} */
export function houseRulesOn() {
  try {
    return game.settings.get(MODULE_ID, HOUSE_RULES_SETTING) === true;
  } catch {
    return false;
  }
}

/**
 * The bonus an Aid Another result grants: +2 on a 10 or better, and with House
 * Rules on, +1 more per full 5 over 10.
 *
 * @param {number} total
 * @returns {number} 0 on a failed aid.
 */
export function aidBonusFor(total) {
  if (!(total >= 10)) return 0;
  return 2 + (houseRulesOn() ? Math.floor((total - 10) / 5) : 0);
}

/**
 * The DC to identify a spell as it is being cast: 15 + spell level, and with
 * House Rules on, +5 for each of the verbal and somatic components it lacks.
 *
 * @param {object} spell
 * @param {number} spell.level
 * @param {boolean} [spell.verbal=true]
 * @param {boolean} [spell.somatic=true]
 * @returns {number}
 */
export function spellcraftDC({ level, verbal = true, somatic = true } = {}) {
  let dc = 15 + (Number(level) || 0);
  if (houseRulesOn()) {
    if (!verbal) dc += 5;
    if (!somatic) dc += 5;
  }
  return dc;
}

/**
 * Carry a stored "Uncap Aid Another" value into House Rules, once. Runs on the
 * first active GM, only where the old key was ever saved and the new one never was.
 */
export async function migrateLegacySetting() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const storage = game.settings.storage.get("world");
  const legacy = storage?.getSetting?.(`${MODULE_ID}.${LEGACY_UNCAP_SETTING}`);
  const current = storage?.getSetting?.(`${MODULE_ID}.${HOUSE_RULES_SETTING}`);
  if (!legacy || current) return;
  try {
    const value = game.settings.get(MODULE_ID, LEGACY_UNCAP_SETTING) === true;
    await game.settings.set(MODULE_ID, HOUSE_RULES_SETTING, value);
    console.log(`${MODULE_ID} | Carried "Uncap Aid Another" (${value}) into House Rules.`);
  } catch (err) {
    console.error(`${MODULE_ID} | Could not migrate "Uncap Aid Another" into House Rules:`, err);
  }
}
