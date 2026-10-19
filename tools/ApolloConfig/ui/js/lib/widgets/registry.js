// Registro de widgets das opções "custom" (ui: "custom"). O nome é o campo `widget` do schema.
//
// Contrato de um widget:  factory(ctx) -> { el, refresh(info) }
//   ctx  = { opt, platform, id, get(chave) -> texto do valor atual de QUALQUER opção, value() -> valor editado (array/objeto),
//            set(novoValor) -> guarda a edição e avisa a tela, touch() -> marca o campo como "mexido" (mostra erros) }
//   el   = elemento que a tela coloca sob o rótulo e a ajuda do campo
//   refresh({ rows }) é chamado a cada mudança em QUALQUER campo; rows = [{i, field, message}] com os erros por linha (pode vir vazio).
//          O widget só reconstrói o DOM quando a estrutura muda (linha nova/removida, lista ativa trocada), nunca a cada tecla.
// Arquivo à parte (sem dependências) para evitar importação circular entre index.js e os widgets.
'use strict';

const registry = new Map();

export function registerWidget(name, factory) {
  if (typeof factory !== 'function') throw new Error(`widget ${name}: factory inválida`);
  registry.set(name, factory);
}
export function getWidget(name) { return registry.get(name) || null; }
export function widgetNames() { return [...registry.keys()]; }
