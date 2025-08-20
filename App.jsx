import React, { useEffect, useState } from "react";

// ------------------------ CDN URLs (UMD builds) ------------------------------
const PDF_CDN_CANDIDATES = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.js",
  "https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.min.js",
];
const JSZIP_CDN_CANDIDATES = [
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
];

// ------------------------ BRANDING ------------------------------------------
const LOGO_URL = "/public/logo.jpg";

// ------------------------ CONFIG (EDIT FOR DEPLOY) --------------------------
const FRANCHISEE_PASSWORD = import.meta.env.VITE_PARTNER_PASSWORD || "CHANGE_ME_BEFORE_DEPLOY";
const ANALYTICS_ENDPOINT = "/api/analytics";
const PRELOADED_MANIFEST_URL = "/preloaded.json";
const QUESTION_EMBEDDING_PROXY = "/api/embed";
const ANSWER_PROXY = "/api/answer";

// ------------------------ UTILS ---------------------------------------------
const uid = () => Math.random().toString(36).slice(2);
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function tokenize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
}
function chunkTextByTokens(text, approxTokensPerChunk = 400) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += approxTokensPerChunk) {
    chunks.push(words.slice(i, i + approxTokensPerChunk).join(" "));
  }
  return chunks;
}
function autoTags(name, text="") {
  const s = `${name}\n${text.slice(0,1000)}`.toLowerCase();
  const tags = new Set();
  if (/recipe|prep|yield|ingredients|portion/.test(s)) tags.add("Recipe");
  if (/manual|operations|ops|sop|procedure|standard/.test(s)) tags.add("Ops Manual");
  if (/haccp|food safety|ccp|temperatur|sanitiz|cooling|holding/.test(s)) tags.add("HACCP");
  if (/training|onboarding|handbook|guide|curriculum/.test(s)) tags.add("Training");
  if (/lto|limited time|promo|promotion|campaign/.test(s)) tags.add("LTO");
  if (/oven|refrigerator|equipment|slicer|dishwasher|hood/.test(s)) tags.add("Equipment");
  if (/vendor|ordering|order|supplier|invoice|par/.test(s)) tags.add("Vendors");
  if (/hr|human resources|hiring|benefit|policy/.test(s)) tags.add("HR");
  if (/form|checklist|log|template/.test(s)) tags.add("Forms");
  if (tags.size===0) tags.add("Ops Manual");
  return Array.from(tags);
}

// ------------------------ DYNAMIC LOADERS -----------------------------------
let __PDF = null;
let __JSZip = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.getElementsByTagName('script')).find(s => s.src === src);
    if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', () => reject(new Error('load error'))); if (existing.dataset.loaded) return resolve(); }
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}
async function tryLoadFromCandidates(candidates, checker) {
  let lastErr = null;
  for (const url of candidates) {
    try {
      await loadScriptOnce(url);
      if (checker()) return true;
    } catch (e) { lastErr = e; }
  }
  if (!checker()) throw lastErr || new Error('All CDN candidates failed');
  return true;
}
async function ensurePDF() {
  if (__PDF) return __PDF;
  if (typeof window !== 'undefined' && window.pdfjsLib) __PDF = window.pdfjsLib;
  if (!__PDF) {
    try {
      await tryLoadFromCandidates(PDF_CDN_CANDIDATES, () => !!(window && window.pdfjsLib));
      __PDF = window.pdfjsLib;
    } catch (e) {
      try { if (typeof window !== 'undefined') window.__CAPS_PDF_DISABLED = true; } catch {}
      return null;
    }
  }
  if (!__PDF) { try { window.__CAPS_PDF_DISABLED = true; } catch {} ; return null; }
  try {
    __PDF.GlobalWorkerOptions.workerSrc = undefined;
    // @ts-ignore
    __PDF.GlobalWorkerOptions.workerPort = null;
  } catch {}
  try { window.__CAPS_PDF_DISABLED = false; } catch {}
  return __PDF;
}
async function ensureJSZip() {
  if (__JSZip) return __JSZip;
  if (typeof window !== 'undefined' && window.JSZip) __JSZip = window.JSZip;
  if (!__JSZip) {
    await tryLoadFromCandidates(JSZIP_CDN_CANDIDATES, () => !!(window && window.JSZip));
    __JSZip = window.JSZip;
  }
  return __JSZip;
}

async function extractPdfText(file, onProgress) {
  const pdfjsLib = await ensurePDF();
  if (!pdfjsLib) throw new Error('PDF parsing disabled (loader blocked).');
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer, disableWorker: true, useWorkerFetch: false, isEvalSupported: true }).promise;
  const pages = pdf.numPages;
  let out = "";
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str).join(" ");
    out += `\n\n[[PAGE ${p}]]\n` + strings;
    onProgress && onProgress({ page: p, pages });
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r=>setTimeout(r,0));
  }
  return { text: out, pages };
}

// ------------------------ OPENAI PROXIES ------------------------------------
async function embedViaProxy(question) {
  const res = await fetch(QUESTION_EMBEDDING_PROXY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: question }) });
  if (!res.ok) throw new Error(`Proxy embedding error: ${res.status}`);
  const json = await res.json();
  return json.embedding;
}
async function answerViaProxy(question, top, docs) {
  const segments = (top || []).map((c) => ({ text: c.text, page: c.page, docName: (docs.find((d) => d.id === c.docId)?.name) || "doc" }));
  const res = await fetch(ANSWER_PROXY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, segments }) });
  if (!res.ok) throw new Error(`Proxy answer error: ${res.status}`);
  const json = await res.json();
  return json.answer;
}

// ------------------------ BM25 ----------------------------------------------
function tokenizeLower(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}
function bm25TopK(question, chunks, k = 6) {
  const qTokens = tokenizeLower(question);
  const N = chunks.length || 1;
  const docTokens = chunks.map(c => tokenizeLower(c.text));
  const docLen = docTokens.map(toks => toks.length);
  const avgdl = docLen.reduce((a,b)=>a+b,0) / Math.max(N,1);
  const df = new Map();
  for (const toks of docTokens) {
    const seen = new Set();
    for (const t of toks) { if (!seen.has(t)) { df.set(t, (df.get(t)||0)+1); seen.add(t); } }
  }
  const idf = (t) => Math.log( (N - (df.get(t)||0) + 0.5) / ((df.get(t)||0) + 0.5) + 1 );
  const k1 = 1.5, b = 0.75;
  const scores = chunks.map((c, i) => {
    const toks = docTokens[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t)||0)+1);
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt) || 0;
      if (!f) continue;
      const _idf = idf(qt);
      score += _idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen[i] / (avgdl || 1))));
    }
    return { c, score };
  });
  return scores.sort((a,b)=>b.score-a.score).slice(0, k).map(x=>x.c);
}

// ------------------------ APP -----------------------------------------------
export default function App() {
  const [mode, setMode] = useState('admin'); // 'admin' or 'partner'
  const IS_PARTNER = mode === 'partner';

  const [docs, setDocs] = useState([]);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState({});
  const [progress, setProgress] = useState(null);
  const [uploadErr, setUploadErr] = useState("");
  const [selectedTags, setSelectedTags] = useState(new Set());

  useEffect(() => {
    setMessages([
      { role: "system", content: IS_PARTNER
        ? "You are CAPS Ops AI for Capriotti's. Franchisee (read-only) mode."
        : "You are CAPS Ops AI for Capriotti's (Admin)." },
    ]);
  }, [IS_PARTNER]);

  const TAGS = ["Recipe","Ops Manual","HACCP","Training","LTO","Equipment","Vendors","HR","Forms"];
  const toggleTag = (t) => setSelectedTags(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const clearTags = () => setSelectedTags(new Set());
  const docsByTagScope = () => (!selectedTags.size ? docs : docs.filter(d => d.tags?.some(t => selectedTags.has(t))));

  async function handleUploadInput(e) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    for (const file of files) {
      if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { setUploadErr(p => (p? p+"\\n": "") + `Unsupported file: ${file.name}`); continue; }
      const id = uid();
      let text = "", pages = 0, chunks = [];
      try {
        setProgress({ label: `Parsing ${file.name}…`, value: 0 });
        await ensurePDF();
        const parsed = await extractPdfText(file, ({ page, pages }) => setProgress({ label: `Parsing ${file.name} (page ${page}/${pages})…`, value: Math.round((page/pages)*100) }));
        text = parsed.text; pages = parsed.pages;
        const rough = chunkTextByTokens(text, 350);
        chunks = rough.map((txt, i) => {
          const m = txt.match(/\\[\\[PAGE (\\d+)\\]\\][\\s\\S]*$/);
          const page = m ? parseInt(m[1], 10) : Math.max(1, Math.round(((i + 1) / rough.length) * pages));
          return { id: uid(), docId: id, page, text: txt, embedding: null };
        });
      } catch (err) {
        setUploadErr(p => (p? p+"\\n": "") + `Text extraction skipped for ${file.name}: ${err.message}`);
      } finally {
        setProgress(null);
      }
      const newDoc = { id, name: file.name, file, text, pages, chunks, kind: "manual", tags: autoTags(file.name, text) };
      setDocs(prev => [...prev, newDoc]);
    }
    e.target.value = "";
  }

  function docsAllChunks() {
    const scoped = docsByTagScope();
    return scoped.flatMap(d => d.chunks);
  }

  async function sendMessage() {
    if (!query.trim()) return;
    setLoading(true);
    const userMsg = { role: "user", content: query };
    setMessages(prev => [...prev, userMsg]);
    try {
      const chunks = docsAllChunks();
      if (!chunks.length) {
        setMessages(prev => [...prev, { role: "assistant", content: IS_PARTNER ? "Docs not preloaded." : "Upload PDFs first (or paste text)." }]);
      } else {
        // Partner path: try proxy then fallback to BM25
        let top = [];
        try {
          const qEmb = await embedViaProxy(query);
          const usable = chunks.filter(c => Array.isArray(c.embedding) && c.embedding?.length);
          if (usable.length) {
            // cosine against embeddings if present else fallback below
            top = usable.map(ch => ({ ch, score: 0 })).slice(0,6).map(x=>x.ch);
          }
        } catch {}
        if (!top.length) top = bm25TopK(query, chunks, 6);

        const citeMap = top.map((c) => ({ docId: c.docId, page: c.page }));
        let answer = "Here’s what I found:\\n\\n" + top.map((c,i)=>`• [${i+1}] p.${c.page} — ${c.text.slice(0,240)}…`).join("\\n\\n");
        try {
          answer = await answerViaProxy(query, top, docs);
        } catch {}
        setMessages(prev => [...prev, { role: "assistant", content: answer, sources: citeMap }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
      setQuery("");
    }
  }

  const visibleDocs = docsByTagScope();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo.jpg" alt="Capriotti's" className="h-10 w-auto" />
            <div className="font-bold text-xl">CAPS Ops AI</div>
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-red-600 text-white">{IS_PARTNER ? 'Franchisee — Read-only' : 'Franchisor — Admin'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>setMode('admin')} className={`px-2 py-1 rounded-l-xl border ${!IS_PARTNER? 'bg-black text-white':'bg-white'}`}>Admin</button>
            <button onClick={()=>setMode('partner')} className={`px-2 py-1 rounded-r-xl border -ml-px ${IS_PARTNER? 'bg-black text-white':'bg-white'}`}>Franchisee</button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto grid grid-cols-12 gap-4 p-4">
        <div className="col-span-12 lg:col-span-4">
          <div className="bg-white border rounded-2xl shadow-sm p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold">Document Library</div>
              {mode==='admin' && (
                <label className="text-sm px-3 py-1.5 rounded-xl bg-black text-white cursor-pointer">
                  Upload PDF(s)
                  <input type="file" accept="application/pdf" multiple onChange={handleUploadInput} className="hidden" />
                </label>
              )}
            </div>
            {uploadErr && <div className="text-xs text-red-600 mt-2 whitespace-pre-wrap">{uploadErr}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              {TAGS.map(t => (
                <button key={t} onClick={()=>toggleTag(t)} className={`text-xs px-2 py-1 rounded-xl border ${selectedTags.has(t)?'bg-red-600 text-white border-red-600':'bg-white'}`}>{t}</button>
              ))}
              {selectedTags.size>0 && <button onClick={clearTags} className="text-xs px-2 py-1 rounded-xl border">Clear</button>}
            </div>
            {progress && (
              <div className="mt-3">
                <div className="text-xs text-gray-600 mb-1">{progress.label}</div>
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-2 bg-red-600" style={{ width: `${progress.value || 0}%` }} />
                </div>
              </div>
            )}
            <div className="mt-3 space-y-2 max-h-[50vh] overflow-auto">
              {visibleDocs.map((d) => (
                <div key={d.id} className="p-3 border rounded-2xl hover:bg-gray-50">
                  <div className="font-medium text-sm truncate">{d.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{(d.tags||[]).join(' • ')}</div>
                  <div className="text-xs text-gray-400">{d.pages || 0} pages • {d.chunks?.length? 'Parsed' : 'Not parsed yet'}</div>
                </div>
              ))}
              {!visibleDocs.length && (<div className="text-sm text-gray-500">No documents yet.</div>)}
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-8">
          <div className="bg-white border rounded-2xl shadow-sm p-4 flex flex-col h-[72vh]">
            <div className="flex-1 overflow-auto space-y-4 pr-1">
              {messages.filter((m)=>m.role!=="system").map((m,i)=>(
                <div key={i} className={m.role==="user"?"text-right":"text-left"}>
                  <div className={"inline-block max-w-[85%] px-4 py-3 rounded-2xl " + (m.role==="user"?"bg-black text-white":"bg-gray-100")}>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input value={query} onChange={(e)=>setQuery(e.target.value)} onKeyDown={(e)=>e.key==='Enter' && !loading && sendMessage()} placeholder="Ask about procedures, recipes, standards…" className="flex-1 px-4 py-3 border rounded-xl" />
              <button disabled={loading} onClick={sendMessage} className="px-4 py-3 rounded-2xl bg-red-600 text-white disabled:opacity-50">{loading ? "Thinking…" : "Send"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}