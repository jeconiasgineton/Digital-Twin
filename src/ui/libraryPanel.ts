import { readLibrary, removeModel, renameModel, type KeyValueStore, type SavedModel } from '../model/library';
import { h } from './dom';

export interface LibraryActions {
  storage: KeyValueStore;
  currentId(): string | null;
  open(id: string): void;
  create(): void;
  duplicate(id: string): void;
  remove(id: string): void;
  rename(id: string, name: string): void;
  exportXlsx(m: SavedModel): void;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** "Meus modelos": abrir, criar em branco, duplicar, renomear, baixar como .xlsx e excluir */
export function openLibraryModal(a: LibraryActions) {
  const back = h('div', { class: 'modal-back', tabindex: '-1' });
  const close = () => back.remove();
  const list = h('div', { class: 'lib-list' });

  const draw = () => {
    const models = readLibrary(a.storage).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const cur = a.currentId();
    list.replaceChildren(
      ...(models.length
        ? models.map((m) => h('div', { class: `lib-row${m.id === cur ? ' cur' : ''}` },
          h('div', { class: 'lib-main' },
            h('input', {
              class: 'lib-name', value: m.name, title: 'Renomear',
              onchange: (ev: Event) => { a.rename(m.id, (ev.target as HTMLInputElement).value); draw(); },
            }),
            h('span', { class: 'note' }, `${m.id === cur ? 'Aberto agora · ' : ''}alterado em ${when(m.updatedAt)}`),
          ),
          h('div', { class: 'row' },
            m.id === cur
              ? h('span', { class: 'pill ok' }, 'aberto')
              : h('button', { class: 'b pri sm', onclick: () => { a.open(m.id); close(); } }, 'Abrir'),
            h('button', { class: 'b sm', onclick: () => a.exportXlsx(m) }, 'Baixar .xlsx'),
            h('button', { class: 'b sm', onclick: () => { a.duplicate(m.id); draw(); } }, 'Duplicar'),
            h('button', { class: 'b danger sm', onclick: () => {
              if (window.confirm(`Excluir o modelo "${m.name}"? Esta ação não pode ser desfeita (baixe o .xlsx antes, se quiser guardar).`)) {
                a.remove(m.id);
                draw();
              }
            } }, 'Excluir'),
          )))
        : [h('p', { class: 'note' }, 'Nenhum modelo salvo ainda. Crie um em branco e ele aparece aqui.')]),
    );
  };

  back.append(h('div', { class: 'modal lib-modal' },
    h('header', null,
      h('h2', null, 'Meus modelos'),
      h('div', { class: 'row' },
        h('button', { class: 'b pri', onclick: () => { a.create(); close(); } }, '＋ Novo em branco'),
        h('button', { class: 'b', onclick: close }, 'Fechar'))),
    h('div', { class: 'lib-body' },
      h('p', { class: 'note' }, 'Os modelos ficam salvos neste navegador. Para levar a outro computador ou guardar uma cópia, use "Baixar .xlsx".'),
      list),
  ));
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });
  document.body.append(back);
  draw();
}
