# Leitor com IA: chave do Gemini + Cloudflare Worker

Leva uns 15 minutos e é feito uma vez só, por você. Depois disso, todo mundo que abrir o site tem a leitura automática sem configurar nada.

Antes de começar, publique o site no GitHub Pages (veja o README principal) e anote o endereço, por exemplo `https://seu-usuario.github.io`. Ele é usado no passo 2.

---

## 1. Gerar a chave do Gemini (grátis)

1. Entre em **https://aistudio.google.com** com sua conta Google e aceite os termos, se pedir.
2. No menu, clique em **Get API key** (ou "Obter chave de API").
3. Clique em **Create API key**. Se pedir um projeto, escolha **Create API key in new project**.
4. Copie a chave (começa com `AIza...`) e guarde num lugar seguro. **Não cole a chave em nenhum arquivo do repositório.**

Pontos importantes:
- A faixa gratuita tem limite de pedidos por minuto e por dia, que varia por modelo. Para uma família, sobra. Os limites atuais aparecem no AI Studio, em *Usage/Rate limits*.
- Na faixa gratuita, o Google pode usar o conteúdo enviado (a foto do visor) para melhorar os produtos dele. Se não quiser isso, ative o faturamento no projeto: pelos termos do Google, o uso pago não entra nessa melhoria, mas deixa de ser gratuito. Cada leitura custa uma fração de centavo.
- Se não aparecer a opção de criar chave, pode ser restrição de idade ou de conta corporativa. Use uma conta Google pessoal.

---

## 2. Criar o Worker no Cloudflare (grátis)

### 2.1 Conta
1. Crie uma conta em **https://dash.cloudflare.com/sign-up** (só e-mail e senha; não precisa de domínio nem cartão).
2. Confirme o e-mail.

### 2.2 Criar o Worker
1. No painel, abra **Workers & Pages** (menu *Compute*).
2. Clique em **Create** → **Create Worker** (modelo "Hello World").
3. Dê o nome **`leitor-pressao`** e clique em **Deploy**.
4. Clique em **Edit code**. Apague todo o código de exemplo, cole o conteúdo do arquivo **`worker/worker.js`** desta pasta e clique em **Deploy**.

### 2.3 Guardar a chave e as regras
No Worker, abra **Settings → Variables and Secrets** e clique em **Add**:

| Tipo | Nome | Valor |
| --- | --- | --- |
| **Secret** | `GEMINI_API_KEY` | a chave `AIza...` do passo 1 |
| Text | `ALLOWED_ORIGINS` | o endereço do seu site, ex.: `https://seu-usuario.github.io` (sem barra no final e sem `/app-pressao`) |

Clique em **Deploy** (ou **Save and deploy**) para aplicar.

`ALLOWED_ORIGINS` impede que outros sites usem sua cota. Para testar também no computador, acrescente outros endereços separados por vírgula.

### 2.4 Limite diário por pessoa (opcional, recomendado)
Evita que alguém gaste toda a cota do dia.
1. No painel, abra **Storage & Databases → KV** → **Create** e dê o nome `LIMITS`.
2. Volte ao Worker → **Settings → Bindings** → **Add** → **KV namespace**. Nome da variável: `LIMITS`; namespace: `LIMITS`. Salve.
3. Opcional: em *Variables and Secrets*, crie o Text `DAILY_LIMIT_PER_IP` com o número de leituras por dia por rede (padrão 60).

### 2.5 Testar
O endereço do Worker aparece no topo da página dele, no formato `https://leitor-pressao.SEU-SUBDOMINIO.workers.dev`. Abra esse endereço no navegador. Deve aparecer:

```json
{"ok":true,"configured":true}
```

Se aparecer `"configured":false`, a chave não foi salva como `GEMINI_API_KEY`.

---

## 3. Ligar o app ao Worker

1. Abra **`config.js`** e cole o endereço do Worker:
   ```js
   workerUrl: "https://leitor-pressao.SEU-SUBDOMINIO.workers.dev",
   ```
2. Em **`sw.js`**, aumente a versão (`diario-pressao-v2` → `diario-pressao-v3`) para os celulares pegarem a mudança.
3. Publique:
   ```bash
   git add .
   git commit -m "Liga o leitor com IA"
   git push
   ```
4. No celular, abra o app, vá em **Ajustes → Leitura automática da foto** e confira se o *Leitor com IA* aparece com a bolinha verde ("Ativo").

---

## Problemas comuns

| O app mostra | O que fazer |
| --- | --- |
| "Este site não está autorizado a usar o leitor." | `ALLOWED_ORIGINS` não bate com o endereço do site. Use só `https://seu-usuario.github.io`, sem caminho e sem barra final. |
| "Cota gratuita do Gemini esgotada por agora." | Limite por minuto ou por dia do Google. O app passa sozinho para o leitor do aparelho. |
| "Gemini respondeu 404" | O nome do modelo mudou. Crie a variável Text `GEMINI_MODELS` com o modelo atual (lista em ai.google.dev/gemini-api/docs/models), ex.: `gemini-3.5-flash-lite,gemini-3.8-flash`. |
| "Limite diário de leituras atingido." | Limite do passo 2.4. Aumente `DAILY_LIMIT_PER_IP` se for preciso. |
| Bolinha vermelha em Ajustes | Confira o endereço em `config.js` e se o teste do passo 2.5 funciona. |

## Publicar pela linha de comando (alternativa)

Se preferir o terminal em vez do painel, nesta pasta `worker/`:

```bash
npx wrangler login
# edite ALLOWED_ORIGINS em wrangler.toml
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```
