/**
 * Diário de Pressão — leitor de visor via Gemini (Cloudflare Worker)
 *
 * O app envia a foto do visor; este Worker repassa ao Gemini com a SUA chave,
 * que fica guardada como segredo no Cloudflare e nunca aparece no site.
 *
 * Configuração (Cloudflare → seu Worker → Settings → Variables and Secrets):
 *   GEMINI_API_KEY      (Secret, obrigatório)  chave criada no Google AI Studio
 *   ALLOWED_ORIGINS     (Text, recomendado)    ex.: https://seu-usuario.github.io
 *                                              vários separados por vírgula; vazio = aceita qualquer site
 *   GEMINI_MODELS       (Text, opcional)       modelos tentados em ordem; padrão abaixo
 *   DAILY_LIMIT_PER_IP  (Text, opcional)       leituras por aparelho/rede por dia; padrão 60
 *   LIMITS              (KV namespace, opcional) ativa o limite diário por IP
 *
 * Endpoints:
 *   GET  /      → {"ok":true}  (o app usa para saber se o leitor está no ar)
 *   POST /read  → corpo {"image":"<base64 jpeg>","mimeType":"image/jpeg"}
 *                 resposta {"sistolica","diastolica","pulso","confianca","observacao","modelo"}
 */

const DEFAULT_MODELS = "gemini-3.5-flash-lite,gemini-3.8-flash";
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024; // ~4,5 MB de imagem

const PROMPT = `A imagem é a foto do visor de um medidor de pressão arterial doméstico (digital ou analógico).
Leia os valores mostrados. Normalmente SYS (sistólica) é o número de cima e maior, DIA (diastólica) é o do meio,
e PUL/pulso é o menor, muitas vezes ao lado de um coração. Ignore data, hora e número de memória.
Responda SOMENTE com JSON:
{"sistolica": inteiro ou null, "diastolica": inteiro ou null, "pulso": inteiro ou null,
 "confianca": "alta" | "media" | "baixa", "observacao": "frase curta em português"}
Use null para o que não der para ler. Se não for um medidor de pressão, todos null e explique em observacao.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const originOk = !allowed.length || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk && origin ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, configured: !!env.GEMINI_API_KEY });
    }
    if (request.method !== "POST" || url.pathname !== "/read") return json({ error: "not_found" }, 404);
    if (!originOk) return json({ error: "origin_not_allowed", message: "Este site não está autorizado a usar o leitor." }, 403);
    if (!env.GEMINI_API_KEY) return json({ error: "not_configured", message: "GEMINI_API_KEY não configurada no Worker." }, 500);

    // Limite diário por IP (só quando o KV LIMITS estiver ligado)
    if (env.LIMITS) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const day = new Date().toISOString().slice(0, 10);
      const key = `n:${day}:${ip}`;
      const limit = parseInt(env.DAILY_LIMIT_PER_IP || "60", 10);
      const used = parseInt((await env.LIMITS.get(key)) || "0", 10);
      if (used >= limit) return json({ error: "daily_limit", message: "Limite diário de leituras atingido. Digite os valores." }, 429);
      await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_request", message: "Corpo inválido." }, 400); }
    const image = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : "";
    const mimeType = /^image\/(jpeg|png|webp|heic|heif)$/.test(body.mimeType || "") ? body.mimeType : "image/jpeg";
    if (!image || image.length > MAX_IMAGE_BASE64) return json({ error: "bad_image", message: "Imagem ausente ou grande demais." }, 400);

    const models = (env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((s) => s.trim()).filter(Boolean);
    let lastErr = { status: 502, message: "Falha ao consultar o Gemini." };

    for (const model of models) {
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ inline_data: { mime_type: mimeType, data: image } }, { text: PROMPT }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 400 },
          }),
        });
      } catch (e) {
        lastErr = { status: 502, message: "Sem conexão com o Gemini." };
        continue;
      }

      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json())?.error?.message || ""; } catch {}
        lastErr = {
          status: res.status === 429 ? 429 : 502,
          message: res.status === 429 ? "Cota gratuita do Gemini esgotada por agora." : `Gemini respondeu ${res.status}. ${detail}`.trim(),
        };
        // modelo inexistente, cota ou instabilidade: tenta o próximo
        if ([400, 403, 404, 429, 500, 503].includes(res.status)) continue;
        break;
      }

      const out = await res.json();
      const text = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const m = text.match(/\{[\s\S]*\}/);
      let r = {};
      try { r = m ? JSON.parse(m[0]) : {}; } catch { r = {}; }
      const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
      return json({
        sistolica: int(r.sistolica),
        diastolica: int(r.diastolica),
        pulso: int(r.pulso),
        confianca: ["alta", "media", "baixa"].includes(r.confianca) ? r.confianca : "media",
        observacao: typeof r.observacao === "string" ? r.observacao.slice(0, 200) : "",
        modelo: model,
      });
    }
    return json({ error: "upstream", message: lastErr.message }, lastErr.status);
  },
};
