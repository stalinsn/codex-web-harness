# Codex Web Harness

Uma interface web responsiva para conversar com o Codex CLI instalado na sua própria VPS. Cada instalação usa a conta Codex e o diretório de dados configurados pelo próprio administrador.

## Recursos

- Conversas persistentes, projetos e histórico local do Codex.
- Envio de imagens, seleção de modelo e nível de raciocínio.
- Fila de mensagens durante uma execução e ação para orientar a execução atual.
- Resumos do trabalho fornecidos pelo app-server, agrupados e recolhidos por padrão.
- Ações para renomear, fixar, arquivar, restaurar e excluir conversas.
- Login privado com senha e código de uso único enviado por e-mail. Não há cadastro público.
- Visão de uso e limites informados pela conta Codex.

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

## Licença

MIT. Consulte [LICENSE](LICENSE).
