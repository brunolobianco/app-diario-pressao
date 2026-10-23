/* Leitura do visor no próprio aparelho, sem IA.
   1) separa os números do visor (blocos de pixels escuros com formato de dígito);
   2) lê cada número com Tesseract.js usando um modelo treinado para displays de 7 segmentos;
   3) escolhe sistólica, diastólica e pulso pelo tamanho e pela posição.
   É menos confiável que a IA: serve de plano B e o resultado sempre deve ser conferido. */
(() => {
  "use strict";
  const CFG = Object.assign({
    tesseractUrl: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    ocrLangPath: "https://cdn.jsdelivr.net/gh/Shreeshrii/tessdata_ssd@master",
    ocrLang: "ssd_int",
  }, window.APP_CONFIG || {});

  let libPromise = null, workerPromise = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!libPromise) {
      libPromise = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = CFG.tesseractUrl; s.async = true; s.crossOrigin = "anonymous";
        s.onload = () => (window.Tesseract ? res(window.Tesseract) : rej(new Error("tesseract")));
        s.onerror = () => { libPromise = null; rej(new Error("tesseract_load")); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        const T = await loadLib();
        const w = await T.createWorker(CFG.ocrLang, 1, { langPath: CFG.ocrLangPath, gzip: false });
        await w.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: "8" });
        return w;
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  /* ---------- imagem → tinta binária ---------- */
  async function loadImage(blob) {
    if (window.createImageBitmap) { try { return await createImageBitmap(blob); } catch {} }
    const url = URL.createObjectURL(blob);
    try { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, th = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sB += t * hist[t];
      const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
      if (v > best) { best = v; th = t; }
    }
    return th;
  }

  async function grayscale(blob) {
    const img = await loadImage(blob);
    const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
    const k = Math.min(1, 900 / Math.max(w0, h0));
    const W = Math.round(w0 * k), H = Math.round(h0 * k);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const s = ctx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H), hist = new Array(256).fill(0);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) { g[i] = (s[p] * 0.299 + s[p + 1] * 0.587 + s[p + 2] * 0.114) | 0; hist[g[i]]++; }
    return { W, H, g, th: otsu(hist, g.length) };
  }

  function inkMask({ W, H, g, th }, invert) {
    const N = W * H, ink = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const on = g[i] < th; ink[i] = (invert ? !on : on) ? 1 : 0; }
    // remove o que encosta na borda da foto (moldura, mesa, mão)
    const st = [];
    const push = (i) => { if (ink[i] === 1) { ink[i] = 2; st.push(i); } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (st.length) {
      const i = st.pop(), x = i % W;
      if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (i >= W) push(i - W); if (i < N - W) push(i + W);
    }
    for (let i = 0; i < N; i++) if (ink[i] === 2) ink[i] = 0;
    return ink;
  }

  function dilate(ink, W, H, rh, rv) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let last = -1e9; for (let x = 0; x < W; x++) { if (ink[y * W + x]) last = x; if (x - last <= rh) tmp[y * W + x] = 1; }
      last = 1e9; for (let x = W - 1; x >= 0; x--) { if (ink[y * W + x]) last = x; if (last - x <= rh) tmp[y * W + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
      let last = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= rv) out[y * W + x] = 1; }
      last = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= rv) out[y * W + x] = 1; }
    }
    return out;
  }

  function components(mask, W, H) {
    const N = W * H, lab = new Uint8Array(N), out = [], st = [];
    for (let i = 0; i < N; i++) {
      if (!mask[i] || lab[i]) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      lab[i] = 1; st.push(i);
      while (st.length) {
        const j = st.pop(), x = j % W, y = (j / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[j - 1] && !lab[j - 1]) { lab[j - 1] = 1; st.push(j - 1); }
        if (x < W - 1 && mask[j + 1] && !lab[j + 1]) { lab[j + 1] = 1; st.push(j + 1); }
        if (j >= W && mask[j - W] && !lab[j - W]) { lab[j - W] = 1; st.push(j - W); }
        if (j < N - W && mask[j + W] && !lab[j + W]) { lab[j + W] = 1; st.push(j + W); }
      }
      out.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return out;
  }

  // Encontra grupos de 2-3 dígitos alinhados (os números do visor).
  function findNumbers(ink, W, H) {
    const groups = [];
    const rh = Math.max(1, Math.round(Math.max(W, H) * 0.003));
    for (const fv of [0.012, 0.022, 0.035]) {
      const comps = components(dilate(ink, W, H, rh, Math.round(H * fv)), W, H)
        .filter((c) => c.h >= H * 0.035 && c.h <= H * 0.6 && c.h / c.w >= 1.15 && c.h / c.w <= 9);
      comps.sort((a, b) => a.x0 - b.x0);
      const gs = [];
      for (const d of comps) {
        const g = gs.find((G) => {
          const ov = Math.min(G.y1, d.y1) - Math.max(G.y0, d.y0);
          return ov > 0.6 * Math.min(G.h, d.h) && Math.abs(G.h - d.h) < 0.3 * Math.max(G.h, d.h) && d.x0 - G.x1 < 0.9 * G.h && d.x0 > G.x0;
        });
        if (g) { g.x1 = Math.max(g.x1, d.x1); g.y0 = Math.min(g.y0, d.y0); g.y1 = Math.max(g.y1, d.y1); g.h = g.y1 - g.y0 + 1; g.n++; }
        else gs.push({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, h: d.h, n: 1 });
      }
      for (const G of gs) {
        if (G.n < 2 || G.n > 3) continue;
        const dup = groups.some((o) => {
          const ix = Math.max(0, Math.min(o.x1, G.x1) - Math.max(o.x0, G.x0)), iy = Math.max(0, Math.min(o.y1, G.y1) - Math.max(o.y0, G.y0));
          const inter = ix * iy, uni = (o.x1 - o.x0) * (o.y1 - o.y0) + (G.x1 - G.x0) * (G.y1 - G.y0) - inter;
          return inter / uni > 0.7;
        });
        if (!dup) groups.push(G);
      }
    }
    return groups.slice(0, 12);
  }

  function crop(ink, W, H, G) {
    const pad = Math.round(G.h * 0.25);
    const X0 = Math.max(0, G.x0 - pad), Y0 = Math.max(0, G.y0 - pad), X1 = Math.min(W - 1, G.x1 + pad), Y1 = Math.min(H - 1, G.y1 + pad);
    const sw = X1 - X0 + 1, sh = Y1 - Y0 + 1;
    const src = document.createElement("canvas"); src.width = sw; src.height = sh;
    const sx = src.getContext("2d"), id = sx.createImageData(sw, sh);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const p = ((y - Y0) * sw + (x - X0)) * 4, v = ink[y * W + x] ? 0 : 255;
      id.data[p] = id.data[p + 1] = id.data[p + 2] = v; id.data[p + 3] = 255;
    }
    sx.putImageData(id, 0, 0);
    const sc = 64 / G.h, out = document.createElement("canvas");
    out.width = Math.max(8, Math.round(sw * sc)); out.height = Math.max(8, Math.round(sh * sc));
    const ox = out.getContext("2d"); ox.fillStyle = "#fff"; ox.fillRect(0, 0, out.width, out.height);
    ox.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }

  /* ---------- escolha de SYS / DIA / PUL ---------- */
  function choose(cands) {
    const ok = cands.filter((c) => c.v >= 30 && c.v <= 260);
    const byH = ok.slice().sort((a, b) => b.h - a.h);
    let best = { score: 0 };
    for (let i = 0; i < Math.min(byH.length, 6); i++) for (let j = 0; j < Math.min(byH.length, 6); j++) {
      if (i === j) continue;
      const s = byH[i], d = byH[j];
      if (!(s.y < d.y && s.v >= 70 && s.v <= 260 && d.v >= 40 && d.v <= 150 && s.v > d.v + 10)) continue;
      const p = ok.filter((c) => c !== s && c !== d && c.y > s.y && c.v >= 35 && c.v <= 200 && Math.abs(c.y - d.y) > d.h * 0.4)
        .sort((a, b) => b.h - a.h)[0];
      const sizeOk = d.h / s.h > 0.6 && d.h / s.h < 1.6;
      const score = 2 + (sizeOk ? 1 : 0) + (p ? 1 : 0) + (s.conf + d.conf) / 200 + (i + j <= 1 ? 0.5 : 0);
      if (score > best.score) best = { score, s, d, p };
    }
    return best;
  }

  async function read(blob) {
    const worker = await getWorker();
    const gray = await grayscale(blob);
    let best = { score: 0 };
    for (const invert of [false, true]) {
      const ink = inkMask(gray, invert);
      const groups = findNumbers(ink, gray.W, gray.H);
      const cands = [];
      for (const G of groups) {
        const { data } = await worker.recognize(crop(ink, gray.W, gray.H, G));
        const t = (data.text || "").replace(/\D/g, "");
        if (t.length >= 2 && t.length <= 3) cands.push({ v: parseInt(t, 10), h: G.h, y: (G.y0 + G.y1) / 2, conf: data.confidence || 0 });
      }
      const r = choose(cands);
      if (r.score > best.score) best = r;
      if (best.score >= 4) break;
    }
    if (!best.score) {
      return { sistolica: null, diastolica: null, pulso: null, confianca: "baixa",
        observacao: "Não reconheci os números. Tente uma foto mais de perto, de frente e sem reflexo." };
    }
    const confs = [best.s.conf, best.d.conf].concat(best.p ? [best.p.conf] : []);
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    return {
      sistolica: best.s.v, diastolica: best.d.v, pulso: best.p ? best.p.v : null,
      confianca: best.score >= 4 && avg >= 70 ? "media" : "baixa",
      observacao: "Lido no próprio aparelho, sem IA. Esse leitor erra com facilidade.",
    };
  }

  // baixa o leitor em segundo plano para funcionar offline depois
  function warmup() { return getWorker().then(() => true); }

  window.OCR = { read, warmup };
})();
