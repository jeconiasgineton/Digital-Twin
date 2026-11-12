import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { activeEquipment, amrChargeHours, catalog, defaultEquipment, normalizeEquipment, validateEquipment } from '../src/model/equipment';
import { validate } from '../src/sim/world';
import { exportTemplate, importWorkbook } from '../src/io/excel';

describe('catálogo de equipamentos', () => {
  it('traz os quatro tipos; só a empilhadeira ativa por padrão', () => {
    const sc = defaultScenario();
    expect(catalog(sc).map((e) => e.kind)).toEqual(['forklift', 'palletJack', 'palletTruck', 'amr']);
    expect(activeEquipment(sc).map((e) => e.kind)).toEqual(['forklift']);
  });
  it('padrões do AMR seguem dados públicos e o gatilho de 1/2 da autonomia', () => {
    const a = defaultEquipment('amr');
    expect(a.amr!.autonomyMin).toBe(480);
    expect(a.amr!.chargeTriggerFraction).toBe(0.5);
    expect(a.amr!.chargeMin).toBe(60);
    expect(a.needsOperator).toBe(false);
    expect(a.canLift).toBe(false);
    expect(a.source).toMatch(/MiR1200/);
  });
  it('transpaleteira: 4,5/4,0 km/h convertidos para m/s', () => {
    const t = defaultEquipment('palletTruck');
    expect(t.speedEmpty).toBeCloseTo(1.25, 2);
    expect(t.speedLoaded).toBeCloseTo(1.11, 2);
  });
  it('calendário de carga: início/fim de turno e horários específicos', () => {
    const sc = defaultScenario(); // início 6h, 16h de turno
    const a = defaultEquipment('amr').amr!;
    expect(amrChargeHours(sc, a)).toEqual([]);
    a.chargeAtShiftStart = true;
    a.chargeAtShiftEnd = true;
    a.chargeAtHours = [12, 12, 18.5, 30];
    expect(amrChargeHours(sc, a)).toEqual([6, 12, 18.5, 22]);
  });
  it('validação: AMR sem estação de carga é erro; ciclo carga>operação avisa', () => {
    const sc = defaultScenario();
    sc.equipment[2].count = 3;
    expect(validateEquipment(sc, 0).some((i) => i.level === 'erro' && /estação de carga/.test(i.msg))).toBe(true);
    expect(validateEquipment(sc, 1).some((i) => i.level === 'erro')).toBe(false);
    sc.equipment[2].amr!.autonomyMin = 60; // metade = 30 min < carga 60 + setup 2
    expect(validateEquipment(sc, 1).some((i) => /mais tempo carregando/.test(i.msg))).toBe(true);
    const l = generateLayout(defaultLayoutParams());
    l.elements = l.elements.filter((e) => e.type !== 'charger');
    expect(validate(l, sc).some((i) => /estação de carga/.test(i.msg))).toBe(true);
  });
  it('normalização completa catálogos antigos e satura valores', () => {
    const sc = defaultScenario();
    (sc as any).equipment = undefined;
    sc.forklifts = { count: 2, speedEmpty: 3, speedLoaded: 2, availability: 0.9, costPerHour: 80 } as any;
    normalizeEquipment(sc);
    expect(catalog(sc).length).toBe(4);
    expect(sc.forklifts.canLift).toBe(true);
    sc.equipment[2].amr!.chargeTriggerFraction = 7;
    normalizeEquipment(sc);
    expect(sc.equipment[2].amr!.chargeTriggerFraction).toBe(1);
  });
  it('ida e volta no Excel preserva o catálogo (incluindo AMR e capacidade do operador)', async () => {
    const sc = defaultScenario();
    sc.equipment[0].count = 4;
    sc.equipment[1].speedEmpty = 1.4;
    const amr = sc.equipment[2];
    amr.count = 2;
    amr.amr!.autonomyMin = 360;
    amr.amr!.chargeTriggerFraction = 0.4;
    amr.amr!.chargeAtShiftStart = true;
    amr.amr!.chargeAtHours = [12, 18.5];
    sc.workers.capacityKg = 20;
    const r = await importWorkbook(await exportTemplate(sc, generateLayout(defaultLayoutParams())));
    expect(r.warnings).toEqual([]);
    const e = r.scenario.equipment;
    expect(e[0].count).toBe(4);
    expect(e[1].speedEmpty).toBeCloseTo(1.4, 6);
    expect(e[2].count).toBe(2);
    expect(e[2].amr).toMatchObject({ autonomyMin: 360, chargeMin: 60, setupMin: 2, chargeAtShiftStart: true, chargeAtShiftEnd: false, chargeAtHours: [12, 18.5] });
    expect(e[2].amr!.chargeTriggerFraction).toBeCloseTo(0.4, 6);
    expect(e[2].needsOperator).toBe(false);
    expect(r.scenario.workers.capacityKg).toBe(20);
  });
});
