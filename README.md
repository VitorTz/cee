# CEP Ilha — Gestão de Logradouros de Florianópolis

Site estático (HTML + CSS + JavaScript puro, sem build step) para gerenciar a
base de CEPs da ilha de Florianópolis hospedada no Supabase. Visual com a
identidade dos Correios: amarelo/azul postal, borda "aerograma" listrada,
manifesto perfurado nas tabelas e formulários em estilo declaração aduaneira.

- **Logradouros (`streets`)** — somente leitura, paginado, ordenado por quem
  tem mais CEPs vinculados, com busca por nome/bairro/descrição/CEP.
- **CEPs (`zip_codes`)** — CRUD completo, busca combinada por CEP, logradouro,
  bairro ou descrição, com botão "Ver detalhes" que abre a aba de busca.
- **Busca de CEPs** — localize o logradouro (por CEP, nome ou descrição) e
  informe um número de imóvel para descobrir qual CEP o atende.
- **Faixas de Numeração (`number_ranges`)** — CRUD completo, vinculada a um CEP.
- **Números Únicos (`unique_numbers`)** — CRUD completo, vinculado a um CEP.

## 1. Configurar as credenciais do Supabase

Abra `app.js` e edite as duas constantes no topo do arquivo:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

Você encontra esses valores em **Project Settings → API** no painel do
Supabase. Use sempre a chave **anon public**, nunca a `service_role`.


## 3. Rodar localmente

Não há dependências de build — basta servir os três arquivos estáticos:

```bash
cd correios-cep
python3 -m http.server 8000
# abra http://localhost:8000
```

Ou publique `index.html`, `style.css` e `app.js` em qualquer host estático
(Netlify, Vercel, GitHub Pages, Cloudflare Pages etc.).

## Estrutura dos arquivos

| Arquivo      | Conteúdo                                                          |
|--------------|---------------------------------------------------------------------|
| `index.html` | Estrutura das cinco abas, tabelas, modal e header com o "carimbo" postal |
| `style.css`  | Tokens de cor/tipografia e todo o visual temático dos Correios     |
| `app.js`     | Cliente Supabase + toda a lógica de CRUD, busca, paginação e o localizador de CEP |

## Normalização de CEP

Como todo CEP da ilha começa com `880`, qualquer campo de CEP (cadastro ou
busca) aceita que você digite só os 5 últimos números — o prefixo `880` é
adicionado automaticamente antes de validar, salvar ou buscar. Por exemplo,
digitar `06999` é equivalente a digitar `88006-999`.

## Como funciona a aba "Busca de CEPs"

1. No primeiro campo, digite um CEP, o nome do logradouro ou um trecho da
   descrição. O logradouro correspondente (o resultado mais relevante) é
   localizado automaticamente e todos os CEPs dele são exibidos, cada um com
   suas faixas de numeração e números únicos.
2. No segundo campo, digite o número do imóvel. O CEP correto é destacado
   com um carimbo "CEP confirmado" — a checagem primeiro procura um número
   único exato e, se não encontrar, procura uma faixa de numeração compatível
   (considerando também o lado da rua: ímpar, par ou ambos).
3. Se nenhum CEP cobrir o número informado, nada é destacado e aparece um
   carimbo "CEP não identificado", mantendo visível toda a informação do
   logradouro para conferência manual.

O botão **Ver detalhes** na aba CEPs leva direto para essa busca já com o CEP
preenchido, focando o campo de número para você completar a consulta.

## Validações aplicadas no frontend

- **CEP**: máscara automática e normalização do prefixo `880`, com regex que
  só aceita a faixa `88000-000`–`88069-999` (a mesma constraint do banco).
- **Faixas de numeração**: impede salvar se número inicial > número final.
- **Exclusão de CEP**: aviso de que a exclusão em cascata remove faixas de
  numeração e números únicos vinculados (reflete o `ON DELETE CASCADE` do
  schema).

Essas validações não substituem as constraints do banco — elas só evitam
round-trips desnecessários; o Postgres continua sendo a fonte da verdade.