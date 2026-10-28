# Codex Web Harness

Uma interface web responsiva para conversar com o Codex CLI instalado na sua própria VPS. Cada instalação usa a conta Codex e o diretório de dados configurados pelo próprio administrador.

## Recursos

- Conversas persistentes, projetos e histórico local do Codex.
- Seletor de contexto para iniciar dúvidas gerais, continuar em um projeto existente ou criar um projeto com pasta própria dentro de `~/projects`.
- Anexos de arquivos gerais e imagens, colagem de prints, seleção de modelo e nível de raciocínio.
- Fila de mensagens durante uma execução e ação para orientar a execução atual.
- Ações por mensagem enfileirada para orientar a execução imediatamente ou devolver texto e imagens ao rascunho; o botão para interromper fica junto ao compositor.
- Resposta final visível, com reasoning resumido e atividades intermediárias agrupados e recolhidos por turno.
- Rolagem na borda da conversa, preservando a posição durante a leitura e com atalho para voltar à última mensagem.
- Ações para renomear, fixar, arquivar, restaurar e excluir conversas.
- Menu lateral com seção de fixadas, abas de conversas e arquivadas, e busca por título no projeto atual ou em todos os projetos.
- Cores de projetos e conversas sincronizadas no diretório privado `CODEX_HOME/web-label-colors.json`, compartilhadas entre navegadores autenticados.
- Login privado com senha e código de uso único enviado por e-mail. Não há cadastro público.
- Visão de uso e limites informados pela conta Codex.
- Leitura protegida e atualizada automaticamente da saúde da VPS: CPU, RAM, disco, containers Docker e armazenamento.
- Atividade de subagentes exibida no histórico quando o Codex delega tarefas em paralelo.

## Requisitos

- Linux com Node.js 20.11 ou superior, npm e HTTPS configurado por um proxy reverso.
- Codex CLI instalado e autenticado como o mesmo usuário Unix que executará o serviço. Consulte a [documentação oficial da Codex CLI](https://developers.openai.com/codex/cli/) e execute `codex login` nesse usuário. O serviço usa o diretório `CODEX_HOME` desse usuário.
- Um serviço SMTP que possa enviar códigos para o endereço de e-mail configurado.

## Instalação rápida

Clone o repositório em uma pasta administrada pelo usuário que executará o Codex e instale as dependências:

```bash
git clone https://github.com/stalinsn/codex-web-harness.git
cd codex-web-harness/web-ui
npm ci --omit=dev
```

Instale e autentique o Codex CLI para esse mesmo usuário. A CLI e o harness precisam compartilhar `HOME` e `CODEX_HOME`; não copie credenciais Codex de outra pessoa ou de outro ambiente.

Crie a configuração privada de e-mail e login:

```bash
npm run setup-auth
```

O assistente solicita o e-mail autorizado, os parâmetros SMTP e a senha SMTP de forma oculta quando necessária. Ele cria `~/.codex/web-auth.json` com permissão `0600` e não substitui um arquivo existente. O endereço de e-mail é definido no servidor; não é enviado ao navegador nem aparece na tela de login. No primeiro acesso, a pessoa que controla esse e-mail recebe o código e define a senha local.

Antes de iniciar, confirme a conta Codex ativa para o mesmo usuário e execute:

```bash
codex login status
npm start
```

Por padrão, o serviço escuta somente em `127.0.0.1:7682`, sob o caminho `/codex-agent/`. Use o exemplo de unidade systemd em `deploy/codex-web-harness.service.example` e o trecho Nginx em `deploy/nginx-location.conf.example`; ajuste caminhos, usuário e domínio no servidor. Configure TLS no seu virtual host antes de disponibilizar o acesso.

## Configuração

Variáveis de ambiente opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `CODEX_UI_HOST` | `127.0.0.1` | Interface de rede de escuta. Mantenha loopback quando usar proxy reverso local. |
| `CODEX_UI_PORT` | `7682` | Porta HTTP local. |
| `CODEX_UI_ORIGIN` | automático | Origem HTTPS permitida, por exemplo `https://codex.exemplo.com`. Quando omitida, o servidor valida a origem pelo host e protocolo encaminhados pelo proxy. |
| `CODEX_BIN` | `$HOME/.local/bin/codex` | Caminho para a Codex CLI. |
| `CODEX_HOME` | `$HOME/.codex` | Diretório da sessão autenticada, conversas e configuração privada do harness. |
| `CODEX_DEFAULT_CWD` | `$HOME` | Diretório inicial de trabalho. |
| `CODEX_UI_CLIENT_IP_HEADER` | `x-real-ip` | Cabeçalho com o IP real do cliente, definido pelo proxy reverso local (use `cf-connecting-ip` atrás da Cloudflare). Só é aceito quando a conexão vem do loopback; vazio desativa. Usado nos limites de tentativas do login. |

Se a CLI estiver instalada fora de `~/.local/bin/codex`, defina `CODEX_BIN` com o caminho retornado por `command -v codex` no usuário do serviço.

Ajustes específicos da instalação ficam em `CODEX_HOME/web-config.json` (opcional, fora do Git): nomes amigáveis para projetos Docker no painel de saúde (`dockerProjectLabels`, aceita padrões `prefixo-*`) e as pastas medidas em armazenamento (`storagePaths`, aceita `~/`). Veja `deploy/web-config.example.json`. Reinicie o serviço após alterar.

Os dados da aplicação, incluindo `web-auth.json`, `web-projects.json`, `web-label-colors.json` e imagens anexadas, ficam dentro de `CODEX_HOME`. Faça backup desse diretório segundo sua política. Não adicione esses dados ao Git.

## Proteção de acesso

O login é local a cada instalação: não há contas compartilhadas, endpoint de cadastro público nem senha padrão. A configuração do servidor contém o único e-mail autorizado. Os códigos expiram em 10 minutos, têm limite de tentativas e são enviados com limite de frequência.

O Codex CLI pode executar comandos e acessar arquivos conforme a identidade Unix e as permissões configuradas para o serviço. Restrinja a porta HTTP ao loopback, publique somente atrás de HTTPS e não exponha o serviço diretamente à internet. Use uma identidade Unix dedicada e conceda apenas as permissões administrativas que sua operação exigir.

## Desenvolvimento

```bash
cd web-ui
npm ci
npm run dev      # recarrega os arquivos de public/ a cada carregamento da página
npm run check    # ESLint + testes (node:test)
```

Estrutura:

| Caminho | Conteúdo |
| --- | --- |
| `web-ui/server.mjs` | Ponto de entrada: monta os serviços e inicia o HTTP. |
| `web-ui/src/codex/` | `CodexAppServer`: processo `codex app-server`, JSON-RPC, caches da conta. |
| `web-ui/src/routes/` | Rotas da API (auth, sistema, projetos, conversas, turnos). |
| `web-ui/src/http/` | Roteador, respostas JSON, cabeçalhos de segurança e arquivos estáticos com hash. |
| `web-ui/src/` | Projetos, anexos, saúde da VPS, autenticação e transcrição de voz. |
| `web-ui/public/js/` | Cliente em módulos ES nativos, sem etapa de build. |
| `web-ui/test/` | Testes unitários. |

Os arquivos de `public/` são servidos da memória com URLs versionadas por hash de conteúdo, cache imutável e compressão brotli/gzip; um novo deploy (reinício do serviço) gera novos hashes e atualiza o service worker automaticamente.

O processo precisa de uma configuração privada válida em `CODEX_HOME/web-auth.json` e de uma sessão Codex CLI autenticada para carregar o app-server. Não execute `npm run setup-auth` em uma instalação existente, pois o assistente se recusa a substituir a configuração.

O painel de saúde lê `/proc`, o espaço de disco com `df` e métricas Docker com `docker stats`, `docker ps` e `docker system df`. Para exibir o resumo dos containers, o usuário Unix do serviço precisa ter o Docker CLI e acesso de leitura ao daemon. A rota é protegida pela mesma sessão autenticada do chat.

O painel lateral também mostra o uso recente de contexto da conversa e o limite informado pelo app-server para o modelo selecionado. O percentual usa os tokens do último turno em relação à janela do modelo; não representa a soma acumulada de todos os turnos. A leitura é atualizada quando o app-server emite `thread/tokenUsage/updated` e é recuperada ao reabrir conversas existentes.

A lista lateral mostra um indicador animado nas conversas com turno ativo. A atividade é atualizada pelos eventos do app-server e pelos estados das conversas ao carregar a lista.

Imagens anexadas no rascunho, nas mensagens e na fila podem ser abertas em uma prévia ampliada. No desktop, a coluna de visão geral pode ser redimensionada pela borda e a largura escolhida fica salva neste navegador. O painel de saúde inclui camada gravável dos containers, volumes Docker por projeto, diretórios dos projetos e pastas principais no host; imagens e subpastas podem ser compartilhadas ou sobrepostas aos totais.

## Várias contas e execuções contínuas

Além da conta principal do Codex (a do chat), o harness pode usar outras contas de agentes de linha de comando e passar o trabalho de uma para outra quando o limite de uso acaba. Presets incluídos: **Codex** (contas extras), **Claude Code**, **Antigravity CLI** (`agy`), **Gemini CLI** e **CLI personalizada**.

**Conectar uma conta:** em *Uso e ambiente → Contas e fila → Conectar nova conta* um assistente guia cada provedor: escolha o tipo de conta, dê um nome e conecte. A etapa de conexão confere se a CLI está instalada (com botão para instalar), mostra o passo a passo daquele provedor e abre um terminal da VPS no próprio navegador rodando o login da conta. O link de autorização e o código aparecem destacados, há um campo para colar o código de volta e teclas como Enter, setas e Esc para os menus das CLIs. Quando o login conclui o harness detecta sozinho e a conta entra na fila. Também é possível colar um token ou chave de API (Claude Code: `claude setup-token`; Antigravity/Gemini: chave do Gemini). No menu de cada conta há *Reconectar*, *Sair da conta* (apaga só o login daquela conta) e *Remover*.

Cada conta usa uma pasta isolada em `CODEX_HOME/web-accounts/<id>`; contas extras do Codex recebem uma cópia do `config.toml` e do `AGENTS.md` da principal. A conta principal do Codex (a do chat) não é alterada pelo painel. O terminal do assistente só executa os comandos de login e instalação definidos para cada provedor e depende do utilitário `script` (pacote util-linux, presente no Ubuntu). Se preferir, o comando de login de cada conta também pode ser copiado e executado manualmente na VPS.

**Fila de uso:** as contas são usadas na ordem da lista (setas ↑ ↓). Uma conta sai da vez quando está desativada, sem login, executando outra tarefa, em espera após atingir o limite (até o horário de liberação informado, ou `defaultCooldownMinutes`) ou acima do percentual de troca (padrão 95%). Codex e Claude Code informam o uso; nas demais CLIs a troca acontece quando elas avisam que o limite acabou.

**Conversar com qualquer conta:** o seletor *Conta* do compositor envia a próxima mensagem para o Codex ou para qualquer conta conectada. As respostas dessas contas aparecem no chat como as do Codex (mensagens em tempo real, resumo do raciocínio, comandos com saída, arquivos alterados, ferramentas e resposta final) e ficam salvas na VPS em `CODEX_HOME/web-threads/`, com histórico, fixar, renomear, arquivar e excluir. Cada conta mantém a própria sessão da CLI dentro da conversa; ao trocar de conta (ou ao continuar uma conversa do Codex com outra conta) a nova conta recebe o histórico recente como contexto. Se a conta atingir o limite no meio da resposta, a próxima conta da fila continua automaticamente na mesma conversa.

**Execuções contínuas:** uma tarefa com objetivo e pasta roda na primeira conta disponível. Cada agente mantém `.harness/HANDOFF.md` na pasta de trabalho (objetivo, estado, feito, próximos passos, decisões, validação; a pasta entra em `.git/info/exclude`). Se a conta atingir o limite, a próxima continua a partir desse registro. A tarefa termina quando o agente responde `HARNESS_STATUS: DONE`, ou para em *Precisa de você* com `HARNESS_STATUS: BLOCKED`. O estado e o log ficam em `CODEX_HOME/web-tasks/<id>/`, cada execução aparece como uma conversa no chat (uma resposta por etapa, indicando a conta que assumiu) e as tarefas continuam após reiniciar o serviço.

**Chat do Codex perto do limite:** com *Regras de troca* ativadas, ao chegar no percentual de troca o harness orienta o turno em andamento a salvar o registro de retomada e parar. Quando o turno termina (ou falha por limite), uma execução contínua assume a conversa na próxima conta. O aviso de limite no chat também tem o botão *Continuar em outra conta*.

**Mesma política em todas as contas:** o Codex continua usando `CODEX_HOME/AGENTS.md` e `config.toml`. Para as outras CLIs, o harness inclui `CODEX_HOME/AGENTS.md` e o `AGENTS.md` do projeto no início de cada etapa. Como não há ninguém para aprovar comandos durante a execução, o agente é instruído a parar com `HARNESS_STATUS: BLOCKED` sempre que essas diretrizes exigirem pedido explícito. O modo de permissão de cada CLI vem do preset (Claude Code: `acceptEdits`; Gemini CLI: `auto_edit`) e pode ser alterado por conta em `web-accounts.json` (`permissionMode`, `args`).

**Permissões e compatibilidade Antigravity:** no painel da conta Antigravity, *Acesso completo* usa `always-proceed`; *Com autorização* usa `request-review`. Como o agente roda sem terminal interativo, `request-review` não abre uma confirmação no navegador: ações que precisem de aprovação são bloqueadas pela CLI e seus erros ficam no inspetor da conversa. Regras de aprovação ou negação em outros escopos continuam valendo mesmo em `always-proceed`. O seletor de modelo exibe se a CLI declara suporte a ferramentas; se não declarar, o harness mostra *não informado* e não presume compatibilidade. Quando o catálogo reporta as opções, a validação no servidor também recusa esforços incompatíveis e não envia `--effort` quando o nível já vem codificado no ID do modelo. Consulte a [documentação de execução headless](https://www.agy.dev/docs/cli/headless/) e de [permissões](https://www.agy.dev/docs/permissions?tab=cli).

**Diagnóstico:** falhas recentes de provedor, ferramenta ou envio permanecem no cartão *Erros da conversa* no painel lateral, mesmo depois que o aviso temporário desaparece. O cartão combina os itens de falha salvos no histórico do servidor com o registro local do navegador.

**CLI personalizada:** edite `CODEX_HOME/web-accounts.json` e informe `bin`, `args` (com `{prompt}`, `{model}`, `{effort}`, `{cwd}`; listas internas são opcionais) e `parser` (`claude`, `generic` para JSONL ou `text`). Reinicie o serviço após editar o arquivo à mão.

Antes de usar várias contas do mesmo provedor, confira os termos de uso de cada serviço.

## Licença

MIT. Consulte [LICENSE](LICENSE).

## Entrada de prompt e voz local

O compositor oferece envio explícito, um botão Anexar para arquivos gerais e um botão Gravar para o microfone. Arquivos de áudio anexados podem ser usados como voz por uma ação na prévia. No celular, Enter cria uma linha; no desktop, Enter envia e Shift+Enter cria uma linha. Ctrl/Cmd+Enter envia também no celular com teclado físico. Modelo e esforço aplicam-se à próxima mensagem; durante uma execução, Enviar passa a adicionar à fila, e Orientar agora redireciona o turno atual.

A voz oferece dois caminhos após gravar e ouvir: **Transcrever para revisar** coloca o texto no campo sem enviar; **Enviar áudio** envia a gravação como anexo na conversa atual (ou adiciona à fila durante uma execução). Após transcrever, o botão principal passa a enviar o texto revisado. O reconhecimento é feito sobre o arquivo completo na VPS, sem Web Speech e sem chave de API. Em caso de falha, a gravação continua disponível para repetir ou descartar. Os arquivos temporários de transcrição no servidor são apagados ao concluir ou cancelar.

Para instalar o modelo multilíngue Whisper small e suas dependências Python isoladas:

```bash
bash scripts/setup-voice.sh
```

Requer Python 3.9+ com `venv`, acesso à internet para a instalação e aproximadamente 830 MiB de disco para ambiente e modelo. O processamento aceita até 3 minutos e 12 MiB por áudio, usa um processo de prioridade reduzida com uma thread de inferência por vez e libera a memória ao terminar. O limite de memória virtual é 2,5 GiB e o limite de processamento é 5 minutos. O resultado permanece na memória do servidor por até 10 minutos para permitir a consulta do navegador; não é escrito no histórico antes do envio pelo usuário.

Os caminhos padrão são `~/.local/venvs/harness-voice/bin/python` e `~/.cache/harness-voice/small`. Para personalizar no serviço, use `CODEX_VOICE_PYTHON` e `CODEX_VOICE_MODEL`. As rotas `/api/voice` e `/api/voice/transcriptions` exigem a mesma sessão autenticada do chat. A transcrição local pode demorar, especialmente durante outras tarefas da VPS, e deve ser revisada antes de enviar comandos.

O indicador de execução acompanha o turno atual, incluindo após recarregar a página ou orientar uma tarefa em andamento. Orientações abrem um novo bloco de progresso depois da mensagem do usuário. Atualizações intermediárias ficam expandidas enquanto o turno está ativo e são recolhidas ao concluir; a resposta final permanece visível. Ao reconectar, voltar à aba ou passar um período sem eventos durante uma execução, o cliente consulta o histórico para recuperar o estado. Conclusões e respostas antigas não devem alterar o estado de um turno mais recente.

Cada mensagem na fila oferece Cancelar para remover apenas aquela submissão, sem alterar o rascunho ou interromper a execução atual. Ações concorrentes sobre a mesma mensagem ficam bloqueadas até a resposta do servidor. Uma falha de remoção mantém a mensagem visível para nova tentativa, e respostas antigas de consulta da fila são descartadas. Orientar agora fica disponível apenas enquanto há uma execução ativa.

O botão Anexar aceita até 8 arquivos, incluindo até 4 imagens, com 24 MiB no total. Imagens têm limite individual de 8 MiB; os outros arquivos, 12 MiB. Imagens vão como entrada visual; os demais arquivos ficam na pasta privada da conversa e são referenciados no prompt por metadados com seu caminho local, para leitura pelas ferramentas do Codex. Downloads e reprodução de áudios no histórico exigem autenticação; conteúdo genérico é servido como download para impedir a execução de HTML anexado. A fila preserva os arquivos ao devolver uma mensagem ao rascunho.

Anexar abre opções explícitas de Galeria, Tirar foto e Arquivos. Galeria usa um seletor de imagens com seleção múltipla e sem captura obrigatória. A câmera interna pede a traseira primeiro, permite alternar para a frontal e anexa JPEG com até 2048 pixels no lado maior. Ao fechar a câmera ou sair do app, os dispositivos são liberados. O fallback nativo pede captura traseira com `capture="environment"`; a interface do seletor de galeria e da câmera nativa depende do Android e do navegador. A política de permissões permite câmera e microfone somente na própria origem e o navegador continua solicitando autorização. As gavetas mobile não usam sombra lateral nem desfoque de fundo.

Gravações preservam o formato comprimido original; WebM/Opus é preferido em navegadores Chromium, incluindo Samsung Internet, com fallback para os formatos aceitos pelo navegador. A prévia não depende de conversão WAV no celular. O player inicia a reprodução por gesto explícito do usuário. Os arquivos temporários usados na transcrição continuam sendo apagados ao terminar, e um erro de envio preserva tanto o texto quanto a gravação para repetir.

O proxy deve aceitar corpos de até 48 MiB e preservar a política CSP fornecida pela aplicação, que permite `media-src 'self' blob: data:`. Acrescentar uma segunda CSP sem essa permissão bloqueia a prévia; o limite padrão de 1 MiB do Nginx recusa gravações antes de chegarem à aplicação. Na instalação NyxRooms, o proxy dedicado foi corrigido em `/opt/codex-agent/nginx.conf`, e o limite geral de requisições foi ajustado para 120/minuto, com burst 240, em `/opt/codex-agent/compose.yaml`. A transcrição consulta o resultado a cada quatro segundos e tolera respostas temporárias 429/503. Permissões negadas de microfone aparecem no painel com orientação para Samsung Internet e Android.

Ao escolher Enviar áudio, a gravação também acompanha a mensagem como arquivo para poder ser ouvida depois no histórico. Somente os arquivos temporários de processamento são apagados; anexos enviados permanecem na pasta da conversa, assim como as imagens.
