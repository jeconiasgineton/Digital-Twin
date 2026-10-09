import { writeFileSync } from 'node:fs';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { exportTemplate } from '../src/io/excel';

const sc = defaultScenario();
sc.name = 'Centro de distribuição – exemplo';
const buf = await exportTemplate(sc, generateLayout(defaultLayoutParams()));
writeFileSync(new URL('../examples/exemplo-dimensionamento.xlsx', import.meta.url), Buffer.from(buf));
console.log('examples/exemplo-dimensionamento.xlsx gerado');
