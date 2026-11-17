import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { blankLayout } from '../src/model/blank';
import {
  LIBRARY_KEY, createModel, duplicateModel, nextName, readLibrary, removeModel, renameModel, upsertModel, writeLibrary, type KeyValueStore, type SavedModel,
} from '../src/model/library';

/** armazenamento em memória com a mesma interface do localStorage */
const memStore = (opts: { full?: boolean } = {}): KeyValueStore & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      if (opts.full) throw new Error('QuotaExceededError');
      data[k] = v;
    },
  };
};

describe('biblioteca de modelos', () => {
  it('lista vazia quando não há nada salvo ou o dado está corrompido', () => {
    expect(readLibrary(memStore())).toEqual([]);
    const st = memStore();
    st.data[LIBRARY_KEY] = '{not json';
    expect(readLibrary(st)).toEqual([]);
    st.data[LIBRARY_KEY] = JSON.stringify([{ foo: 1 }, { id: 'a', name: 'ok', scenario: {}, layout: {} }]);
    expect(readLibrary(st).map((m) => m.id)).toEqual(['a']); // só entradas válidas
  });
  it('cria, grava e lê de volta com os mesmos dados', () => {
    const st = memStore();
    const m = createModel([], 'Galpão A', defaultScenario(), blankLayout());
    expect(writeLibrary(st, [m]).ok).toBe(true);
    const back = readLibrary(st);
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('Galpão A');
    expect(back[0].layout.elements).toEqual([]);
    expect(back[0].scenario.forklifts.count).toBe(defaultScenario().forklifts.count);
  });
  it('nomes livres: "Modelo", depois "Modelo 2", "Modelo 3"', () => {
    let lib: SavedModel[] = [];
    for (let i = 0; i < 3; i++) lib = [...lib, createModel(lib, 'Modelo', defaultScenario(), blankLayout())];
    expect(lib.map((m) => m.name)).toEqual(['Modelo', 'Modelo 2', 'Modelo 3']);
    expect(nextName(lib, 'Outro')).toBe('Outro');
  });
  it('duplicar gera cópia independente com outro id e nome', () => {
    const lib = [createModel([], 'Teste', defaultScenario(), blankLayout())];
    const copy = duplicateModel(lib, lib[0].id)!;
    expect(copy.id).not.toBe(lib[0].id);
    expect(copy.name).toBe('Teste (cópia)');
    copy.scenario.forklifts.count = 99;
    expect(lib[0].scenario.forklifts.count).not.toBe(99);
    expect(duplicateModel(lib, 'nao-existe')).toBeNull();
  });
  it('renomear: nome vazio mantém o anterior; repetido ganha sufixo', () => {
    let lib = [createModel([], 'A', defaultScenario(), blankLayout()), createModel([], 'B', defaultScenario(), blankLayout())];
    lib = renameModel(lib, lib[1].id, '   ');
    expect(lib[1].name).toBe('B');
    lib = renameModel(lib, lib[1].id, 'A');
    expect(lib[1].name).toBe('A 2');
  });
  it('excluir remove só o modelo indicado; atualizar troca o existente sem duplicar', () => {
    let lib = [createModel([], 'A', defaultScenario(), blankLayout()), createModel([], 'B', defaultScenario(), blankLayout())];
    lib = removeModel(lib, lib[0].id);
    expect(lib.map((m) => m.name)).toEqual(['B']);
    const b = { ...lib[0], name: 'B editado' };
    lib = upsertModel(lib, b);
    expect(lib).toHaveLength(1);
    expect(lib[0].name).toBe('B editado');
    lib = upsertModel(lib, { ...b, id: 'novo' });
    expect(lib).toHaveLength(2);
  });
  it('quando o navegador recusa a gravação (cota cheia), devolve erro legível em vez de travar', () => {
    const r = writeLibrary(memStore({ full: true }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/espaço cheio/);
  });
});
