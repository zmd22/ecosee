import type { HomeAssistant, HassEntityBase } from '../types/hass';
import type { EcoseeCardConfig } from '../config';
import { num } from './parse';

// The battery-indicator seam. `toBattery` resolves the bound thermostat's battery
// from raw `hass` + config into an already-degraded view: `null` whenever no
// battery source resolves (the indicator is then hidden — ADR-0001).
//
// Source order:
//   1. an explicit `battery_entity` (a `%` sensor, or a battery binary_sensor);
//   2. a `battery_level` / `battery` attribute on the climate entity itself;
//   3. auto-pairing (like ADR-0010's occupancy pairing): a `sensor` with
//      device_class `battery` on the climate entity's device, else such a
//      `binary_sensor` (on = low).
// `hide_battery` turns the indicator off outright.

export interface BatteryView {
  /** Charge in percent (0–100, rounded), or `null` for a low/OK-only source. */
  level: number | null;
  /** At or below LOW_BATTERY_PERCENT, or a battery binary_sensor reporting `on`. */
  low: boolean;
}

/** The charge at or below which the indicator switches to its warning color. */
export const LOW_BATTERY_PERCENT = 20;

const UNUSABLE = new Set(['unavailable', 'unknown', 'none', '']);
const BATTERY_DEVICE_CLASS = 'battery';

function fromPercent(value: number | null): BatteryView | null {
  if (value === null) return null;
  const level = Math.round(Math.min(100, Math.max(0, value)));
  return { level, low: level <= LOW_BATTERY_PERCENT };
}

/** Read a battery entity: a binary_sensor is low/OK only; anything else is a
 *  percentage in its state. */
function fromEntity(entity: HassEntityBase | undefined): BatteryView | null {
  if (!entity || UNUSABLE.has(entity.state)) return null;
  if (entity.entity_id.startsWith('binary_sensor.')) {
    return { level: null, low: entity.state === 'on' };
  }
  return fromPercent(num(entity.state));
}

/** Find a battery entity sharing the climate entity's device: a percentage
 *  `sensor` wins over a low/OK `binary_sensor`. */
function autoPairBattery(hass: HomeAssistant, climateEntityId: string): string | undefined {
  const registry = hass.entities;
  if (!registry) return undefined;
  const deviceId = registry[climateEntityId]?.device_id;
  if (!deviceId) return undefined;
  let binary: string | undefined;
  for (const [id, entry] of Object.entries(registry)) {
    if (entry.device_id !== deviceId) continue;
    const state = hass.states[id];
    if (state?.attributes.device_class !== BATTERY_DEVICE_CLASS) continue;
    if (id.startsWith('sensor.')) return id;
    if (id.startsWith('binary_sensor.') && binary === undefined) binary = id;
  }
  return binary;
}

export function toBattery(hass: HomeAssistant, config: EcoseeCardConfig): BatteryView | null {
  if (config.hide_battery) return null;
  if (config.battery_entity) return fromEntity(hass.states[config.battery_entity]);

  const climate = hass.states[config.entity];
  if (!climate) return null;
  const attrs = climate.attributes;
  const own = fromPercent(num(attrs.battery_level) ?? num(attrs.battery));
  if (own) return own;

  const paired = autoPairBattery(hass, config.entity);
  return paired ? fromEntity(hass.states[paired]) : null;
}
