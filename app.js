/* Diário de Pressão — app 100% no navegador.
   Dados: IndexedDB (medições e fotos) + localStorage (pessoas, ajustes). Nada sai do aparelho,
   exceto a foto enviada à API da Anthropic quando a leitura automática está configurada. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CONFIG = window.APP_CONFIG || {};
  const WORKER_URL = (CONFIG.workerUrl || "").replace(/\/$/, "");
  const TAGS = ["Em repouso","Ao acordar","Antes de dormir","Após café","Após refeição","Após exercício","Trabalhando","Estressado","Após remédio","Com dor de cabeça"];

  /* ================= utilidades ================= */
  const pad = (n) => String(n).padStart(2, "0");
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDate = (ts) => new Date(ts).toLocaleDateString("pt-BR");
  const dayKey = (ts) => dateInput(new Date(ts));
  const fmtDay = (ts) => {
    const today = new Date(), y = new Date(); y.setDate(today.getDate() - 1);
    if (dayKey(ts) === dayKey(today)) return "Hoje";
    if (dayKey(ts) === dayKey(y)) return "Ontem";
    return new Date(ts).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  };
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
  }
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  // Diretriz Brasileira de Hipertensão Arterial 2020 (valores de consultório)
  function classify(s, d) {
    if (s == null || d == null) return null;
    if (s < 90 || d < 60) return { label: "Pressão baixa", cls: "c-low" };
    const lv = (s>=180||d>=110)?5:(s>=160||d>=100)?4:(s>=140||d>=90)?3:(s>=130||d>=85)?2:(s>=120||d>=80)?1:0;
    return [
      { label: "Ótima", cls: "c-ok" }, { label: "Normal", cls: "c-ok" }, { label: "Pré-hipertensão", cls: "c-warn" },
      { label: "Hipertensão estágio 1", cls: "c-bad" }, { label: "Hipertensão estágio 2", cls: "c-bad" }, { label: "Hipertensão estágio 3", cls: "c-bad" },
    ][lv];
  }
  const catChip = (c) => c ? `<span class="chip-cat ${c.cls}">${c.label}</span>` : "";

  function download(filename, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  async function dataURLToBlob(u) { const r = await fetch(u); return r.blob(); }

  /* ================= banco local (IndexedDB) ================= */
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const req = indexedDB.open("diario-pressao", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const r = db.createObjectStore("readings", { keyPath: "id" });
          r.createIndex("profile", "profile");
          db.createObjectStore("photos", { keyPath: "id" });
        };
        req.onsuccess = () => { this._db = req.result; res(this._db); };
        req.onerror = () => rej(req.error);
      });
    },
    async tx(stores, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(stores, mode);
        let out;
        Promise.resolve(fn(t)).then((v) => (out = v));
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
    req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async readingsFor(profile) {
      const db = await this.open();
      const r = db.transaction("readings").objectStore("readings").index("profile").getAll(profile);
      return this.req(r);
    },
    async allReadings() { const db = await this.open(); return this.req(db.transaction("readings").objectStore("readings").getAll()); },
    async getPhoto(id) { const db = await this.open(); const p = await this.req(db.transaction("photos").objectStore("photos").get(id)); return p ? p.blob : null; },
    putReading(rec, photoBlob, removePhoto) {
      return this.tx(["readings", "photos"], "readwrite", (t) => {
        t.objectStore("readings").put(rec);
        if (photoBlob) t.objectStore("photos").put({ id: rec.id, blob: photoBlob });
        else if (removePhoto) t.objectStore("photos").delete(rec.id);
      });
    },
    deleteReading(id) {
      return this.tx(["readings", "photos"], "readwrite", (t) => { t.objectStore("readings").delete(id); t.objectStore("photos").delete(id); });
    },
  };

  /* ================= estado ================= */
  const state = {
    profiles: ls.get("dp.profiles", null) || [{ id: "p-eu", name: "Eu" }],
    current: ls.get("dp.current", "p-eu"),
    readings: [],
    tags: new Set(),
    photoBlob: null,      // foto nova no formulário
    editing: null,        // medição sendo editada
    editPhoto: "keep",    // keep | new | remove
    chartRange: 30,
    preset: "30",
    thumbs: new Map(),
  };
  if (!state.profiles.find((p) => p.id === state.current)) state.current = state.profiles[0].id;
  const currentProfile = () => state.profiles.find((p) => p.id === state.current) || state.profiles[0];
  const saveProfiles = () => { ls.set("dp.profiles", state.profiles); ls.set("dp.current", state.current); };
  saveProfiles();

  async function loadReadings() {
    const list = await DB.readingsFor(state.current);
    list.sort((a, b) => b.ts - a.ts);
    state.readings = list;
    renderAll();
  }

  /* ================= navegação ================= */
  const VIEWS = ["medir", "historico", "relatorio", "ajustes"];
  function route() {
    const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "medir";
    VIEWS.forEach((n) => ($("view-" + n).hidden = n !== v));
    document.querySelectorAll(".tabbar a").forEach((a) => {
      if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (v === "historico") renderChart();
    if (v === "relatorio") renderSummary();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  /* ================= pessoas ================= */
  function renderProfiles() {
    const p = currentProfile();
    $("profileName").textContent = p.name;
    $("wipeName").textContent = p.name;
    const menu = $("profileMenu");
    menu.innerHTML = state.profiles.map((x) =>
      `<button type="button" class="tag" role="option" data-pid="${esc(x.id)}" aria-pressed="${x.id === state.current}" aria-selected="${x.id === state.current}">${esc(x.name)}</button>`
    ).join("") + `<a class="tag" href="#ajustes" data-close>+ Pessoa</a>`;
    $("profileList").innerHTML = state.profiles.map((x) => `
      <li><span>${esc(x.name)}${x.id === state.current ? ' <span class="pill">atual</span>' : ""}</span>
        <span class="row">
          <button type="button" class="mini" data-rename="${esc(x.id)}">Renomear</button>
          ${state.profiles.length > 1 ? `<button type="button" class="mini" data-remove="${esc(x.id)}">Remover</button>` : ""}
        </span>
      </li>`).join("");
  }
  $("profileBtn").onclick = () => { const m = $("profileMenu"); m.hidden = !m.hidden; $("profileBtn").setAttribute("aria-expanded", String(!m.hidden)); };
  $("profileMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pid]");
    if (b) switchProfile(b.dataset.pid);
    if (b || e.target.closest("[data-close]")) $("profileMenu").hidden = true;
  });
  function switchProfile(id) {
    state.current = id; saveProfiles(); resetForm(); renderProfiles(); loadReadings();
    toast(`Mostrando dados de ${currentProfile().name}`);
  }
  $("addProfile").onclick = () => {
    const name = $("newProfile").value.trim();
    if (!name) { $("newProfile").focus(); return; }
    const p = { id: "p-" + uid(), name };
    state.profiles.push(p); $("newProfile").value = "";
    switchProfile(p.id);
  };
  $("newProfile").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("addProfile").click(); } });
  $("profileList").addEventListener("click", async (e) => {
    const rn = e.target.closest("[data-rename]"), rm = e.target.closest("[data-remove]");
    if (rn) {
      const li = rn.closest("li"); const p = state.profiles.find((x) => x.id === rn.dataset.rename);
      li.innerHTML = `<input type="text" value="${esc(p.name)}" maxlength="40" aria-label="Novo nome"><button type="button" class="btn" data-ok>OK</button>`;
      const inp = li.querySelector("input"); inp.focus(); inp.select();
      const done = () => { const v = inp.value.trim(); if (v) p.name = v; saveProfiles(); renderProfiles(); };
      li.querySelector("[data-ok]").onclick = done;
      inp.onkeydown = (ev) => { if (ev.key === "Enter") done(); };
    }
    if (rm) {
      if (!rm.classList.contains("confirm")) { rm.classList.add("confirm"); rm.textContent = "Apagar tudo dela?"; setTimeout(() => { if (rm.isConnected) { rm.classList.remove("confirm"); rm.textContent = "Remover"; } }, 4000); return; }
      const id = rm.dataset.remove;
      for (const r of await DB.readingsFor(id)) await DB.deleteReading(r.id);
      state.profiles = state.profiles.filter((x) => x.id !== id);
      if (state.current === id) state.current = state.profiles[0].id;
      saveProfiles(); renderProfiles(); loadReadings(); toast("Pessoa removida");
    }
  });

  /* ================= formulário ================= */
  TAGS.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tag"; b.textContent = t; b.dataset.tag = t; b.setAttribute("aria-pressed", "false");
    b.onclick = () => { const on = !state.tags.has(t); on ? state.tags.add(t) : state.tags.delete(t); b.setAttribute("aria-pressed", String(on)); };
    $("tags").appendChild(b);
  });

  function setTags(list) {
    state.tags = new Set(list || []);
    document.querySelectorAll("#tags .tag").forEach((b) => b.setAttribute("aria-pressed", String(state.tags.has(b.dataset.tag))));
  }
  function showPreview(blob, statusHtml, kind) {
    if (!blob) { $("previewBox").hidden = true; $("camLabel").textContent = "Fotografar o aparelho"; return; }
    if ($("previewImg").dataset.url) URL.revokeObjectURL($("previewImg").dataset.url);
    const u = URL.createObjectURL(blob); $("previewImg").src = u; $("previewImg").dataset.url = u;
    $("previewBox").hidden = false; $("camLabel").textContent = "Tirar outra foto";
    setStatus(statusHtml, kind);
  }
  function setStatus(html, kind) { const s = $("readStatus"); s.className = "status" + (kind ? " " + kind : ""); s.innerHTML = html; }

  function resetForm() {
    ["fSys", "fDia", "fPul", "fNote"].forEach((id) => ($(id).value = ""));
    $("fArm").value = ls.get("dp.arm", "");
    setTags([]); state.photoBlob = null; state.editing = null; state.editPhoto = "keep";
    showPreview(null);
    $("fWhen").value = localInput(new Date());
    $("formError").hidden = true;
    $("formTitle").textContent = "Nova medição"; $("cancelEdit").hidden = true; $("saveBtn").textContent = "Salvar medição";
  }
  $("clearBtn").onclick = resetForm;
  $("cancelEdit").onclick = resetForm;
  $("removePhoto").onclick = () => { state.photoBlob = null; state.editPhoto = state.editing ? "remove" : "keep"; showPreview(null); };

  async function shrink(file, max) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    } finally { URL.revokeObjectURL(url); }
  }

  $("photo").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    let blob; try { blob = await shrink(f, 1280); } catch { blob = f; }
    state.photoBlob = blob; if (state.editing) state.editPhoto = "new";
    if (!state.editing) $("fWhen").value = localInput(new Date());
    const ocrOn = ls.get("dp.ocrOn", true) && !!window.OCR;
    if ((WORKER_URL && navigator.onLine) || ocrOn) { showPreview(blob, '<span class="spin"></span>Lendo o visor do aparelho…'); readPhoto(blob); }
    else showPreview(blob, "Foto anexada. Digite os valores do visor nos campos abaixo.");
  });

  // 1º: Gemini pelo Worker  →  2º: leitor do aparelho (Tesseract)  →  3º: digitar
  let readSeq = 0;
  async function readPhoto(blob) {
    const seq = ++readSeq;
    const stale = () => seq !== readSeq || state.photoBlob !== blob;
    let aiMsg = "";
    if (WORKER_URL && navigator.onLine) {
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25000);
        const data = (await blobToDataURL(blob)).split(",")[1];
        const res = await fetch(WORKER_URL + "/read", {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: data, mimeType: blob.type || "image/jpeg" }),
        });
        clearTimeout(timer);
        const r = await res.json().catch(() => ({}));
        if (stale()) return;
        if (res.ok) { if (applyReading(r, "IA")) return; aiMsg = r.observacao || ""; }
        else aiMsg = r.message || "O leitor com IA não respondeu.";
      } catch { aiMsg = "O leitor com IA não respondeu."; }
    } else if (WORKER_URL) aiMsg = "Sem internet.";

    if (stale()) return;
    if (ls.get("dp.ocrOn", true) && window.OCR) {
      setStatus(`<span class="spin"></span>${aiMsg ? esc(aiMsg) + " " : ""}Tentando o leitor do aparelho…`);
      try {
        const r = await window.OCR.read(blob);
        if (stale()) return;
        markOcrReady();
        if (applyReading(r, "aparelho")) return;
        setStatus(esc(r.observacao || "Não consegui ler os números.") + " Digite os valores abaixo.", "warn");
        return;
      } catch {
        if (stale()) return;
        setStatus((aiMsg ? esc(aiMsg) + " " : "") + "O leitor do aparelho precisa de internet na primeira vez para ser baixado. Digite os valores abaixo.", "warn");
        return;
      }
    }
    setStatus((aiMsg ? esc(aiMsg) + " " : "") + "Digite os valores do visor abaixo.", "warn");
  }

  function applyReading(r, source) {
    const s = num(r.sistolica), d = num(r.diastolica), p = num(r.pulso);
    if (s == null && d == null) return false;
    if (s != null) $("fSys").value = s; if (d != null) $("fDia").value = d; if (p != null) $("fPul").value = p;
    const conf = r.confianca || "media";
    const how = source === "IA" ? "pela IA" : "pelo leitor do aparelho";
    const q = conf === "alta" ? "com boa confiança" : conf === "baixa" ? "incerta" : "razoável";
    setStatus(`Leitura ${how}, ${q}: <b>${s ?? "?"}/${d ?? "?"}</b>, pulso ${p ?? "?"}. Confira com o visor antes de salvar.${r.observacao ? `<br><span class="small">${esc(r.observacao)}</span>` : ""}`,
      conf === "baixa" || source !== "IA" ? "warn" : "ok");
    return true;
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = num($("fSys").value), d = num($("fDia").value), p = num($("fPul").value);
    const err = $("formError");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (s == null || d == null) return fail("Preencha pelo menos a sistólica e a diastólica.");
    if (s < 50 || s > 260 || d < 30 || d > 180 || s <= d) return fail("Esses valores parecem fora do normal para um aparelho. Confira a sistólica (maior) e a diastólica (menor).");
    if (p != null && (p < 30 || p > 220)) return fail("O pulso parece fora do normal. Confira o valor ou deixe em branco.");
    err.hidden = true;
    const when = $("fWhen").value ? new Date($("fWhen").value).getTime() : Date.now();
    const base = state.editing || { id: uid(), profile: state.current, createdAt: Date.now() };
    const hasPhoto = state.editing
      ? (state.editPhoto === "new" ? true : state.editPhoto === "remove" ? false : !!state.editing.hasPhoto)
      : !!state.photoBlob;
    const rec = { ...base, ts: when, sys: s, dia: d, pulse: p, tags: [...state.tags], note: $("fNote").value.trim(), arm: $("fArm").value, hasPhoto, updatedAt: Date.now() };
    ls.set("dp.arm", $("fArm").value);
    $("saveBtn").disabled = true;
    try {
      await DB.putReading(rec, state.photoBlob, state.editing && state.editPhoto === "remove");
      if (state.thumbs.has(rec.id)) { URL.revokeObjectURL(state.thumbs.get(rec.id)); state.thumbs.delete(rec.id); }
      const wasEdit = !!state.editing;
      resetForm(); await loadReadings();
      toast(wasEdit ? "Medição atualizada" : "Medição salva");
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch {
      fail("Não foi possível salvar. Verifique se o navegador não está em modo anônimo e se há espaço no aparelho.");
    } finally { $("saveBtn").disabled = false; }
  });

  async function startEdit(id) {
    const r = state.readings.find((x) => x.id === id); if (!r) return;
    resetForm(); state.editing = r;
    $("fSys").value = r.sys; $("fDia").value = r.dia; $("fPul").value = r.pulse ?? "";
    $("fNote").value = r.note || ""; $("fArm").value = r.arm || ""; $("fWhen").value = localInput(new Date(r.ts));
    setTags(r.tags);
    if (r.hasPhoto) { const b = await DB.getPhoto(r.id); if (b) showPreview(b, "Foto atual desta medição."); }
    $("formTitle").textContent = "Editar medição"; $("cancelEdit").hidden = false; $("saveBtn").textContent = "Salvar alterações";
    location.hash = "#medir";
    setTimeout(() => $("form").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  /* ================= renderização ================= */
  function renderLast() {
    const r = state.readings[0];
    const set = (id, v, ghost) => { const el = $(id); el.textContent = v; el.classList.toggle("ghost", ghost); };
    if (!r) {
      set("lSys", "---", true); set("lDia", "---", true); set("lPul", "--", true);
      $("lastWhen").textContent = "Nenhuma ainda"; $("lastCat").innerHTML = ""; $("lastNote").textContent = ""; $("stats").hidden = true; return;
    }
    set("lSys", r.sys, false); set("lDia", r.dia, false); set("lPul", r.pulse ?? "--", r.pulse == null);
    $("lastWhen").textContent = `${fmtDay(r.ts)}, ${fmtTime(r.ts)}`;
    $("lastCat").innerHTML = catChip(classify(r.sys, r.dia));
    $("lastNote").textContent = r.note || (r.tags || []).join(", ");
    const wk = state.readings.filter((x) => x.ts >= Date.now() - 7 * 864e5);
    $("stats").hidden = false;
    $("avgBp").textContent = wk.length ? `${avg(wk.map((x) => x.sys))}/${avg(wk.map((x) => x.dia))}` : "–";
    const ap = avg(wk.map((x) => x.pulse).filter((x) => x != null));
    $("avgPul").textContent = ap != null ? `${ap} bpm` : "–";
    $("cnt7").textContent = wk.length;
  }

  function chartSVG(pts, W, H, colors) {
    // pts em ordem cronológica
    const L = 30, R = 8, T = 10, B = 24;
    const vals = pts.flatMap((p) => [p.sys, p.dia]);
    const lo = Math.min(60, Math.floor((Math.min(...vals) - 10) / 20) * 20);
    const hi = Math.max(160, Math.ceil((Math.max(...vals) + 10) / 20) * 20);
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts, span = Math.max(1, t1 - t0);
    const x = (ts) => L + (ts - t0) * (W - L - R) / span;
    const y = (v) => T + (hi - v) * (H - T - B) / (hi - lo);
    let g = "";
    for (let v = lo; v <= hi; v += 20) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${colors.grid}" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    [130, 80].forEach((v) => (g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${colors.ref}" stroke-dasharray="4 4" stroke-width="1"/>`));
    const line = (k, c) => {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
      const dots = pts.map((p, i) => `<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p[k]).toFixed(1)}" r="${i === pts.length - 1 ? 4 : 2.5}" fill="${c}"/>`).join("");
      return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    };
    const fd = (ts) => new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    g += `<text x="${L}" y="${H - 6}">${fd(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fd(t1)}</text>`;
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de ${pts.length} medições">${g}${line("dia", colors.dia)}${line("sys", colors.sys)}</svg>`;
  }

  function renderChart() {
    const since = Date.now() - state.chartRange * 864e5;
    const pts = state.readings.filter((r) => r.ts >= since).slice().reverse();
    $("trendCard").hidden = state.readings.length < 2;
    const box = $("chart");
    if ($("view-historico").hidden || state.readings.length < 2) return;
    if (pts.length < 2) { box.innerHTML = `<p class="muted small">Menos de duas medições nos últimos ${state.chartRange} dias.</p>`; return; }
    const W = Math.max(280, box.clientWidth || 560);
    box.innerHTML = chartSVG(pts, W, 200, { grid: "var(--line)", ref: "var(--muted)", sys: "var(--sys)", dia: "var(--dia)" });
  }
  document.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => {
    state.chartRange = +b.dataset.range;
    document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderChart();
  }));
  let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderChart, 150); });

  async function thumbURL(id) {
    if (state.thumbs.has(id)) return state.thumbs.get(id);
    const b = await DB.getPhoto(id); if (!b) return null;
    const u = URL.createObjectURL(b); state.thumbs.set(id, u); return u;
  }

  function renderLog() {
    const log = $("log");
    if (!state.readings.length) {
      log.innerHTML = `<div class="empty">
        <div class="lcd"><div class="lab">SYS</div><div class="val sm ghost">---</div><div class="lab">DIA</div><div class="val sm ghost">---</div></div>
        <b>As medições de ${esc(currentProfile().name)} vão aparecer aqui</b>
        <span class="muted small">Cada uma com horário, foto do visor e o que estava fazendo. Comece pela aba Medir.</span>
        <a class="btn primary" href="#medir">Fazer a primeira medição</a></div>`;
      return;
    }
    const groups = new Map();
    state.readings.forEach((r) => { const k = dayKey(r.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    let html = "";
    for (const [, items] of groups) {
      html += `<div class="day"><h3>${esc(fmtDay(items[0].ts))}</h3>`;
      for (const r of items) {
        html += `<div class="entry">
          <div class="time">${fmtTime(r.ts)}</div>
          <div class="main">
            <div class="bp">${r.sys}/${r.dia} <small>mmHg</small>${r.pulse != null ? `<small>♥ ${r.pulse} bpm</small>` : ""}</div>
            <div>${catChip(classify(r.sys, r.dia))}</div>
            ${(r.tags && r.tags.length) || r.arm ? `<div class="etags">${(r.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}${r.arm ? `<span>Braço ${esc(r.arm.toLowerCase())}</span>` : ""}</div>` : ""}
            ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
          </div>
          <div class="side">
            ${r.hasPhoto ? `<button type="button" class="thumb" data-photo="${esc(r.id)}" aria-label="Ver foto"><img alt="" data-thumb="${esc(r.id)}"></button>` : ""}
            <button type="button" class="mini" data-edit="${esc(r.id)}">Editar</button>
            <button type="button" class="mini" data-del="${esc(r.id)}">Apagar</button>
          </div></div>`;
      }
      html += `</div>`;
    }
    log.innerHTML = html;
    log.querySelectorAll("img[data-thumb]").forEach(async (img) => { const u = await thumbURL(img.dataset.thumb); if (u) img.src = u; });
  }

  $("log").addEventListener("click", async (e) => {
    const ph = e.target.closest("[data-photo]");
    if (ph) { const u = await thumbURL(ph.dataset.photo); if (u) { $("lbImg").src = u; $("lightbox").hidden = false; } return; }
    const ed = e.target.closest("[data-edit]");
    if (ed) return startEdit(ed.dataset.edit);
    const del = e.target.closest("[data-del]");
    if (!del) return;
    if (!del.classList.contains("confirm")) {
      del.classList.add("confirm"); del.textContent = "Confirmar?";
      setTimeout(() => { if (del.isConnected) { del.classList.remove("confirm"); del.textContent = "Apagar"; } }, 4000);
      return;
    }
    await DB.deleteReading(del.dataset.del);
    if (state.thumbs.has(del.dataset.del)) { URL.revokeObjectURL(state.thumbs.get(del.dataset.del)); state.thumbs.delete(del.dataset.del); }
    await loadReadings(); toast("Medição apagada");
  });
  $("lightbox").onclick = () => ($("lightbox").hidden = true);

  function renderAll() { renderProfiles(); renderLast(); renderChart(); renderLog(); renderSummary(); }

  /* ================= relatório ================= */
  function applyPreset(p) {
    state.preset = p;
    document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === p)));
    const to = new Date();
    if (p === "all") {
      const first = state.readings.length ? new Date(state.readings[state.readings.length - 1].ts) : to;
      $("rFrom").value = dateInput(first);
    } else {
      const from = new Date(); from.setDate(from.getDate() - (+p - 1)); $("rFrom").value = dateInput(from);
    }
    $("rTo").value = dateInput(to);
    renderSummary();
  }
  document.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => applyPreset(b.dataset.preset)));
  ["rFrom", "rTo"].forEach((id) => $(id).addEventListener("change", () => {
    state.preset = ""; document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    renderSummary();
  }));

  function filtered() {
    const f = $("rFrom").value, t = $("rTo").value;
    const from = f ? new Date(f + "T00:00:00").getTime() : -Infinity;
    const to = t ? new Date(t + "T23:59:59.999").getTime() : Infinity;
    if (state.preset === "all") return state.readings.slice().reverse();
    return state.readings.filter((r) => r.ts >= from && r.ts <= to).reverse(); // cronológico
  }

  function stats(list) {
    const sys = list.map((r) => r.sys), dia = list.map((r) => r.dia), pul = list.map((r) => r.pulse).filter((x) => x != null);
    const morning = list.filter((r) => { const h = new Date(r.ts).getHours(); return h >= 5 && h < 12; });
    const evening = list.filter((r) => { const h = new Date(r.ts).getHours(); return h >= 18 || h < 2; });
    const high = list.filter((r) => r.sys >= 130 || r.dia >= 80).length;
    const days = new Set(list.map((r) => dayKey(r.ts))).size;
    return {
      n: list.length, days,
      avg: list.length ? `${avg(sys)}/${avg(dia)}` : "–",
      pulse: pul.length ? `${avg(pul)} bpm` : "–",
      min: list.length ? `${Math.min(...sys)}/${Math.min(...dia)}` : "–",
      max: list.length ? `${Math.max(...sys)}/${Math.max(...dia)}` : "–",
      morning: morning.length ? `${avg(morning.map((r) => r.sys))}/${avg(morning.map((r) => r.dia))} (${morning.length})` : "–",
      evening: evening.length ? `${avg(evening.map((r) => r.sys))}/${avg(evening.map((r) => r.dia))} (${evening.length})` : "–",
      highPct: list.length ? Math.round((high / list.length) * 100) + "%" : "–",
    };
  }

  function renderSummary() {
    if (!$("rFrom").value && !$("rTo").value) { applyPreset(state.preset || "30"); return; }
    const list = filtered(), s = stats(list);
    const box = $("rSummary");
    if (!list.length) {
      box.innerHTML = `<div class="full muted small">Nenhuma medição de ${esc(currentProfile().name)} neste período.</div>`;
    } else {
      box.innerHTML = `
        <div class="stat"><span class="eyebrow">Medições</span><b>${s.n} <small class="muted">em ${s.days} dia${s.days > 1 ? "s" : ""}</small></b></div>
        <div class="stat"><span class="eyebrow">Média</span><b>${s.avg}</b></div>
        <div class="stat"><span class="eyebrow">Manhã</span><b>${s.morning}</b></div>
        <div class="stat"><span class="eyebrow">Noite</span><b>${s.evening}</b></div>
        <div class="stat"><span class="eyebrow">Pulso médio</span><b>${s.pulse}</b></div>
        <div class="stat"><span class="eyebrow">Acima de 130/80</span><b>${s.highPct}</b></div>`;
    }
    ["rPrint", "rCsv", "rShare"].forEach((id) => ($(id).disabled = !list.length));
  }

  function csvFor(list) {
    const rows = [["Pessoa", "Data", "Hora", "Sistólica (mmHg)", "Diastólica (mmHg)", "Pulso (bpm)", "Classificação", "Braço", "Contexto", "Descrição", "Foto"]];
    const name = currentProfile().name;
    list.forEach((r) => rows.push([name, fmtDate(r.ts), fmtTime(r.ts), r.sys, r.dia, r.pulse ?? "", classify(r.sys, r.dia)?.label || "", r.arm || "", (r.tags || []).join(", "), r.note || "", r.hasPhoto ? "sim" : "não"]));
    return "\uFEFF" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  }
  const reportName = (ext) => {
    const slug = currentProfile().name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "pessoa";
    return `pressao-${slug}-${$("rFrom").value || "inicio"}-a-${$("rTo").value || "hoje"}.${ext}`;
  };

  $("rCsv").onclick = () => { const l = filtered(); if (l.length) { download(reportName("csv"), csvFor(l), "text/csv;charset=utf-8"); toast("Planilha baixada"); } };

  if (navigator.canShare) {
    try { if (navigator.canShare({ files: [new File(["x"], "t.csv", { type: "text/csv" })] })) $("rShare").hidden = false; } catch {}
  }
  $("rShare").onclick = async () => {
    const l = filtered(); if (!l.length) return;
    const file = new File([csvFor(l)], reportName("csv"), { type: "text/csv" });
    try { await navigator.share({ files: [file], title: "Medições de pressão", text: `Medições de pressão de ${currentProfile().name}` }); }
    catch (e) { if (e && e.name !== "AbortError") toast("Não foi possível compartilhar"); }
  };

  $("rPrint").onclick = async () => {
    const list = filtered(); if (!list.length) return;
    const s = stats(list), p = currentProfile();
    const withPhotos = $("rPhotos").checked;
    const fromTxt = list.length ? fmtDate(list[0].ts) : "", toTxt = list.length ? fmtDate(list[list.length - 1].ts) : "";
    const chart = list.length >= 2 ? chartSVG(list, 700, 220, { grid: "#E2E2E2", ref: "#888", sys: "#C4334A", dia: "#2346B5" }) : "";
    const photoUrls = {};
    if (withPhotos) for (const r of list) if (r.hasPhoto) photoUrls[r.id] = await thumbURL(r.id);
    const rows = list.map((r) => {
      const hi = r.sys >= 130 || r.dia >= 80;
      return `<tr>
        <td class="n">${fmtDate(r.ts)}<br>${fmtTime(r.ts)}</td>
        <td class="n ${hi ? "hi" : ""}">${r.sys}/${r.dia}</td>
        <td class="n">${r.pulse ?? "–"}</td>
        <td>${esc(classify(r.sys, r.dia)?.label || "")}${r.arm ? `<br><small>Braço ${esc(r.arm.toLowerCase())}</small>` : ""}</td>
        <td>${esc([(r.tags || []).join(", "), r.note].filter(Boolean).join(" — "))}</td>
        ${withPhotos ? `<td>${photoUrls[r.id] ? `<img class="ph" src="${photoUrls[r.id]}" alt="">` : ""}</td>` : ""}
      </tr>`;
    }).join("");
    $("printArea").innerHTML = `
      <h1>Diário de Pressão — ${esc(p.name)}</h1>
      <div class="meta">Período: ${fromTxt} a ${toTxt} · ${s.n} medições em ${s.days} dia(s) · gerado em ${new Date().toLocaleString("pt-BR")}</div>
      <div class="sumgrid">
        <div><span>Média geral</span><b>${s.avg}</b></div>
        <div><span>Média manhã</span><b>${s.morning}</b></div>
        <div><span>Média noite</span><b>${s.evening}</b></div>
        <div><span>Pulso médio</span><b>${s.pulse}</b></div>
        <div><span>Mínima</span><b>${s.min}</b></div>
        <div><span>Máxima</span><b>${s.max}</b></div>
        <div><span>Acima de 130/80</span><b>${s.highPct}</b></div>
        <div><span>Unidade</span><b>mmHg</b></div>
      </div>
      ${chart}
      <table>
        <thead><tr><th>Data</th><th>PA</th><th>Pulso</th><th>Classificação</th><th>Contexto / descrição</th>${withPhotos ? "<th>Foto</th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Valores destacados em vermelho estão em 130/80 mmHg ou acima. Mínima e máxima são calculadas separadamente para sistólica e diastólica. Classificação conforme a Diretriz Brasileira de Hipertensão Arterial (2020), feita para medidas de consultório. Medições registradas pelo próprio paciente em casa.</p>`;
    await Promise.all([...$("printArea").querySelectorAll("img")].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
    setTimeout(() => window.print(), 50);
  };

  /* ================= lembretes ================= */
  function parseTimes() {
    return [...new Set(($("remTimes").value.match(/\d{1,2}[:h]\d{2}|\b\d{1,2}h\b|\b\d{1,2}\b/g) || [])
      .map((t) => { const m = t.match(/(\d{1,2})(?:[:h](\d{2}))?/); const h = +m[1], mi = +(m[2] || 0); return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null; })
      .filter(Boolean))].sort();
  }
  function stamp(d, hh, mm, plusMin = 0) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm + plusMin);
    return `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  }
  const REM_TITLE = "Medir a pressão";
  const remText = () => `Sente-se e descanse 5 minutos, afira, fotografe o visor e registre no Diário de Pressão: ${location.href.split("#")[0]}`;
  function renderReminderLinks() {
    const times = parseTimes(), today = new Date();
    ls.set("dp.remTimes", $("remTimes").value);
    $("remLinks").innerHTML = times.map((t) => {
      const [h, m] = t.split(":").map(Number);
      const q = new URLSearchParams({ action: "TEMPLATE", text: REM_TITLE, details: remText(), dates: `${stamp(today, h, m)}/${stamp(today, h, m, 5)}`, recur: "RRULE:FREQ=DAILY" });
      return `<a href="https://calendar.google.com/calendar/render?${q}" target="_blank" rel="noopener">Google Agenda ${t}</a>`;
    }).join("");
  }
  $("remTimes").value = ls.get("dp.remTimes", $("remTimes").value);
  $("remTimes").addEventListener("input", renderReminderLinks);
  $("remIcs").onclick = () => {
    const times = parseTimes(); if (!times.length) { toast("Informe pelo menos um horário, ex.: 09:00"); return; }
    const today = new Date(), now = stamp(new Date(), new Date().getHours(), new Date().getMinutes());
    const foldEsc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const ev = times.map((t) => {
      const [h, m] = t.split(":").map(Number);
      return ["BEGIN:VEVENT", `UID:pressao-${t.replace(":", "")}-${uid()}@diario-pressao`, `DTSTAMP:${now}`,
        `DTSTART:${stamp(today, h, m)}`, `DTEND:${stamp(today, h, m, 5)}`, "RRULE:FREQ=DAILY",
        `SUMMARY:${foldEsc(REM_TITLE)}`, `DESCRIPTION:${foldEsc(remText())}`,
        "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${foldEsc(REM_TITLE)}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT"].join("\r\n");
    });
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Diario de Pressao//PT-BR", "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR"].join("\r\n");
    download("lembretes-pressao.ics", ics, "text/calendar;charset=utf-8");
  };

  /* ================= leitores automáticos ================= */
  const dot = (id, cls) => { $(id).className = "dot " + cls; };
  async function checkAI() {
    if (!WORKER_URL) { dot("aiDot", ""); $("aiState").textContent = "Não configurado neste site (config.js)."; return; }
    if (!navigator.onLine) { dot("aiDot", "wait"); $("aiState").textContent = "Sem internet agora."; return; }
    dot("aiDot", "wait"); $("aiState").textContent = "Verificando…";
    try {
      const r = await fetch(WORKER_URL + "/", { cache: "no-store" }).then((x) => x.json());
      if (r.ok && r.configured) { dot("aiDot", "on"); $("aiState").textContent = "Ativo. Usado primeiro quando há internet."; }
      else { dot("aiDot", "off"); $("aiState").textContent = "O leitor está no ar, mas sem chave do Gemini."; }
    } catch { dot("aiDot", "off"); $("aiState").textContent = "Não respondeu. Confira o endereço em config.js."; }
  }
  function markOcrReady() {
    ls.set("dp.ocrReady", true);
    dot("ocrDot", "on");
    $("ocrState").textContent = "Baixado. Funciona sem internet. Erra mais que a IA.";
    $("ocrDownload").hidden = true;
  }
  function renderReaders() {
    $("ocrOn").checked = ls.get("dp.ocrOn", true);
    if (!window.OCR) { dot("ocrDot", "off"); $("ocrState").textContent = "Indisponível neste navegador."; $("ocrDownload").hidden = true; }
    else if (ls.get("dp.ocrReady", false)) markOcrReady();
    checkAI();
  }
  $("ocrOn").onchange = () => ls.set("dp.ocrOn", $("ocrOn").checked);
  $("ocrDownload").onclick = async () => {
    const b = $("ocrDownload"); b.disabled = true; b.innerHTML = '<span class="spin"></span>Baixando…';
    try { await window.OCR.warmup(); markOcrReady(); toast("Leitor do aparelho pronto"); }
    catch { toast("Não foi possível baixar. Verifique a internet."); }
    finally { b.disabled = false; b.textContent = "Baixar leitor do aparelho agora"; }
  };
  window.addEventListener("online", checkAI);

  /* ================= cópia de segurança ================= */
  $("bkExport").onclick = async () => {
    $("bkExport").disabled = true;
    try {
      const readings = await DB.allReadings(), photos = {};
      if ($("bkPhotos").checked) for (const r of readings) if (r.hasPhoto) { const b = await DB.getPhoto(r.id); if (b) photos[r.id] = await blobToDataURL(b); }
      const data = { app: "diario-pressao", version: 1, exportedAt: new Date().toISOString(), profiles: state.profiles, readings, photos };
      download(`diario-pressao-copia-${dateInput(new Date())}.json`, JSON.stringify(data), "application/json");
      ls.set("dp.lastBackup", Date.now()); renderStorage();
      toast("Cópia salva em Downloads");
    } catch { toast("Não foi possível gerar a cópia"); }
    finally { $("bkExport").disabled = false; }
  };
  $("bkImport").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "diario-pressao" || !Array.isArray(data.readings)) throw new Error("formato");
      (data.profiles || []).forEach((p) => { if (p && p.id && p.name && !state.profiles.find((x) => x.id === p.id)) state.profiles.push({ id: String(p.id), name: String(p.name).slice(0, 40) }); });
      let n = 0;
      for (const r of data.readings) {
        if (!r || !r.id || !Number.isFinite(r.ts) || !Number.isFinite(r.sys) || !Number.isFinite(r.dia)) continue;
        if (!state.profiles.find((x) => x.id === r.profile)) r.profile = state.current;
        const ph = data.photos && data.photos[r.id] ? await dataURLToBlob(data.photos[r.id]) : null;
        r.hasPhoto = !!ph || (!!r.hasPhoto && !!(await DB.getPhoto(r.id)));
        await DB.putReading(r, ph, false); n++;
      }
      saveProfiles(); await loadReadings(); renderStorage();
      toast(`${n} medições restauradas`);
    } catch { toast("Arquivo inválido. Use uma cópia gerada por este app."); }
  });
  async function renderStorage() {
    const last = ls.get("dp.lastBackup", 0);
    let txt = last ? `Última cópia: ${new Date(last).toLocaleDateString("pt-BR")}.` : "Nenhuma cópia feita ainda.";
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); txt += ` Espaço usado: ${(e.usage / 1048576).toFixed(1)} MB.`; } } catch {}
    $("storageInfo").textContent = txt;
  }

  $("wipeBtn").onclick = async () => {
    const b = $("wipeBtn");
    if (!b.classList.contains("confirm")) {
      b.classList.add("confirm"); b.dataset.label = b.innerHTML; b.textContent = "Toque de novo para apagar tudo";
      setTimeout(() => { if (b.classList.contains("confirm")) { b.classList.remove("confirm"); b.innerHTML = b.dataset.label; renderProfiles(); } }, 4000);
      return;
    }
    b.classList.remove("confirm"); b.innerHTML = b.dataset.label;
    for (const r of state.readings) await DB.deleteReading(r.id);
    await loadReadings(); renderStorage(); toast("Medições apagadas");
  };

  /* ================= offline / PWA ================= */
  const online = () => ($("offlineBadge").hidden = navigator.onLine);
  window.addEventListener("online", online); window.addEventListener("offline", online); online();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  /* ================= início ================= */
  resetForm(); renderReaders(); renderReminderLinks(); renderStorage();
  // sem IA configurada, deixa o leitor do aparelho baixado de antemão (só com internet)
  if (!WORKER_URL && window.OCR && navigator.onLine && ls.get("dp.ocrOn", true) && !ls.get("dp.ocrReady", false)) {
    setTimeout(() => window.OCR.warmup().then(markOcrReady).catch(() => {}), 4000);
  }
  route();
  loadReadings().catch(() => {
    $("log").innerHTML = '<div class="status bad">Este navegador não permite guardar dados (modo anônimo?). Abra o app numa janela normal.</div>';
  });
})();
