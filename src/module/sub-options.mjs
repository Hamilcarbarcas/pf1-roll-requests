// ============================================================
// Sub-options — a check's use or categories, supplied by a provider
// (SUB-OPTIONS-SPEC.md). This module owns no vocabulary: it stores, shows and
// passes on string ids that a registered provider defines.
// ============================================================

const MODULE_ID = "pf1-roll-requests";

/** type → provider */
const providers = new Map();

/**
 * Register a provider (SUB-OPTIONS-SPEC §2).
 *
 * @param {object} provider
 * @param {string} provider.id
 * @param {string[]} provider.types - Request types it serves ("save", "skill", "ability").
 * @param {(type: string, key: string) => Array<{id: string, label: string, group?: string}>} provider.options
 * @param {(type: string) => boolean} [provider.multiple]
 * @param {(type: string, key: string) => string[]} [provider.common]
 * @param {(type: string, key: string, current: string[]) => Promise<string[]|null>} [provider.pick]
 * @param {(type: string, key: string, ids: string[]) => object} provider.rollOptions
 * @param {(message: ChatMessage) => string[]} [provider.forMessage]
 */
export function registerSubOptions(provider) {
  if (!provider?.id || !Array.isArray(provider.types) || typeof provider.options !== "function") {
    console.error(`${MODULE_ID} | registerSubOptions: a provider needs id, types and options().`);
    return;
  }
  for (const type of provider.types) {
    const prior = providers.get(type);
    if (prior && prior.id !== provider.id) {
      console.warn(`${MODULE_ID} | sub-options for "${type}" from "${prior.id}" replaced by "${provider.id}".`);
    }
    providers.set(type, provider);
  }
}

export function unregisterSubOptions(id) {
  for (const [type, provider] of providers) if (provider.id === id) providers.delete(type);
}

function call(type, fn, fallback, ...args) {
  const provider = providers.get(type);
  if (typeof provider?.[fn] !== "function") return fallback;
  try {
    return provider[fn](...args) ?? fallback;
  } catch (err) {
    console.error(`${MODULE_ID} | sub-options provider "${provider.id}" failed in ${fn}():`, err);
    return fallback;
  }
}

/** Sub-options for one check; [] when there are none. */
export function subOptionsFor(type, key) {
  return call(type, "options", [], type, key);
}

export function isMultiple(type) {
  return !!call(type, "multiple", false, type);
}

export function commonFor(type, key) {
  return call(type, "common", null, type, key);
}

export function canPick(type) {
  return typeof providers.get(type)?.pick === "function";
}

/** The provider's full selector; resolves to ids, or null when dismissed. */
export async function pickMore(type, key, current) {
  try {
    return (await call(type, "pick", null, type, key, current)) ?? null;
  } catch (err) {
    console.error(`${MODULE_ID} | sub-options pick failed:`, err);
    return null;
  }
}

/** Unique string ids. */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((t) => typeof t === "string" && t))];
}

/** Labels for a check's tags, provider names where known. */
export function tagLabels(check) {
  const tags = normalizeTags(check?.tags);
  if (!tags.length) return [];
  const known = new Map(subOptionsFor(check.type, check.key).map((o) => [o.id, o.label]));
  return tags.map((t) => known.get(t) ?? t);
}

/** "Acrobatics (Jump)", "Will (against Fear, Poison)". */
export function displayName(check) {
  const name = check?.name ?? "";
  const labels = tagLabels(check);
  if (!labels.length) return name;
  return check.type === "save"
    ? game.i18n.format("RR.SubOptions.SaveName", { name, tags: labels.join(", ") })
    : game.i18n.format("RR.SubOptions.CheckName", { name, tags: labels.join(", ") });
}

/** Roll options for a check's tags, merged into rollSkill / rollSavingThrow options. */
export function rollOptionsFor(check) {
  const tags = normalizeTags(check?.tags);
  if (!tags.length) return {};
  return call(check.type, "rollOptions", {}, check.type, check.key, tags);
}

/** Tags a source card implies for a save request (§7). */
export function messageTags(message) {
  return normalizeTags(call("save", "forMessage", [], message));
}
