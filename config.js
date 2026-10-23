/* Configuração do Diário de Pressão.
   Depois de publicar o Cloudflare Worker (pasta worker/), cole o endereço dele em workerUrl,
   por exemplo "https://leitor-pressao.seu-usuario.workers.dev", e publique o site de novo.
   Deixe vazio para usar só o leitor do próprio aparelho. */
window.APP_CONFIG = {
  workerUrl: "https://leitor-pressao.bruno-l-motta.workers.dev/",

  // Leitor do aparelho (Tesseract.js) — normalmente não precisa mexer.
  tesseractUrl: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
  ocrLangPath: "https://cdn.jsdelivr.net/gh/Shreeshrii/tessdata_ssd@master",
  ocrLang: "ssd_int",
};
