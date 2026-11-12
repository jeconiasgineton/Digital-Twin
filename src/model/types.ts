/**
 * Modelo de domínio do Digital Twin logístico.
 * Unidades: metros (m), segundos (s), graus (°). Eixos: X (leste), Z (sul), Y (altura).
 * Ângulo `rot` é a rotação em torno de Y, em graus (sentido horário visto de cima).
 */

export type ElementType =
  | 'rack' // estrutura porta-paletes
  | 'dockIn' // doca de recebimento
  | 'dockOut' // doca de expedição
  | 'conveyor' // esteira
  | 'wall' // parede / limite
  | 'zone' // área (staging, picking, etc.)
  | 'station' // estação (embalagem/conferência)
  | 'parking' // área de estacionamento de empilhadeiras/operários
  | 'aisle' // rua (corredor entre racks)
  | 'transit' // endereço transitório: local da rua onde o palete é deixado entre as etapas da armazenagem faseada
  | 'stage' // área de stage do recebimento (paletes no chão aguardando conferência)
  | 'triage' // área de triagem (destino das caixas/paletes avariados)
  | 'charger'; // estação de carga de AMR

export interface LayoutElement {
  id: string;
  type: ElementType;
  name: string;
  /** centro do elemento (para wall/conveyor: ponto inicial) */
  x: number;
  z: number;
  rot: number;
  /** comprimento ao longo do eixo local X */
  length: number;
  /** largura/profundidade ao longo do eixo local Z */
  width: number;
  /** racks: vãos (baias) ao longo do comprimento */
  bays?: number;
  /** racks: níveis de armazenagem */
  levels?: number;
  /** racks: 1 = simples, 2 = duplo (costas com costas) */
  rows?: number;
  /** racks: true => face de picking (nível 0 para separação de caixas) */
  pickFace?: boolean;
  /** esteiras: velocidade (m/s) */
  speed?: number;
  /** stage, endereço transitório, triagem: capacidade em paletes; estação de carga: nº de vagas. Vazio = calculada pela área */
  capacity?: number;
  /** rua: código/letra da rua (ex.: "A"); endereço transitório: rua a que pertence (vazio = rua que contém o elemento) */
  aisle?: string;
  /** triagem: ordem de uso (1 = primeira; ao lotar, o palete segue para a próxima) */
  priority?: number;
  /** racks: rua da face frontal (+Z local) e da face de trás (−Z local); vazio = a rua mais próxima daquele lado */
  aisleFront?: string;
  aisleBack?: string;
}

export interface Layout {
  name: string;
  /** dimensões do piso */
  floor: { width: number; depth: number };
  elements: LayoutElement[];
  /** planta de fundo (imagem) para decalque */
  underlay?: { dataUrl: string; widthM: number; x: number; z: number; opacity: number };
}

export type DistKind = 'constant' | 'triangular' | 'normal' | 'lognormal' | 'exponential' | 'uniform';

/** Distribuição de probabilidade paramétrica (todos os tempos em segundos). */
export interface Dist {
  kind: DistKind;
  /** constant: valor | triangular: min | normal/lognormal: média | exponential: média | uniform: min */
  a: number;
  /** triangular: moda | normal/lognormal: desvio | uniform: max */
  b?: number;
  /** triangular: max */
  c?: number;
}

export interface FleetSpec {
  /** carga manual máxima por operador (kg) – referência ergonômica (NIOSH: 23 kg); opcional */
  capacityKg?: number;
  count: number;
  speedEmpty: number; // m/s
  speedLoaded: number; // m/s
  /** disponibilidade operacional (0-1): fração do tempo sem quebra/parada */
  availability: number;
  costPerHour: number;
}

export type EquipmentKind = 'forklift' | 'palletJack' | 'palletTruck' | 'amr';

/** parâmetros próprios do AMR: autonomia, carregamento e setup */
export interface AmrSpec {
  /** autonomia da bateria em operação contínua (min) */
  autonomyMin: number;
  /** fração da autonomia consumida que dispara a ida à carga (0,5 = metade da autonomia) */
  chargeTriggerFraction: number;
  /** tempo de carregamento na estação (min) */
  chargeMin: number;
  /** tempo de setup (min) a cada carregamento: acoplar, calibrar, retomar a missão */
  setupMin: number;
  /** também carrega no início / no fim do turno */
  chargeAtShiftStart: boolean;
  chargeAtShiftEnd: boolean;
  /** horários do dia (0–24 h) em que todos os AMR vão carregar, além do gatilho por autonomia */
  chargeAtHours: number[];
}

/** equipamento de movimentação do catálogo (empilhadeira, paleteira manual, transpaleteira elétrica, AMR) */
export interface EquipmentSpec extends FleetSpec {
  kind: EquipmentKind;
  name: string;
  /** paletes transportados por viagem */
  palletsPerTrip: number;
  /** capacidade nominal de carga (kg) */
  capacityKg: number;
  /** eleva o palete até os níveis do rack (empilhadeira); sem elevação só opera no piso */
  canLift: boolean;
  /** precisa de um operador (pessoa) para funcionar; o AMR dispensa */
  needsOperator: boolean;
  /** só AMR */
  amr?: AmrSpec;
  /** origem dos valores padrão (dado público ou premissa) */
  source?: string;
}

export type SlottingPolicy = 'abc' | 'nearest' | 'random';

export interface SkuSpec {
  sku: string;
  description: string;
  cls: 'A' | 'B' | 'C';
  /** participação no giro (movimentação) – normalizada */
  share: number;
  cartonsPerPallet: number;
}

/* ---------- veículos, chegadas e calendário ---------- */

/** tipo de veículo: define tempo de docagem (manobra) e carga; ex.: carreta 3 min, truck 1 min */
export interface VehicleType {
  id: string;
  name: string;
  /** participação na frota que chega (normalizada; vale para recebimento e expedição) */
  share: number;
  /** tempo de manobra/docagem (s) */
  dockTurnover: Dist;
  /** paletes por veículo */
  pallets: { mean: number; sd: number; max: number };
  /** comprimento do baú (m): distância de movimentação dentro do baú (usada no recebimento) */
  trailerLengthM: number;
}

export type ArrivalMode = 'poisson' | 'fixed' | 'scheduled';

export interface ArrivalSpec {
  /** poisson: taxa por hora do dia (aba Demanda) · fixed: um veículo a cada X min · scheduled: horários da agenda */
  mode: ArrivalMode;
  /** fixed: intervalo entre chegadas (min) */
  intervalMin: number;
  /** scheduled: horários agendados (hora do dia, ex.: 6.5 = 06:30), repetidos todos os dias */
  scheduleHours: number[];
  /** fixed/scheduled: probabilidade de o veículo chegar atrasado (0–1) */
  delayProb: number;
  /** atraso (minutos) quando atrasado */
  delayMin: Dist;
}

export type PeopleRole = 'forklift' | 'worker' | 'checker' | 'mover';

export interface BreakSpec {
  name: string;
  /** hora do dia em que o intervalo começa (0–24) */
  startHour: number;
  durationMin: number;
  /** quem para: grupos específicos (todos marcados = todas as pessoas) */
  groups: PeopleRole[];
  /** como a equipe sai: todos juntos, metade por vez ou um percentual por vez (em ondas sucessivas) */
  stagger: 'all' | 'half' | 'percent';
  percentPerWave: number;
}

export interface WorkCalendar {
  breaks: BreakSpec[];
  /** AMR continuam trabalhando durante os intervalos das pessoas? */
  amrWorksDuringBreaks: boolean;
}

export type StorageMode = 'direct' | 'phased';

/** armazenagem: direta (empilhadeira leva do stage ao endereço) ou faseada (etapa 1 sem elevação até a rua; etapa 2 elevação) */
export interface StorageSpec {
  mode: StorageMode;
  /** faseada: equipamentos sem elevação que fazem a etapa 1 (o disponível é acionado) */
  step1With: EquipmentKind[];
}

/** recebimento: descarga, conferência, avarias e triagem */
export interface ReceivingSpec {
  /** probabilidade de um palete conferido estar avariado (0–1); só vale com conferentes (a conferência é quem detecta) */
  damagePalletPct: number;
  /** fração das caixas avariadas dentro de um palete avariado (0–1); 100% => o palete vai inteiro para a triagem */
  damagedCartonsFraction: Dist;
  /** multiplicador do tempo de conferência de um palete avariado (1,5 = +50%) */
  damagedCheckFactor: number;
  /** equipamentos que podem descarregar o baú; o disponível é acionado */
  unloadWith: EquipmentKind[];
  /** distância dentro do baú conforme o comprimento do veículo */
  trailerDepth: boolean;
  /** as áreas de triagem são esvaziadas (coleta/descarte) a cada N horas; 0 = nunca */
  triageClearEveryHours: number;
}

export interface Scenario {
  name: string;
  // horizonte
  shiftHours: number;
  startHour: number;
  days: number;
  warmupHours: number;
  replications: number;
  seed: number;
  // metas de dimensionamento
  targetUtilization: number;
  targetWaitP95Min: number;
  serviceLevel: number;
  // recursos
  forklifts: EquipmentSpec;
  /** demais equipamentos do catálogo (paleteira manual, transpaleteira elétrica, AMR); quantidade 0 = não usado */
  equipment: EquipmentSpec[];
  workers: FleetSpec;
  /** pessoas dedicadas a conferência no recebimento (opcional, 0 = ninguém) */
  checkers: FleetSpec;
  // demanda por hora do dia (24 posições)
  inboundTrucksPerHour: number[];
  outboundTrucksPerHour: number[];
  ordersPerHour: number[];
  palletsPerTruckIn: { mean: number; sd: number; max: number };
  palletsPerTruckOut: { mean: number; sd: number; max: number };
  linesPerOrder: { mean: number };
  cartonsPerLine: { mean: number; sd: number };
  // tempos de operação
  ops: {
    unloadPallet: Dist; // retirar palete do caminhão
    checkPallet: Dist; // conferência por palete
    putawayPosition: Dist; // posicionamento no rack (além do tempo de elevação)
    loadPallet: Dist; // carregar palete no caminhão
    pickCarton: Dist; // separar uma caixa
    dockTurnover: Dist; // manobra/troca de caminhão na doca
    triageCarton: Dist; // triagem: tempo para mover uma caixa avariada para o palete de avarias
    packOrder: Dist; // consolidar pedido na estação
  };
  liftSpeed: number; // m/s (garfo)
  levelHeight: number; // m entre níveis
  accel: number; // m/s²
  conveyorSpacing: number; // m entre caixas (headway)
  // estoque
  initialOccupancy: number; // 0-1
  dwellDays: number; // tempo médio de permanência de paletes no estoque (dias)
  slotting: SlottingPolicy;
  skus: SkuSpec[];
  /** multiplicador global de demanda (para sensibilidade) */
  demandFactor: number;
  /** tipos de veículo; vazio = um tipo único (paletes por caminhão e manobra gerais) */
  vehicleTypes: VehicleType[];
  arrivalsIn: ArrivalSpec;
  arrivalsOut: ArrivalSpec;
  /** espera na doca acima da qual o caminhão conta como "gargalo" (min) */
  dockWaitThresholdMin: number;
  calendar: WorkCalendar;
  receiving: ReceivingSpec;
  storage: StorageSpec;
}

/* ---------- resultados ---------- */

export interface SummaryStat {
  mean: number;
  sd: number;
  ci95: number; // half-width
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  n: number;
}

export interface RunKpis {
  // volumes (por dia operacional)
  palletsInPerDay: number;
  palletsOutPerDay: number;
  ordersPerDay: number;
  linesPerDay: number;
  cartonsPerDay: number;
  trucksInPerDay: number;
  trucksOutPerDay: number;
  // utilização
  utilForklift: number;
  utilWorker: number;
  utilChecker: number;
  utilDockIn: number;
  utilDockOut: number;
  utilConveyor: number;
  // filas / tempos (min)
  waitForkliftMean: number;
  waitForkliftP95: number;
  waitWorkerMean: number;
  waitWorkerP95: number;
  dockWaitIn: number;
  dockWaitInP95: number;
  dockWaitOut: number;
  dockWaitOutP95: number;
  truckTurnaroundIn: number;
  truckTurnaroundOut: number;
  orderCycleMean: number;
  orderCycleP95: number;
  putawayLeadMean: number; // do descarregamento ao armazenamento (min)
  // estoque
  occupancyMean: number;
  occupancyMax: number;
  stockoutRate: number; // fração de paletes solicitados sem estoque
  overflowRate: number; // fração de paletes sem posição livre
  // produtividade
  palletsPerForkliftHour: number;
  linesPerWorkerHour: number;
  kmPerForklift: number;
  kmPerWorker: number;
  costPerPallet: number;
  totalCost: number;
  backlogOrders: number;
  backlogPallets: number;
  // chegadas e docagem
  trucksDelayedPct: number; // % de veículos agendados que chegaram atrasados
  truckDelayMean: number; // atraso médio dos atrasados (min)
  dockWaitOverPctIn: number; // % de caminhões de recebimento que esperaram mais que o limite
  dockWaitOverPctOut: number;
  // calendário
  productiveHoursPerDay: number; // horas úteis por dia por empilhadeira (turno − intervalos)
  breakHoursPerDay: number; // intervalos por dia por empilhadeira
  nonWorkingHoursPerDay: number; // horas não úteis do dia (24 − turno)
  // recebimento: avarias, conferência, triagem
  damagedPalletsPerDay: number;
  damagedPalletPct: number; // % dos paletes conferidos
  damagedCartonsPerDay: number;
  wholePalletTriagePerDay: number; // paletes que foram inteiros para a triagem
  triageOverflowPerDay: number; // paletes que não couberam em nenhuma área de triagem
  checkCycleMean: number; // conferência + triagem por palete (min)
  stageWaitMean: number; // espera por espaço no stage (min)
  stageOccupancyMax: number; // paletes simultâneos no stage
  utilMover: number; // utilização de paleteiras/transpaleteiras/AMR
  // armazenagem faseada
  phasedShare: number; // fração dos paletes guardados em duas etapas
  transitWaitMean: number; // espera da etapa 1 por espaço no endereço transitório da rua (min)
  transitOccupancyMax: number; // paletes simultâneos nos endereços transitórios
  // AMR
  utilAmr: number; // utilização dos AMR (trabalho; carga não conta)
  amrChargesPerDay: number; // cargas por dia (todos os AMR)
  amrChargeShare: number; // fração do tempo dos AMR em ida à estação, carga e setup
  chargerWaitMean: number; // espera por vaga na estação de carga (min)
}

export interface VehicleStat {
  name: string;
  trucks: number; // por dia
  dockTurnMean: number; // manobra média (min)
  dockWaitMean: number; // espera média por doca (min)
}

export interface HourSeries {
  hour: number;
  palletsIn: number;
  palletsOut: number;
  orders: number;
  utilForklift: number;
  utilWorker: number;
  queueForklift: number;
}

export interface ReplicationResult {
  kpis: RunKpis;
  hourly: HourSeries[];
  /** amostras individuais (min) para histogramas */
  samples: { orderCycle: number[]; forkliftWait: number[]; putawayLead: number[]; truckTurn: number[] };
  occupancySeries: { t: number; occ: number }[];
  vehicleStats: VehicleStat[];
}

export type Aggregated = { [K in keyof RunKpis]: SummaryStat };

export interface ExperimentResult {
  scenario: string;
  replications: number;
  kpis: Aggregated;
  hourly: HourSeries[];
  samples: ReplicationResult['samples'];
  occupancySeries: { t: number; occ: number }[];
  vehicleStats: VehicleStat[];
  elapsedMs: number;
}
