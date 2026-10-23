# Diário de Pressão

App web para registrar a pressão arterial pelo celular: foto do visor do aparelho, valores, o que a pessoa estava fazendo, histórico com gráfico e relatório para o médico.

- **Funciona para qualquer pessoa que abrir o site.** Cada celular guarda os próprios dados; nada vai para servidor nenhum.
- **Instala na tela inicial** como um app e abre mesmo sem internet.
- **Várias pessoas no mesmo celular**: cada uma com seu histórico (Ajustes → Pessoas).

## Funcionalidades

| Aba | O que faz |
| --- | --- |
| Medir | Foto do aparelho, sistólica/diastólica/pulso, contexto (etiquetas + descrição), braço, data e hora. Mostra a última medição e a média de 7 dias. |
| Histórico | Gráfico de 7/30/90 dias com linha de referência 130/80 e lista por dia, com foto, edição e exclusão. |
| Relatório | Filtro por período (7, 30, 90 dias, tudo ou datas livres). Resumo com médias de manhã e de noite. Exporta **PDF** (pela impressão do navegador, com ou sem fotos) e **planilha CSV** (abre no Excel e no Google Planilhas), com opção de compartilhar direto no WhatsApp ou no e-mail. |
| Ajustes | Pessoas, lembretes na agenda do celular, leitura automática da foto (opcional), cópia de segurança e restauração, apagar dados. |

## Publicar no GitHub Pages

1. Crie um repositório no GitHub (por exemplo, `app-pressao`) e envie o conteúdo desta pasta:
   ```bash
   cd C:\workspace\app-pressao
   git init
   git add .
   git commit -m "Diário de Pressão"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/app-pressao.git
   git push -u origin main
   ```
2. No GitHub, abra **Settings → Pages**. Em *Build and deployment*, escolha **Deploy from a branch**, a branch `main` e a pasta `/ (root)`. Salve.
3. Em um ou dois minutos o site fica disponível em `https://SEU-USUARIO.github.io/app-pressao/`. Mande esse link para a família.

O GitHub Pages usa HTTPS, que é necessário para o app instalar e funcionar offline.

## Instalar no celular

- **Android (Chrome):** abra o link → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone (Safari):** abra o link → botão Compartilhar → **Adicionar à Tela de Início**.

## Onde ficam os dados

As medições e as fotos ficam no **IndexedDB** do navegador do celular, e os ajustes no `localStorage`. Isso significa que:

- cada pessoa só vê os próprios dados, no próprio aparelho;
- os dados **se perdem** se o navegador for limpo, o app for desinstalado ou o celular for trocado. Por isso existe **Ajustes → Cópia de segurança**, que gera um arquivo `.json` (com ou sem fotos) que pode ser restaurado em outro aparelho;
- no iPhone, o Safari pode apagar dados de sites que não são abertos há muitas semanas. Instalar na tela inicial reduz esse risco, e o app pede ao navegador armazenamento persistente.

## Leitura automática da foto

Ninguém da família precisa configurar nada. Ao tirar a foto, o app tenta, nesta ordem:

1. **Leitor com IA (Google Gemini)**, através de um Cloudflare Worker seu. É o mais preciso. Precisa de internet.
2. **Leitor do aparelho (Tesseract.js)**, com um modelo treinado para displays de 7 segmentos. Roda no próprio celular, funciona offline depois de baixado (cerca de 3 MB) e não envia a foto para lugar nenhum, mas erra mais.
3. Se nenhum conseguir, a pessoa digita os números.

Em qualquer caso, o app mostra a leitura e pede para conferir antes de salvar.

Sem o Worker configurado, o app usa direto o leitor do aparelho. O passo a passo para criar a chave do Gemini e publicar o Worker está em [`worker/COMO-CONFIGURAR.md`](worker/COMO-CONFIGURAR.md).

A chave do Gemini fica guardada como segredo no Cloudflare. **Nunca coloque a chave no código nem no repositório**, porque o site é público.

## Lembretes

Um site não consegue mandar notificações confiáveis sem um servidor, então os lembretes usam a agenda do celular. Em **Ajustes → Lembretes**:

- **iPhone:** "Baixar para a agenda (.ics)" → abrir o arquivo → *Adicionar tudo*.
- **Android:** toque em cada link "Google Agenda HH:MM" e salve o evento (ele já vem com repetição diária).

## Atualizar o app

Depois de alterar os arquivos, aumente o número da versão em `sw.js` (por exemplo, `const CACHE = "diario-pressao-v3"`) e faça o `git push`. Os celulares baixam a nova versão na próxima vez que abrirem o app com internet.

## Estrutura

```
index.html             telas do app
styles.css             visual (tema claro e escuro) e layout de impressão do relatório
config.js              endereço do Worker do Gemini (o único arquivo que você precisa editar)
app.js                 lógica: banco local, foto, gráfico, relatório, cópia de segurança
ocr.js                 leitor do visor no próprio aparelho (Tesseract.js)
worker/                Cloudflare Worker que guarda a chave do Gemini e lê a foto
sw.js                  service worker (funciona offline)
manifest.webmanifest   dados para instalar como app
icons/                 ícones
.nojekyll              faz o GitHub Pages servir os arquivos como estão
```

## Aviso

A classificação usa a Diretriz Brasileira de Hipertensão Arterial (2020), feita para medidas de consultório. Em medidas caseiras, médias a partir de 130/80 mmHg já merecem conversa com o médico. A leitura automática pode errar; confira sempre os números. Este app não substitui avaliação médica.
