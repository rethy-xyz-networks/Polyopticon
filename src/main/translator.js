'use strict';

// Offline machine translation (-> English) in its own utility process, using
// transformers.js + ONNX Runtime on the CPU. Models download from Hugging Face
// on first use and are cached in the data folder's models folder
// (%LocalAppData%\Polyopticon\models on Windows, ~/.config/Polyopticon/models on Linux).
//
//   • Opus-MT (Helsinki-NLP, ~75 MB each, ~0.5 s per headline) for languages that have one
//   • NLLB-200 distilled 600M (Meta, ~1 GB, a few seconds per headline) for everything else
//
// One request runs at a time; interactive requests jump the queue.
//
// Progress messages ({ type: 'progress', stage, tag, … }) let the UI show how far along it is:
//   stage 'download'    pct of the model files fetched so far (first use of a language only)
//   stage 'loading'     files are here, the model is being set up in memory
//   stage 'translating' done / total chunks of the request (tag = the caller's id, e.g. an item id)

const port = process.parentPort;
const post = msg => port.postMessage(msg);
const log = (level, msg) => post({ type: 'log', level, msg });

// (No Turkish here: Xenova's opus-mt-tc-big-tr-en loops on one word, "Bethlehem Bethlehem…", so Turkish uses NLLB.)
const OPUS = {
  ar: 'opus-mt-ar-en', ru: 'opus-mt-ru-en', uk: 'opus-mt-uk-en', fr: 'opus-mt-fr-en', de: 'opus-mt-de-en',
  es: 'opus-mt-es-en', it: 'opus-mt-it-en', nl: 'opus-mt-nl-en', pl: 'opus-mt-pl-en',
  zh: 'opus-mt-zh-en', ja: 'opus-mt-ja-en', ko: 'opus-mt-ko-en', cs: 'opus-mt-cs-en', fi: 'opus-mt-fi-en',
  sv: 'opus-mt-sv-en', da: 'opus-mt-da-en', id: 'opus-mt-id-en', hi: 'opus-mt-hi-en', th: 'opus-mt-th-en',
  vi: 'opus-mt-vi-en', hu: 'opus-mt-hu-en', pt: 'opus-mt-ROMANCE-en', ro: 'opus-mt-ROMANCE-en',
};
const NLLB_MODEL = 'nllb-200-distilled-600M';
const NLLB_CODES = {
  he: 'heb_Hebr', fa: 'pes_Arab', ur: 'urd_Arab', el: 'ell_Grek', be: 'bel_Cyrl', hy: 'hye_Armn', ka: 'kat_Geor',
  ps: 'pbt_Arab', ku: 'ckb_Arab', ar: 'arb_Arab', ru: 'rus_Cyrl', uk: 'ukr_Cyrl', tr: 'tur_Latn', zh: 'zho_Hans',
  ja: 'jpn_Jpan', ko: 'kor_Hang', fr: 'fra_Latn', de: 'deu_Latn', es: 'spa_Latn', it: 'ita_Latn', pt: 'por_Latn',
  nl: 'nld_Latn', pl: 'pol_Latn', hi: 'hin_Deva', id: 'ind_Latn', th: 'tha_Thai', vi: 'vie_Latn', sv: 'swe_Latn',
  sl: 'slv_Latn', is: 'isl_Latn', sk: 'slk_Latn', hr: 'hrv_Latn',
};

const MAX_CHUNK = 400;            // characters per model call (Opus-MT caps at 512 tokens)
const MAX_OPUS_LOADED = 4;
const NLLB_IDLE_MS = 10 * 60_000; // unload the big model after 10 idle minutes

let tf = null;
let cacheDir = null;
let options = { allowLarge: true };
const loaded = new Map();         // model id -> { pipe, lastUsed }
const loading = new Map();        // model id -> Promise
const queue = [];                 // { id, lang, texts, priority }
let busy = false;
let nllbTimer = null;

function route(lang) {
  if (OPUS[lang]) return { model: OPUS[lang] };
  if (NLLB_CODES[lang] && options.allowLarge) return { model: NLLB_MODEL, src: NLLB_CODES[lang] };
  return null;
}

async function getPipe(model, tag) {
  const hit = loaded.get(model);
  if (hit) { hit.lastUsed = Date.now(); return hit.pipe; }
  if (loading.has(model)) return loading.get(model);
  const p = (async () => {
    tf ??= await import('@huggingface/transformers');
    tf.env.cacheDir = cacheDir;
    tf.env.allowLocalModels = false;
    const started = Date.now();
    // A model is several files (encoder, decoder, tokenizer…): report their combined progress, not each file's.
    const files = new Map();                                   // file -> { loaded, total }
    let lastPct = -1, sentLoading = false;
    const pipe = await tf.pipeline('translation', `Xenova/${model}`, {
      dtype: 'q8',
      // ONNX Runtime's memory arena grows by doubling; for NLLB its next step is a single 2 GiB block,
      // which Electron's allocator refuses by crashing the utility process (SIGTRAP, exit code 133).
      // Without the arena each tensor is allocated on its own: a little slower, ~1 GB less memory.
      ...(model === NLLB_MODEL ? { session_options: { enableCpuMemArena: false } } : {}),
      progress_callback: ev => {
        if (ev.status !== 'progress' || !(ev.total > 0)) return;
        files.set(ev.file, { loaded: ev.loaded, total: ev.total });
        let loadedBytes = 0, totalBytes = 0;
        for (const f of files.values()) { loadedBytes += f.loaded; totalBytes += f.total; }
        if (totalBytes < 5e6) return;                          // only tiny files so far
        const pct = Math.floor(100 * loadedBytes / totalBytes);
        if (pct >= 100) { if (!sentLoading) { sentLoading = true; post({ type: 'progress', stage: 'loading', model, tag }); } }
        else if (pct > lastPct) { lastPct = pct; post({ type: 'progress', stage: 'download', model, tag, pct }); }   // never backwards when another file starts
      },
    });
    log('info', `Translation model ${model} ready (${Date.now() - started} ms)`);
    post({ type: 'progress', stage: 'ready', model, tag });
    // Keep memory bounded: unload the least recently used Opus model.
    const opus = [...loaded].filter(([m]) => m !== NLLB_MODEL).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (model !== NLLB_MODEL && opus.length >= MAX_OPUS_LOADED) {
      const [old, entry] = opus[0];
      loaded.delete(old);
      await entry.pipe.dispose?.();
    }
    loaded.set(model, { pipe, lastUsed: Date.now() });
    return pipe;
  })().finally(() => loading.delete(model));
  loading.set(model, p);
  return p;
}

/** Splits long text into sentence-ish chunks the models handle well. Keeps line breaks. */
function chunks(text) {
  const out = [];
  for (const para of text.split(/\n+/)) {
    if (!para.trim()) continue;
    const sentences = para.match(/[^.!?؟。！？]+[.!?؟。！？]*\s*/g) || [para];
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > MAX_CHUNK && cur) { out.push({ text: cur.trim(), br: false }); cur = ''; }
      cur += s;
      while (cur.length > MAX_CHUNK) { out.push({ text: cur.slice(0, MAX_CHUNK), br: false }); cur = cur.slice(MAX_CHUNK); }
    }
    if (cur.trim()) out.push({ text: cur.trim(), br: false });
    if (out.length) out[out.length - 1].br = true;
  }
  return out;
}

async function translateChunks(pipe, r, parts, onChunk) {
  let result = '';
  for (const c of parts) {
    const res = await pipe(c.text, r.src ? { src_lang: r.src, tgt_lang: 'eng_Latn', max_new_tokens: 512 } : { max_new_tokens: 512 });
    result += res[0].translation_text + (c.br ? '\n' : ' ');
    onChunk();
  }
  return result.trim();
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    queue.sort((a, b) => b.priority - a.priority);
    const job = queue.shift();
    try {
      const r = route(job.lang);
      if (!r) { post({ type: 'result', id: job.id, out: null, reason: 'unsupported' }); continue; }
      const pipe = await getPipe(r.model, job.tag);
      const started = Date.now();
      const parts = job.texts.map(t => (t && t.trim() ? chunks(t) : null));
      const total = parts.reduce((n, p) => n + (p ? p.length : 0), 0);
      let done = 0;
      const report = () => { if (job.tag != null) post({ type: 'progress', stage: 'translating', tag: job.tag, done, total }); };
      report();
      const out = [];
      for (let i = 0; i < parts.length; i++)
        out.push(parts[i] ? await translateChunks(pipe, r, parts[i], () => { done++; report(); }) : job.texts[i]);
      post({ type: 'result', id: job.id, out, model: r.model, ms: Date.now() - started });
      if (r.model === NLLB_MODEL) {
        clearTimeout(nllbTimer);
        nllbTimer = setTimeout(async () => {
          const e = loaded.get(NLLB_MODEL);
          if (e && !busy) { loaded.delete(NLLB_MODEL); await e.pipe.dispose?.(); log('info', 'Unloaded idle NLLB model'); }
        }, NLLB_IDLE_MS);
      }
    } catch (e) {
      log('warn', `Translation failed (${job.lang}): ${e.message}`);
      post({ type: 'result', id: job.id, out: null, reason: e.message });
    }
  }
  busy = false;
}

port.on('message', ({ data }) => {
  switch (data.cmd) {
    case 'init':
      options = { ...options, ...data.options };
      cacheDir = data.cacheDir;
      break;
    case 'options':
      options = { ...options, ...data.options };
      break;
    case 'translate':
      queue.push({ id: data.id, lang: data.lang, texts: data.texts, priority: data.priority ?? 0, tag: data.tag });
      pump();
      break;
    case 'supported':
      post({ type: 'supported', id: data.id, opus: Object.keys(OPUS), large: Object.keys(NLLB_CODES) });
      break;
  }
});

