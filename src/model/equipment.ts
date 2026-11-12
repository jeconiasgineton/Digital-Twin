import type { AmrSpec, EquipmentKind, EquipmentSpec, Scenario } from './types';

/** NIOSH, equação revisada de levantamento: constante de carga de 23 kg em condições ideais. */
export const NIOSH_LOAD_KG = 23;

const kmh = (v: number) => +(v / 3.6).toFixed(2);

export const EQUIPMENT_NAMES: Record<EquipmentKind, string> = {
  forklift: 'Empilhadeira',
  palletJack: 'Paleteira manual',
  palletTruck: 'Transpaleteira elétrica',
  amr: 'AMR (robô móvel autônomo)',
};

/**
 * Padrões do catálogo. Onde há dado público, a fonte está indicada; onde não há, o valor é premissa
 * típica de mercado e está marcado como tal. Tudo é editável pelo usuário.
 */
export const EQUIPMENT_SOURCES: Record<EquipmentKind, string> = {
  forklift: 'Premissa típica (empilhadeira contrabalançada elétrica, 10,8 km/h vazia): confirme na ficha do fabricante.',
  palletJack: 'Premissa: ritmo de caminhada com carga empurrada (1,2 m/s vazia, 1,0 m/s carregada); capacidade nominal usual de 2.000 kg. Sem ficha de fabricante consultada.',
  palletTruck: 'Fichas públicas de transpaleteiras elétricas 2.000 kg com operador a pé (EP ET208, Gogopower CBD20, NPT20C): 4,5 km/h vazia e 4,0 km/h carregada.',
  amr: 'Fichas públicas de AMR para paletes (MiR1200: 1.200 kg, 1,5 m/s, 7h40 de operação, carga 10–90% em 52 min; OTTO 1500: 10 h, 60 min; igus ReBeL: 6–10 h, 1–2 h): autonomia 8 h, carga 60 min, 1.200 kg. Setup de 2 min é premissa (sem dado público).',
};

export function defaultAmr(): AmrSpec {
  return { autonomyMin: 480, chargeTriggerFraction: 0.5, chargeMin: 60, setupMin: 2, chargeAtShiftStart: false, chargeAtShiftEnd: false, chargeAtHours: [] };
}

export function defaultEquipment(kind: EquipmentKind, count = 0): EquipmentSpec {
  const base = { kind, name: EQUIPMENT_NAMES[kind], count, source: EQUIPMENT_SOURCES[kind] };
  switch (kind) {
    case 'forklift':
      return { ...base, speedEmpty: 3.0, speedLoaded: 2.2, availability: 0.94, costPerHour: 85, palletsPerTrip: 1, capacityKg: 2000, canLift: true, needsOperator: true };
    case 'palletJack':
      return { ...base, speedEmpty: 1.2, speedLoaded: 1.0, availability: 0.98, costPerHour: 6, palletsPerTrip: 1, capacityKg: 2000, canLift: false, needsOperator: true };
    case 'palletTruck':
      return { ...base, speedEmpty: kmh(4.5), speedLoaded: kmh(4.0), availability: 0.95, costPerHour: 22, palletsPerTrip: 1, capacityKg: 2000, canLift: false, needsOperator: true };
    case 'amr':
      return { ...base, speedEmpty: 1.5, speedLoaded: 1.2, availability: 0.95, costPerHour: 40, palletsPerTrip: 1, capacityKg: 1200, canLift: false, needsOperator: false, amr: defaultAmr() };
  }
}

/** catálogo completo (empilhadeira + demais), na ordem de exibição */
export const catalog = (sc: Scenario): EquipmentSpec[] => [sc.forklifts, ...sc.equipment];

export const equipmentOf = (sc: Scenario, kind: EquipmentKind): EquipmentSpec | undefined => catalog(sc).find((e) => e.kind === kind);

/** equipamentos em uso (quantidade > 0) */
export const activeEquipment = (sc: Scenario): EquipmentSpec[] => catalog(sc).filter((e) => e.count > 0);

/**
 * Horários (h, 0–24, ordenados) em que os AMR vão carregar por calendário: início e/ou fim do turno
 * mais os horários específicos informados. O gatilho por autonomia é independente deste calendário.
 */
export function amrChargeHours(sc: Scenario, amr: AmrSpec): number[] {
  const set = new Set<number>();
  if (amr.chargeAtShiftStart) set.add(sc.startHour % 24);
  if (amr.chargeAtShiftEnd) set.add((sc.startHour + sc.shiftHours) % 24);
  for (const h of amr.chargeAtHours) if (Number.isFinite(h) && h >= 0 && h < 24) set.add(+h.toFixed(2));
  return [...set].sort((a, b) => a - b);
}

/** garante um catálogo completo e saneado (planilhas/arquivos antigos, valores fora de faixa) */
export function normalizeEquipment(sc: Scenario): void {
  const kinds: EquipmentKind[] = ['palletJack', 'palletTruck', 'amr'];
  const cur = Array.isArray(sc.equipment) ? sc.equipment : [];
  sc.equipment = kinds.map((k) => ({ ...defaultEquipment(k, 0), ...(cur.find((e) => e.kind === k) ?? {}) }));
  sc.forklifts = { ...defaultEquipment('forklift', sc.forklifts?.count ?? 0), ...sc.forklifts };
  for (const e of catalog(sc)) {
    e.count = Math.max(0, Math.round(e.count));
    e.palletsPerTrip = Math.max(1, Math.round(e.palletsPerTrip));
    e.capacityKg = Math.max(1, e.capacityKg);
    if (e.kind === 'amr') {
      e.needsOperator = false;
      e.amr = { ...defaultAmr(), ...e.amr };
      e.amr.autonomyMin = Math.max(1, e.amr.autonomyMin);
      e.amr.chargeTriggerFraction = Math.min(1, Math.max(0.05, e.amr.chargeTriggerFraction));
      e.amr.chargeMin = Math.max(0, e.amr.chargeMin);
      e.amr.setupMin = Math.max(0, e.amr.setupMin);
    }
  }
}

export interface EquipmentIssue {
  level: 'erro' | 'aviso';
  msg: string;
}

export function validateEquipment(sc: Scenario, chargers: number): EquipmentIssue[] {
  const out: EquipmentIssue[] = [];
  const amr = equipmentOf(sc, 'amr');
  if (amr && amr.count > 0) {
    if (chargers < 1) out.push({ level: 'erro', msg: 'Há AMR configurado, mas não há estação de carga no layout (ferramenta "Carga AMR").' });
    else if (chargers < amr.count / 4) out.push({ level: 'aviso', msg: `${chargers} vaga(s) de carga para ${amr.count} AMR: podem se formar filas na carga.` });
    const a = amr.amr!;
    if (a.chargeTriggerFraction * a.autonomyMin <= a.chargeMin + a.setupMin)
      out.push({ level: 'aviso', msg: 'O AMR passa mais tempo carregando do que operando entre cargas: revise autonomia, gatilho e tempo de carga.' });
  }
  const needsPeople = activeEquipment(sc).some((e) => e.needsOperator && e.kind !== 'forklift');
  if (needsPeople && sc.workers.count + sc.checkers.count < 1) out.push({ level: 'aviso', msg: 'Há paleteira/transpaleteira configurada, mas não há operadores para conduzi-las.' });
  const lifters = catalog(sc).filter((e) => e.canLift && e.count > 0);
  if (!lifters.length) out.push({ level: 'aviso', msg: 'Nenhum equipamento com elevação configurado (empilhadeira): não há como guardar paletes nos níveis dos racks.' });
  return out;
}
