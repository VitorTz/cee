## Funcionalidades Principais

### 1. Gestão de CEPs e Logradouros
Módulo dedicado à organização da base de endereços.
* **Consulta e Cadastro:** Visualize, pesquise e cadastre novos logradouros e CEPs facilmente.
* **Busca Inteligente:** Pesquise rapidamente pelo nome da rua, bairro ou número do CEP.

### 2. Consulta de Endereços (Localizador Inteligente)
Uma ferramenta para descobrir qual CEP atende a um número de imóvel específico.
* **Como funciona:** Digite o nome da rua ou um CEP para localizar o logradouro. Em seguida, informe o número da residência ou prédio.
* **Destaque Automático:** O sistema cruza o número informado com as regras de numeração da rua e destaca o CEP correto.
* **Diagnóstico Visual:** Se o número não pertencer a nenhuma faixa cadastrada, o sistema emite um alerta claro, permitindo a conferência manual de todas as regras daquela rua.
* **Mapa Integrado:** Visualização fixa do mapa do logradouro ao lado dos resultados da pesquisa em dispositivos com telas maiores.

### 3. Regras de Numeração
Controle detalhado de como os números dos imóveis se distribuem pelos CEPs de uma rua.
* **Definição de Faixas:** Estabeleça o número de início e fim para um determinado CEP.
* **Lado da Rua:** Especifique se a regra se aplica apenas ao lado Ímpar, Par ou a Ambos os lados da via.
* **Casos Específicos:** Adicione descrições para regras exclusivas, como "Hospital", "Condomínio" ou "Prédio Comercial".

### 4. Estatísticas
Um painel gerencial para visualizar o volume de dados do sistema.
* **Métricas Gerais:** Total de logradouros, CEPs e regras de numeração cadastradas.
* **Rankings:** Tabelas atualizadas com os top 10 bairros com mais logradouros, ruas com maior quantidade de CEPs e os endereços mais consultados pela equipe.

### 5. Mapa CEE
Espaço dedicado à organização física e logística do centro de distribuição.
* **Planta Baixa Virtual:** Visualização das ilhas de trabalho (Setores A/B, C/D, E/F, G/H) e áreas de apoio (Caixa Postal, ME, Recondicionamento).
* **Controle de Offset:** Ferramenta para ajustar dinamicamente a numeração dos setores. Aplique um "offset" (soma ou subtração) para adaptar a distribuição de carga do dia, atualizando os intervalos de cada bancada instantaneamente.

### 6. Registros (Operação Diária)
Um diário de bordo completo para acompanhamento da operação do CEE.
* **Caminhões e CDLs:** Registro de horários de chegada de veículos e volume de carga (CDLs).
* **Objetos em LOEC Suspensa:** Acompanhe a quantidade de objetos retidos ao longo do dia com geração de um gráfico visual automático.
* **Chegada de Malotes:** Controle das entregas de malotes realizadas pelos carteiros.
* **Anotações da Operação:** Um editor de textos rico para salvar relatórios, anomalias ou notas detalhadas sobre a operação do dia.

### 7. Análise LOEC
Módulo de processamento de Listas de Objetos Entregues ao Carteiro.
* **Extração Automática:** Cole o texto bruto da LOEC e o sistema extrairá automaticamente apenas os códigos de objetos e endereços válidos, ignorando todo o resto.
* **Métricas Inteligentes:** Descubra instantaneamente os tipos distintos de objetos e identifique CEPs que constam na lista mas não estão cadastrados no sistema.
* **Análise Visual e Exportação:** Visualize gráficos dinâmicos com o Top 10 logradouros ou exporte os resultados processados em formato CSV.

### 8. Chamados (Help Desk)
Sistema interno de suporte para comunicação entre carteiros e supervisores de rua.
* **Abertura de Chamados:** Categorias específicas para problemas enfrentados na rua (Etiqueta trocada, encomenda faltando/errada, pneu furado, acidente, etc.).
* **Chat em Tempo Real:** Conversa ao vivo atrelada a cada chamado com notificações de sistema (visuais e sonoras) automáticas.
* **Suporte Avançado a Mídias:** Envie imagens, áudios, vídeos e PDFs de até 50MB. As imagens são otimizadas via compressão no lado do cliente e todas as mídias podem ser abertas diretamente no navegador através de um visualizador interativo tipo *lightbox*.

### 9. Minha Conta
Gestão do perfil do usuário para facilitar o contato interno.
* **Dados Pessoais e Endereço:** Complete seu perfil com nome, telefone, e-mail de contato, rua, CEP, número e bairro para que os supervisores e administradores possam identificá-lo facilmente dentro dos chamados.

---

## Facilidades e Atalhos do Sistema

Para agilizar o atendimento e o trabalho interno, o sistema conta com ferramentas de produtividade invisíveis:

* **Preenchimento Automático de CEP:** Como os CEPs da ilha começam com `880`, você só precisa digitar os 5 últimos números em qualquer campo do sistema e o prefixo `880` será adicionado automaticamente.
* **Limpeza e Reset (F4):** Pressione `F4` a qualquer momento para limpar completamente todos os campos de busca, formulários, abas de seleção e recarregar os painéis para o seu estado inicial.
* **Foco na Busca de CEP (F6 e F7):** Pressione `F7` para jogar o cursor instantaneamente no campo de busca de Logradouro, ou `F6` para pular direto para o campo de "Número do Imóvel".
* **Navegação por Teclado Numérico:** Utilize as teclas numéricas de `1` a `0` no topo do teclado (quando não estiver com o cursor piscando em nenhuma caixa de texto) para pular rapidamente entre os módulos do sistema.