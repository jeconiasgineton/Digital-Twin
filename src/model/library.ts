import type { Layout, Scenario } from './types';

/**
 * Biblioteca de modelos salvos no navegador. Cada modelo é um cenário + layout com nome e data.
 * O navegador guarda só neste computador; para levar a outro, o modelo é baixado como .xlsx.
 */
export interface SavedModel {
  id: string;
  name: string;
  updatedAt: string;
  scenario: Scenario;
  layout: Layout;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LIBRARY_KEY = 'digital-twin.modelos.v1';
export const CURRENT_KEY = 'digital-twin.modelo-atual.v1';

const isModel = (m: unknown): m is SavedModel => {
  const x = m as SavedModel;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && !!x.scenario && !!x.layout;
};

/** lê a biblioteca; dados corrompidos ou ausentes viram lista vazia (nunca derruba a aplicação) */
export function readLibrary(st: KeyValueStore): SavedModel[] {
  try {
    const raw = st.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isModel) : [];
  } catch {
    return [];
  }
}

/** grava a biblioteca; devolve erro legível quando o navegador recusa (ex.: cota cheia) */
export function writeLibrary(st: KeyValueStore & { setItem(k: string, v: string): void }, list: SavedModel[]): { ok: true } | { ok: false; error: string } {
  try {
    st.setItem(LIBRARY_KEY, JSON.stringify(list));
    return { ok: true };
  } catch {
    return { ok: false, error: 'Não foi possível salvar o modelo no navegador (espaço cheio). Baixe o .xlsx e libere espaço.' };
  }
}

export const newModelId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** próximo nome livre: "Modelo", "Modelo 2", "Modelo 3"… */
export function nextName(list: SavedModel[], base: string): string {
  const names = new Set(list.map((m) => m.name));
  if (!names.has(base)) return base;
  let k = 2;
  while (names.has(`${base} ${k}`)) k++;
  return `${base} ${k}`;
}

export function createModel(list: SavedModel[], name: string, scenario: Scenario, layout: Layout, now = new Date()): SavedModel {
  return { id: newModelId(), name: nextName(list, name), updatedAt: now.toISOString(), scenario, layout };
}

/** cópia independente (outro id, outro nome) */
export function duplicateModel(list: SavedModel[], id: string, now = new Date()): SavedModel | null {
  const src = list.find((m) => m.id === id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify({ scenario: src.scenario, layout: src.layout })) as Pick<SavedModel, 'scenario' | 'layout'>;
  return { id: newModelId(), name: nextName(list, `${src.name} (cópia)`), updatedAt: now.toISOString(), ...copy };
}

export const removeModel = (list: SavedModel[], id: string): SavedModel[] => list.filter((m) => m.id !== id);

/** atualiza (ou acrescenta) um modelo com o estado atual */
export function upsertModel(list: SavedModel[], model: SavedModel): SavedModel[] {
  const i = list.findIndex((m) => m.id === model.id);
  if (i < 0) return [...list, model];
  const next = [...list];
  next[i] = model;
  return next;
}

/** nomes vazios voltam ao nome anterior; nomes repetidos ganham sufixo */
export function renameModel(list: SavedModel[], id: string, name: string): SavedModel[] {
  const clean = name.trim();
  if (!clean) return list;
  const others = list.filter((m) => m.id !== id);
  const unique = nextName(others, clean);
  return list.map((m) => (m.id === id ? { ...m, name: unique } : m));
}
