// ============================================================
// Pathfinder 1e Roll Requests — Roll Category & Quick Action Definitions
// ============================================================
//
// Shared registries used by the Roll Request dialog (to render options) and
// the Roll Options config window (to toggle visibility).

import { MonsterLore } from "./apps/MonsterLore.mjs";

/**
 * The selectable roll categories shown in the request-options grid, in display
 * order. Each can be hidden via the "excluded-categories" world setting.
 *
 * `text` must match the header rendered by RollRequestDialog so the config
 * window and the dialog stay in sync.
 */
// `text` values are i18n keys, localized at the point they are rendered.
export const ROLL_CATEGORIES = [
  { id: "ability", text: "RR.Category.Ability" },
  { id: "save", text: "RR.Category.Save" },
  { id: "skill", text: "RR.Category.Skill" },
  { id: "dice", text: "RR.Category.Dice" },
  { id: "quick", text: "RR.Category.Quick" },
];

/**
 * Quick Actions execute immediately with baked-in settings, bypassing the
 * left-hand panel of the Roll Request dialog. Each can be hidden via the
 * "excluded-quick-actions" world setting.
 *
 * @typedef {object} QuickAction
 * @property {string} key           - Stable identifier (used for the exclude list).
 * @property {string} label         - Display label in the grid.
 * @property {object} request       - { type, key, name } describing the roll.
 * @property {boolean} promptActors - When true, open an actor-selection popup
 *                                    (all selected by default) before firing.
 * @property {boolean} useSelectedTokens - When true, target the tokens currently
 *                                    selected on the canvas instead of prompting.
 * @property {boolean} promptOptions - When true, ask for a DC and flavor text
 *                                    first; both may be left blank.
 * @property {object} config        - Baked-in request settings mirroring the
 *                                    fields produced by the main dialog.
 */
export const QUICK_ACTIONS = [
  {
    key: "spot",
    label: "RR.Quick.Spot",
    icon: "fa-eye",
    request: { type: "skill", key: "per", name: "RR.Quick.SpotRollName" },
    promptActors: true,
    config: {
      mode: "targeted",
      dc: null,
      showDC: false,
      showResults: false,
      // Public chat card, but roll totals are hidden from players (GM sees them).
      rollMode: "publicblind",
      includeAid: false,
    },
  },
  {
    // Same check as Spot Checks, but taken from the canvas selection rather than
    // an actor list — and with a DC/flavor popup in front of it.
    key: "quick-perception",
    label: "RR.Quick.Perception",
    icon: "fa-binoculars",
    request: { type: "skill", key: "per", name: "RR.Quick.SpotRollName" },
    useSelectedTokens: true,
    promptOptions: true,
    config: {
      mode: "targeted",
      dc: null,
      showDC: false,
      showResults: false,
      // Public chat card, but roll totals are hidden from players (GM sees them).
      rollMode: "publicblind",
      includeAid: false,
      // A DC entered in the popup must not turn into "you cannot succeed" warnings:
      // that tells a player how hard a check they were never shown the DC for is.
      allowUnpassable: true,
    },
  },
  {
    // Opens the Monster Lore window (callback-style built-in) rather than
    // firing a declarative request; the window builds and sends its own
    // Knowledge multi-check. Closes the Roll Request dialog on use.
    key: "monster-lore",
    label: "RR.Quick.MonsterLore",
    icon: "fa-dragon",
    closeOnUse: true,
    callback: () => MonsterLore.openWindow(),
  },
];

// ------------------------------------------------------------
// External quick action registry (public API)
// ------------------------------------------------------------

/** @type {Map<string, object>} key → externally-registered quick action */
const externalQuickActions = new Map();

/**
 * Register a quick action button contributed by another module. The button
 * appears in the Quick Actions category and runs `callback` when clicked.
 *
 * @param {object} definition
 * @param {string} definition.key            - Stable unique identifier.
 * @param {string} [definition.label]        - Button label (defaults to `key`).
 * @param {string} [definition.icon]         - Font Awesome icon class (default "fa-bolt").
 * @param {boolean} [definition.promptActors] - Show the actor picker first and pass
 *                                              the selection to the callback (default false).
 * @param {boolean} [definition.allActors]   - Pass every eligible actor to the callback
 *                                              without prompting (default false). Ignored
 *                                              when `promptActors` is true.
 * @param {boolean} [definition.useSelectedTokens] - Pass the tokens currently selected on
 *                                              the canvas as the actor list (default false).
 *                                              Entries are keyed by *token* id and carry a
 *                                              `tokenUUID`. Aborts with a warning when
 *                                              nothing is selected. Ignored when
 *                                              `promptActors` is true.
 * @param {boolean} [definition.promptOptions] - Ask for a DC and flavor text before running,
 *                                              both optional, and pass them to the callback
 *                                              as `options` (default false). Cancelling the
 *                                              popup aborts the action.
 * @param {boolean} [definition.closeOnUse]  - Close the Roll Request window after the
 *                                              callback resolves (default false).
 * @param {(context: {app: object, actors: Array<{id: string, name: string, img: string, tokenUUID?: string}>|null, options: {dc: number|null, flavor: string}|null, event: Event}) => any} definition.callback
 *        Invoked when the button is clicked.
 * @returns {string} The registered key.
 */
export function registerQuickAction(definition) {
  if (!definition || typeof definition.key !== "string" || !definition.key) {
    throw new Error("pf1-roll-requests | registerQuickAction requires a non-empty string 'key'.");
  }
  if (typeof definition.callback !== "function") {
    throw new Error(`pf1-roll-requests | Quick action '${definition.key}' requires a 'callback' function.`);
  }
  if (QUICK_ACTIONS.some(a => a.key === definition.key) || externalQuickActions.has(definition.key)) {
    console.warn(`pf1-roll-requests | Quick action '${definition.key}' is already registered; overwriting.`);
  }
  externalQuickActions.set(definition.key, {
    key: definition.key,
    label: definition.label ?? definition.key,
    icon: definition.icon ?? "fa-bolt",
    promptActors: definition.promptActors ?? false,
    allActors: definition.allActors ?? false,
    useSelectedTokens: definition.useSelectedTokens ?? false,
    promptOptions: definition.promptOptions ?? false,
    closeOnUse: definition.closeOnUse ?? false,
    callback: definition.callback,
    external: true,
  });
  return definition.key;
}

/**
 * Remove a previously registered external quick action.
 *
 * @param {string} key
 * @returns {boolean} True if an action was removed.
 */
export function unregisterQuickAction(key) {
  return externalQuickActions.delete(key);
}

/**
 * All quick actions in display order: built-ins followed by external ones.
 *
 * @returns {object[]}
 */
export function getQuickActions() {
  return [...QUICK_ACTIONS, ...externalQuickActions.values()];
}
