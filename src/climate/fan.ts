import type { HomeAssistant } from '../types/hass';
import type { EcoseeCardConfig, ShowFan } from '../config';
import { UNAVAILABLE } from './home-view';
import { num } from './parse';
import type { ServiceCall } from './service-call';

// The derivation seam for the Fan sub-screen (the sibling of `toSystemModeModel`).
// `toFanModel` builds an already-degraded view of the Fan overlay from raw `hass` +
// config: the On / Auto toggle derived from the entity's `fan_modes`, plus the
// optional minimum-runtime selector backed by a configured `fan_min_on_time`
// `number` entity (present only when that entity is configured and available —
// ADR-0001 graceful degradation). `setFanModeCall` / `setFanMinOnTimeCall` turn a
// chosen option into its pure service call. The picker owns no edit state: each
// selection is a single discrete write and the highlight follows the entity's
// reported value, so all the vocabulary-reconciliation logic stays here, unit-
// testable without rendering a Lit element.

/** One Fan-mode segment: the raw `fan_mode` string to write back (so we only ever
 *  write a value the entity actually lists), the display label, and whether it is
 *  the current mode. */
export interface FanOption {
  fanMode: string;
  label: string;
  selected: boolean;
  /** The glyph standing in for the label, or `null` when the mode has no
   *  recognized meaning (the selector then falls back to text). */
  icon: FanIcon | null;
}

/** What a fan-mode glyph depicts: a named mode, or a speed as `level` of `of`
 *  ascending bars (the entity's own number of speed steps). */
export type FanIcon =
  | { kind: 'auto' | 'on' | 'off' | 'quiet' | 'turbo' }
  | { kind: 'speed'; level: number; of: number };

/** One selectable minimum-runtime value, in minutes per hour. */
export interface MinRuntimeOption {
  value: number;
  label: string;
  selected: boolean;
}

/** The minimum-runtime selector, present only when a backing `number` entity is
 *  configured and available. `summary` is the dynamic helper line that mirrors the
 *  device copy for the current value. */
export interface MinRuntimeModel {
  entityId: string;
  value: number;
  options: MinRuntimeOption[];
  summary: string;
}

/** One swing-mode segment: the raw `swing_mode` (or `swing_horizontal_mode`) string
 *  to write back, its display label, and whether it is the current value. */
export interface SwingOption {
  swingMode: string;
  label: string;
  selected: boolean;
}

/** Which swing axis a selector drives: Home Assistant's `swing_mode` (vertical /
 *  generic louvre swing) or the separate `swing_horizontal_mode` (HA 2024.12+). */
export type SwingAxis = 'vertical' | 'horizontal';

/** A swing selector, present only when the entity lists modes for that axis. */
export interface SwingModel {
  axis: SwingAxis;
  options: SwingOption[];
}

export interface FanModel {
  /** False when the entity lists neither `fan_modes` nor any swing modes — the
   *  whole sub-screen is hidden. */
  available: boolean;
  /** The fan-mode segments; empty for a swing-only entity. */
  options: FanOption[];
  /** Swing selectors (vertical first, then horizontal), only the axes the entity
   *  supports. Empty when it exposes no swing control. */
  swing: SwingModel[];
  /** Null when no `fan_min_on_time` number entity is configured/available. */
  minRuntime: MinRuntimeModel | null;
}

/** Segment order, left to right: the device's two (reference/fan-mode.jpeg) first,
 *  then any generic-only modes a non-ecobee fan exposes, in the order listed. */
const FAN_ORDER: readonly string[] = ['auto', 'on'];

/** The device's exact labels for its two modes (CONTEXT.md / fan-mode.jpeg). */
const KNOWN_LABELS: Record<string, string> = { auto: 'Auto', on: 'On' };

/** The ecobee `fan_min_on_time` range when the number entity omits its bounds:
 *  0–55 minutes per hour in 5-minute steps. */
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 55;
const DEFAULT_STEP = 5;

/** Title-case a generic `fan_mode` string for display (e.g. `medium_high` →
 *  `Medium High`); known device modes keep their exact label. */
function labelFor(fanMode: string): string {
  const known = KNOWN_LABELS[fanMode];
  if (known) return known;
  return fanMode
    .split('_')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Named, non-speed fan modes and the glyph each maps to. */
const NAMED_ICONS: Record<string, 'auto' | 'on' | 'off' | 'quiet' | 'turbo'> = {
  auto: 'auto',
  on: 'on',
  off: 'off',
  quiet: 'quiet',
  silent: 'quiet',
  sleep: 'quiet',
  night: 'quiet',
  turbo: 'turbo',
  boost: 'turbo',
  powerful: 'turbo',
  strong: 'turbo',
  max: 'turbo',
};

/** Speed modes, slowest → fastest. A mode's bar count is its rank among the speed
 *  modes the entity actually lists, so a 3-speed fan shows 1/3, 2/3, 3/3 and a
 *  5-speed fan 1/5 … 5/5. */
const SPEED_ORDER: readonly string[] = [
  'lowest',
  'low',
  'medium_low',
  'mid_low',
  'medium',
  'mid',
  'middle',
  'medium_high',
  'mid_high',
  'high',
  'highest',
];

function fanIcons(modes: string[]): Map<string, FanIcon> {
  const icons = new Map<string, FanIcon>();
  const speeds = SPEED_ORDER.filter((mode) => modes.includes(mode));
  speeds.forEach((mode, index) =>
    icons.set(mode, { kind: 'speed', level: index + 1, of: speeds.length }),
  );
  for (const mode of modes) {
    const named = NAMED_ICONS[mode];
    if (named) icons.set(mode, { kind: named });
  }
  return icons;
}

/** Order the entity's fan modes: the recognized device modes first (in FAN_ORDER),
 *  then any generic-only modes in the order the entity listed them. Recognized
 *  modes collapse to a single segment even if duplicated. */
function orderFanModes(fanModes: string[]): string[] {
  const known = FAN_ORDER.filter((mode) => fanModes.includes(mode));
  const rest = fanModes.filter((mode) => !FAN_ORDER.includes(mode));
  return [...known, ...rest];
}

/** Kill the floating-point dust a repeated `+= step` accumulates (e.g. 0.5 * 3). */
function tidy(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function runtimeLabel(value: number): string {
  return `${value} min / hr`;
}

function runtimeSummary(value: number): string {
  if (value <= 0) return 'Your fan currently has no minimum runtime.';
  const minutes = value === 1 ? 'minute' : 'minutes';
  return `Your fan currently runs at least ${value} ${minutes} per hour.`;
}

/** Build the selectable runtime grid from the entity's bounds. The current value
 *  is always included and marked selected, even if it falls off the step grid, so
 *  the selector never hides the active setting. */
function runtimeOptions(
  min: number,
  max: number,
  step: number,
  current: number,
): MinRuntimeOption[] {
  const values = new Set<number>([current]);
  if (step > 0 && max >= min) {
    for (let value = min; value <= max + 1e-9; value = tidy(value + step)) {
      values.add(tidy(value));
    }
  }
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: runtimeLabel(value), selected: value === current }));
}

function toMinRuntimeModel(hass: HomeAssistant, config: EcoseeCardConfig): MinRuntimeModel | null {
  const entityId = config.fan_min_on_time_entity;
  if (!entityId) return null;

  const entity = hass.states[entityId];
  if (!entity || UNAVAILABLE.has(entity.state)) return null;

  const value = num(entity.state);
  if (value === null) return null;

  const min = num(entity.attributes.min) ?? DEFAULT_MIN;
  const max = num(entity.attributes.max) ?? DEFAULT_MAX;
  const step = num(entity.attributes.step) ?? DEFAULT_STEP;

  return {
    entityId,
    value,
    options: runtimeOptions(min, max, step, value),
    summary: runtimeSummary(value),
  };
}

const UNAVAILABLE_FAN: FanModel = { available: false, options: [], swing: [], minRuntime: null };

/** The string entries of a list attribute (non-strings dropped, duplicates
 *  collapsed), or `[]` when the attribute is absent or not a list. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

/** Build one swing axis's selector from its `*_modes` list + current value
 *  attributes; null when the entity lists no modes for that axis. */
function toSwingModel(
  attributes: Record<string, unknown>,
  axis: SwingAxis,
  modesKey: string,
  currentKey: string,
): SwingModel | null {
  const modes = stringList(attributes[modesKey]);
  if (modes.length === 0) return null;
  const current = typeof attributes[currentKey] === 'string' ? attributes[currentKey] : null;
  return {
    axis,
    options: modes.map((swingMode) => ({
      swingMode,
      label: labelFor(swingMode),
      selected: swingMode === current,
    })),
  };
}

export function toFanModel(hass: HomeAssistant, config: EcoseeCardConfig): FanModel {
  const entity = hass.states[config.entity];
  if (!entity || UNAVAILABLE.has(entity.state)) return UNAVAILABLE_FAN;

  const attributes = entity.attributes as Record<string, unknown>;
  const current = typeof attributes.fan_mode === 'string' ? attributes.fan_mode : null;

  const modes = orderFanModes(stringList(attributes.fan_modes));
  const icons = fanIcons(modes);
  const options: FanOption[] = modes.map((fanMode) => ({
    fanMode,
    label: labelFor(fanMode),
    selected: fanMode === current,
    icon: icons.get(fanMode) ?? null,
  }));

  const swing = [
    toSwingModel(attributes, 'vertical', 'swing_modes', 'swing_mode'),
    toSwingModel(attributes, 'horizontal', 'swing_horizontal_modes', 'swing_horizontal_mode'),
  ].filter((model): model is SwingModel => model !== null);

  if (options.length === 0 && swing.length === 0) return UNAVAILABLE_FAN;

  return { available: true, options, swing, minRuntime: toMinRuntimeModel(hass, config) };
}

/** Whether the fan offers a genuine *speed* control — at least one mode beyond the
 *  device's On / Auto (e.g. Low / Medium / High). Gates the Home Screen's top-row
 *  fan glyph (issue #73): that corner affordance is a shortcut into real speed
 *  selection, so an On/Auto-only fan shows no glyph. The recognized non-speed modes
 *  are exactly `FAN_ORDER` (the device's two known modes), so a "speed" mode is any
 *  the entity lists outside it. The Fan sub-screen's own availability
 *  (`toFanModel().available`) is deliberately unaffected — On/Auto stays reachable
 *  through Main Menu → Fan. */
export function hasFanSpeedControls(model: FanModel): boolean {
  return model.available && model.options.some((option) => !FAN_ORDER.includes(option.fanMode));
}

/** Whether the Home Screen shows its top-row fan glyph, honoring the `show_fan`
 *  config. `auto` (the default, unset) keeps the issue-#73 rule — the glyph appears
 *  only for a genuine speed control (`hasFanSpeedControls`). `always` shows it
 *  whenever the Fan sub-screen is reachable, so an On/Auto-only fan gets the glyph
 *  too (tapping it opens straight to the On/Auto toggle). `never` hides the glyph
 *  outright. An unavailable fan is never shown regardless (`model.available` is
 *  false). The Fan sub-screen's own reachability via Main Menu → Fan is unaffected —
 *  this governs only the corner shortcut. */
export function showFanAffordance(model: FanModel, showFan: ShowFan | undefined): boolean {
  if (showFan === 'never') return false;
  if (showFan === 'always') return model.available;
  return hasFanSpeedControls(model);
}

/** Build the `climate.set_fan_mode` call that switches the entity to the chosen
 *  mode. Takes the raw `fan_mode` string (an entity-supported value). */
export function setFanModeCall(fanMode: string, entityId: string): ServiceCall {
  return {
    domain: 'climate',
    service: 'set_fan_mode',
    data: { entity_id: entityId, fan_mode: fanMode },
  };
}

/** Build the swing call for the chosen mode on the given axis:
 *  `climate.set_swing_mode` for the vertical / generic axis, or
 *  `climate.set_swing_horizontal_mode` for the horizontal one. */
export function setSwingModeCall(
  swingMode: string,
  axis: SwingAxis,
  entityId: string,
): ServiceCall {
  return axis === 'horizontal'
    ? {
        domain: 'climate',
        service: 'set_swing_horizontal_mode',
        data: { entity_id: entityId, swing_horizontal_mode: swingMode },
      }
    : {
        domain: 'climate',
        service: 'set_swing_mode',
        data: { entity_id: entityId, swing_mode: swingMode },
      };
}

/** Build the `number.set_value` call that sets the fan's minimum hourly runtime on
 *  the configured `fan_min_on_time` number entity. */
export function setFanMinOnTimeCall(value: number, entityId: string): ServiceCall {
  return {
    domain: 'number',
    service: 'set_value',
    data: { entity_id: entityId, value },
  };
}
