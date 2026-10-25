# Codex Web Harness

Uma interface web responsiva para conversar com o Codex CLI instalado na sua própria VPS. Cada instalação usa a conta Codex e o diretório de dados configurados pelo próprio administrador.

## Recursos

- Conversas persistentes, projetos e histórico local do Codex.
- Seletor de contexto para iniciar dúvidas gerais, continuar em um projeto existente ou criar um projeto com pasta própria dentro de `~/projects`.
- Envio de imagens por arquivo ou colagem de prints, seleção de modelo e nível de raciocínio.
- Fila de mensagens durante uma execução e ação para orientar a execução atual.
- Ações por mensagem enfileirada para orientar a execução imediatamente ou devolver texto e imagens ao rascunho; o botão para interromper fica junto ao compositor.
- Resposta final visível, com reasoning resumido e atividades intermediárias agrupados e recolhidos por turno.
- Rolagem na borda da conversa, preservando a posição durante a leitura e com atalho para voltar à última mensagem.
- Ações para renomear, fixar, arquivar, restaurar e excluir conversas.
- Menu lateral com seção de fixadas, abas de conversas e arquivadas, e busca por título no projeto atual ou em todos os projetos.
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
npm ci
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

Se a CLI estiver instalada fora de `~/.local/bin/codex`, defina `CODEX_BIN` com o caminho retornado por `command -v codex` no usuário do serviço.

Os dados da aplicação, incluindo `web-auth.json`, `web-projects.json` e imagens anexadas, ficam dentro de `CODEX_HOME`. Faça backup desse diretório segundo sua política. Não adicione esses dados ao Git.

## Proteção de acesso

O login é local a cada instalação: não há contas compartilhadas, endpoint de cadastro público nem senha padrão. A configuração do servidor contém o único e-mail autorizado. Os códigos expiram em 10 minutos, têm limite de tentativas e são enviados com limite de frequência.

O Codex CLI pode executar comandos e acessar arquivos conforme a identidade Unix e as permissões configuradas para o serviço. Restrinja a porta HTTP ao loopback, publique somente atrás de HTTPS e não exponha o serviço diretamente à internet. Use uma identidade Unix dedicada e conceda apenas as permissões administrativas que sua operação exigir.

## Desenvolvimento

```bash
cd web-ui
npm ci
npm start
```

O processo precisa de uma configuração privada válida em `CODEX_HOME/web-auth.json` e de uma sessão Codex CLI autenticada para carregar o app-server. Não execute `npm run setup-auth` em uma instalação existente, pois o assistente se recusa a substituir a configuração.

O painel de saúde lê `/proc`, o espaço de disco com `df` e métricas Docker com `docker stats`, `docker ps` e `docker system df`. Para exibir o resumo dos containers, o usuário Unix do serviço precisa ter o Docker CLI e acesso de leitura ao daemon. A rota é protegida pela mesma sessão autenticada do chat.

O painel lateral também mostra o uso recente de contexto da conversa e o limite informado pelo app-server para o modelo selecionado. O percentual usa os tokens do último turno em relação à janela do modelo; não representa a soma acumulada de todos os turnos. A leitura é atualizada quando o app-server emite `thread/tokenUsage/updated` e é recuperada ao reabrir conversas existentes.

A lista lateral mostra um indicador animado nas conversas com turno ativo. A atividade é atualizada pelos eventos do app-server e pelos estados das conversas ao carregar a lista.

Imagens anexadas no rascunho, nas mensagens e na fila podem ser abertas em uma prévia ampliada. No desktop, a coluna de visão geral pode ser redimensionada pela borda e a largura escolhida fica salva neste navegador. O painel de saúde inclui camada gravável dos containers, volumes Docker por projeto, diretórios dos projetos e pastas principais no host; imagens e subpastas podem ser compartilhadas ou sobrepostas aos totais.

## Licença

MIT. Consulte [LICENSE](LICENSE).

## Entrada de prompt e voz local

O compositor oferece envio explícito, imagens, gravação e importação de áudio. No celular, Enter cria uma linha; no desktop, Enter envia e Shift+Enter cria uma linha. Ctrl/Cmd+Enter envia também no celular com teclado físico. Modelo e esforço aplicam-se à próxima mensagem; durante uma execução, Enviar passa a adicionar à fila, e Orientar agora redireciona o turno atual.

A voz segue **gravar → ouvir → transcrever → revisar → enviar**. O reconhecimento é feito sobre o arquivo completo na VPS, sem Web Speech e sem chave de API. A transcrição nunca envia o prompt automaticamente. Em caso de falha, a gravação continua disponível para repetir, baixar ou descartar. O áudio pode ser salvo pelo usuário antes da transcrição; arquivos temporários no servidor são apagados ao concluir ou cancelar.

Para instalar o modelo multilíngue Whisper small e suas dependências Python isoladas:

```bash
bash scripts/setup-voice.sh
```

Requer Python 3.9+ com `venv`, acesso à internet para a instalação e aproximadamente 830 MiB de disco para ambiente e modelo. O processamento aceita até 3 minutos e 12 MiB por áudio, usa um processo de prioridade reduzida com uma thread de inferência por vez e libera a memória ao terminar. O limite de memória virtual é 2,5 GiB e o limite de processamento é 5 minutos. O resultado permanece na memória do servidor por até 10 minutos para permitir a consulta do navegador; não é escrito no histórico antes do envio pelo usuário.

Os caminhos padrão são `~/.local/venvs/harness-voice/bin/python` e `~/.cache/harness-voice/small`. Para personalizar no serviço, use `CODEX_VOICE_PYTHON` e `CODEX_VOICE_MODEL`. As rotas `/api/voice` e `/api/voice/transcriptions` exigem a mesma sessão autenticada do chat. A transcrição local pode demorar, especialmente durante outras tarefas da VPS, e deve ser revisada antes de enviar comandos.

O indicador de execução acompanha o turno atual, incluindo após recarregar a página ou orientar uma tarefa em andamento. Orientações abrem um novo bloco de progresso depois da mensagem do usuário. Atualizações intermediárias ficam expandidas enquanto o turno está ativo e são recolhidas ao concluir; a resposta final permanece visível. Ao reconectar, voltar à aba ou passar um período sem eventos durante uma execução, o cliente consulta o histórico para recuperar o estado. Conclusões e respostas antigas não devem alterar o estado de um turno mais recente.

Cada mensagem na fila oferece Cancelar para remover apenas aquela submissão, sem alterar o rascunho ou interromper a execução atual. Ações concorrentes sobre a mesma mensagem ficam bloqueadas até a resposta do servidor. Uma falha de remoção mantém a mensagem visível para nova tentativa, e respostas antigas de consulta da fila são descartadas. Orientar agora fica disponível apenas enquanto há uma execução ativa.
