import type { Layout } from './types';

/** galpão em branco: piso vazio, sem racks, ruas, docas nem equipamentos desenhados */
export const blankLayout = (name = 'Novo galpão'): Layout => ({ name, floor: { width: 60, depth: 40 }, elements: [] });
