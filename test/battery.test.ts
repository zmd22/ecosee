import { describe, it, expect } from 'vitest';
import { toBattery } from '../src/climate/battery';
import type { EcoseeCardConfig } from '../src/config';
import type { HassEntityBase, HomeAssistant, HassEntityRegistryEntry } from '../src/types/hass';

const config: EcoseeCardConfig = { type: 'custom:ecosee-card', entity: 'climate.t' };

function hass(
  entities: HassEntityBase[],
  registry?: Record<string, HassEntityRegistryEntry>,
): HomeAssistant {
  const states: Record<string, HassEntityBase> = {};
  for (const entity of entities) states[entity.entity_id] = entity;
  return {
    states,
    entities: registry,
    config: { unit_system: { temperature: '°F' } },
    callService: async () => undefined,
  };
}

const climate = (attributes: Record<string, unknown> = {}): HassEntityBase => ({
  entity_id: 'climate.t',
  state: 'heat',
  attributes,
});
const entity = (id: string, state: string, deviceClass = 'battery'): HassEntityBase => ({
  entity_id: id,
  state,
  attributes: { device_class: deviceClass },
});

describe('toBattery', () => {
  it('is null when no battery source resolves', () => {
    expect(toBattery(hass([climate()]), config)).toBeNull();
  });

  it('reads the climate entity’s battery_level attribute', () => {
    expect(toBattery(hass([climate({ battery_level: 87 })]), config)).toEqual({
      level: 87,
      low: false,
    });
  });

  it('reads a `battery` attribute and flags 20% or below as low', () => {
    expect(toBattery(hass([climate({ battery: '20' })]), config)).toEqual({
      level: 20,
      low: true,
    });
  });

  it('prefers an explicit battery_entity over the attribute', () => {
    const h = hass([climate({ battery_level: 90 }), entity('sensor.b', '55')]);
    expect(toBattery(h, { ...config, battery_entity: 'sensor.b' })).toEqual({
      level: 55,
      low: false,
    });
  });

  it('is null when the explicit battery_entity is unavailable', () => {
    const h = hass([climate({ battery_level: 90 }), entity('sensor.b', 'unavailable')]);
    expect(toBattery(h, { ...config, battery_entity: 'sensor.b' })).toBeNull();
  });

  it('auto-pairs a battery sensor on the thermostat’s device', () => {
    const h = hass(
      [
        climate(),
        entity('sensor.other', '40'),
        entity('sensor.t_battery', '64'),
        entity('sensor.t_temp', '70', 'temperature'),
      ],
      {
        'climate.t': { entity_id: 'climate.t', device_id: 'dev1' },
        'sensor.other': { entity_id: 'sensor.other', device_id: 'dev2' },
        'sensor.t_temp': { entity_id: 'sensor.t_temp', device_id: 'dev1' },
        'sensor.t_battery': { entity_id: 'sensor.t_battery', device_id: 'dev1' },
      },
    );
    expect(toBattery(h, config)).toEqual({ level: 64, low: false });
  });

  it('falls back to a low/OK battery binary_sensor on the device', () => {
    const h = hass([climate(), entity('binary_sensor.t_battery', 'on')], {
      'climate.t': { entity_id: 'climate.t', device_id: 'dev1' },
      'binary_sensor.t_battery': { entity_id: 'binary_sensor.t_battery', device_id: 'dev1' },
    });
    expect(toBattery(h, config)).toEqual({ level: null, low: true });
  });

  it('is null when hide_battery is set', () => {
    expect(
      toBattery(hass([climate({ battery_level: 50 })]), { ...config, hide_battery: true }),
    ).toBeNull();
  });
});
