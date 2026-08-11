/* Fair Use Database front end: hash routing over the Worker API.
   All data routes require a session; unauthenticated visitors see the
   sign-in gate (short About + How to use). */

let me = { authenticated: false };

const OUTCOME_LABELS = {
  fair_use: "Fair use",
  not_fair_use: "Not fair use",
  unresolved: "Unresolved",
  not_reached: "Not reached",
  unclear: "Unclear",
};
const DIRECTION_LABELS = {
  favors_fair_use: "favors fair use",
  disfavors_fair_use: "disfavors fair use",
  neutral: "neutral",
  mixed: "mixed",
  unclear: "unclear",
  not_analyzed: "not analyzed",
};
const FACTOR_NAMES = {
  1: "Purpose and character of the use",
  2: "Nature of the copyrighted work",
  3: "Amount and substantiality",
  4: "Effect on the market",
};
// Short vocabulary for the case-page factor register. Systematic grammar:
// holdings say "Not fair use", factors say "Favors/Against fair use",
// coverage says "Not reached".
const FACTOR_SHORT = { 1: "Purpose", 2: "Nature", 3: "Amount", 4: "Market" };
const DIR_SHORT = {
  favors_fair_use: "Favors fair use",
  disfavors_fair_use: "Against fair use",
  neutral: "Neutral",
  mixed: "Mixed",
  unclear: "Unclear",
  not_analyzed: "Not reached",
};
const DIR_MARK = { favors_fair_use: "+", disfavors_fair_use: "−", not_analyzed: "—" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// Display form of enum-style values: underscores become spaces.
const human = (s) => esc(String(s ?? "").replace(/_/g, " "));

// Sentence-case display for stored enum values ("unknown" → "Unknown").
function sentenceLabel(value) {
  const text = String(value ?? "").replace(/_/g, " ");
  return esc(text.charAt(0).toUpperCase() + text.slice(1));
}

// Metadata display: sentence-cased, with the "unknown" storage value
// rendered as an honest statement rather than a schema leak.
function metadataLabel(value) {
  const text = String(value ?? "").replace(/_/g, " ").trim();
  if (text.toLowerCase() === "unknown") return "Not identified";
  return esc(text.charAt(0).toUpperCase() + text.slice(1));
}

// Component codes carry a factor prefix ("f1_purpose_similarity") that the
// surrounding factor block already states.
function componentLabel(value) {
  const text = String(value ?? "")
    .replace(/^f\d+[_ ]?/i, "")
    .replace(/_/g, " ")
    .trim();
  return esc(text.charAt(0).toUpperCase() + text.slice(1));
}

const outcomeBadge = (o) =>
  o ? `<span class="badge ${esc(o)}">${esc(OUTCOME_LABELS[o] || o)}</span>` : "";

// Non-controlling voices get a warning badge: a dissent or party quote cited
// as holding is the classic practitioner failure.
const VOICE_BADGE_LABELS = {
  deciding_court_dissent: "dissent",
  lower_court: "lower court",
  party: "party statement",
  expert_or_witness: "expert/witness",
  unknown: "voice unknown",
};
const voiceBadge = (v) =>
  VOICE_BADGE_LABELS[v]
    ? `<span class="badge voice">${esc(VOICE_BADGE_LABELS[v])}</span>`
    : "";

async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) {
    // Session missing or expired: fall back to the sign-in gate.
    me = { authenticated: false };
    renderAccountBox();
    show("gate");
    throw new Error("auth required");
  }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function show(view) {
  if (view !== "case") destroyPdfViewer();
  // Ask fills the viewport (footer hidden, chat scrolls internally).
  document.body.classList.toggle("ask-mode", view === "ask");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${view}`).classList.remove("hidden");
  document.querySelectorAll("nav a").forEach((a) =>
    a.classList.toggle(
      "active",
      a.dataset.tab === view || (view === "case" && a.dataset.tab === "search")
    )
  );
}

/* ---------- citation builder ---------- */

// Lead cite: first reporter cite (U.S., S. Ct., F.-series, F. Supp., Fed.
// Cl.), else WL, else the first stored cite.
const REPORTER_RE =
  /^\d+ (?:U\.S\.|S\. Ct\.|F\.(?:2d|3d|4th)?|F\. Supp\.(?: 2d| 3d)?|F\. App'x|Fed\. Cl\.) \d+/;

function leadCite(citation) {
  const parts = (citation || "").split(";").map((s) => s.trim()).filter(Boolean);
  return (
    parts.find((p) => REPORTER_RE.test(p)) ||
    parts.find((p) => /^\d{4} WL \d+/.test(p)) ||
    parts[0] ||
    ""
  );
}

function quoteCitationText(quote, page, caseName, citation, courtAbbrev, date) {
  const year = (date || "").slice(0, 4);
  // Pin cite from the quote's own star pagination (e.g. [*534]); the
  // internal source-document page number is not a citable locator.
  const pin = String(quote || "").match(/\[?\*+(\d+[A-Za-z]?)\]?/);
  const clean = String(quote || "")
    .replace(/\[?\*+\d+[A-Za-z]?\]?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Bluebook-style: case cite with star pin, then attribution to the
  // database as the reprinting source.
  return `“${clean}” ${caseName}, ${leadCite(citation)}${pin ? `, at *${pin[1]}` : ""} (${courtAbbrev} ${year}), reprinted in Thomas A. Reichert, The Fair Use Database, https://thefairusedatabase.com.`;
}

function copyButton(payload) {
  return `<button type="button" class="copy-cite" aria-live="polite" data-cite="${esc(JSON.stringify(payload))}">Copy with citation</button>`;
}

const COPY_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const PIN_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.76l2.13 2.13a1 1 0 0 1-.7 1.71H7.57a1 1 0 0 1-.7-1.71Z"/></svg>';

function copyIconButton(payload) {
  return `<button type="button" class="copy-cite icon-btn" data-icon="1" title="Copy quote + citation" data-cite="${esc(JSON.stringify(payload))}">${COPY_SVG}</button>`;
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy-cite");
  if (!b) return;
  const p = JSON.parse(b.dataset.cite);
  const text = quoteCitationText(p.q, p.p, p.n, p.c, p.a, p.d);
  const idle = b.dataset.idle || (b.dataset.idle = b.innerHTML);
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    ok = false;
  }
  b.innerHTML = b.dataset.icon
    ? (ok ? "✓" : "✗")
    : (ok ? "Copied — verify before filing" : "Copy failed");
  setTimeout(() => (b.innerHTML = idle), 2500);
});

/* ---------- My Cases (persistent folders, server-side) ---------- */

function pinId(hit) {
  return `${hit.opinion_id}|${hit.page ?? ""}`;
}

function pinIconButton(hit) {
  return `<button type="button" class="pin-btn icon-btn" data-pinid="${esc(pinId(hit))}" title="Save to My Cases">${PIN_SVG}</button>`;
}

async function apiSend(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = "";
    try {
      msg = (await res.json()).error || "";
    } catch {}
    return { error: msg || `request failed (${res.status})` };
  }
  return res.json().catch(() => ({}));
}

let pickerEl = null;
function closeFolderPicker() {
  pickerEl?.remove();
  pickerEl = null;
}

// Save-to-folder picker anchored to the clicked control.
async function openFolderPicker(anchor, opinionId) {
  closeFolderPicker();
  const d = await apiSend("/api/folders", "GET");
  pickerEl = document.createElement("div");
  pickerEl.className = "folder-picker";
  const folders = d.folders || [];
  pickerEl.innerHTML = `
    <div class="fp-title">Save to folder</div>
    ${folders
      .map(
        (f) =>
          `<button type="button" class="fp-folder" data-fid="${f.folder_id}">${esc(f.name)}<span class="meta">${f.case_count}</span></button>`
      )
      .join("") || "<p class='fp-empty'>No folders yet — create one:</p>"}
    <form class="fp-new">
      <input maxlength="60" placeholder="New folder name" autocomplete="off" />
      <button type="submit">Create</button>
    </form>`;
  document.body.appendChild(pickerEl);
  const r = anchor.getBoundingClientRect();
  pickerEl.style.top = `${r.bottom + scrollY + 6}px`;
  pickerEl.style.left = `${Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - 270))}px`;
  const saveTo = async (fid, btn) => {
    const res = await apiSend(`/api/folders/${fid}/items`, "POST", {
      opinion_id: opinionId,
    });
    if (btn && !res.error) {
      btn.textContent = "Saved ✓";
      setTimeout(closeFolderPicker, 700);
    }
  };
  pickerEl.addEventListener("click", (e) => {
    const fb = e.target.closest(".fp-folder");
    if (fb) saveTo(fb.dataset.fid, fb);
  });
  pickerEl.querySelector(".fp-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const name = input.value.trim();
    if (!name) return;
    const res = await apiSend("/api/folders", "POST", { name });
    if (res.folder) {
      await saveTo(res.folder.folder_id, null);
      closeFolderPicker();
    } else {
      input.setCustomValidity(res.error || "could not create folder");
      input.reportValidity();
      setTimeout(() => input.setCustomValidity(""), 1500);
    }
  });
  pickerEl.querySelector(".fp-new input")?.focus();
}

document.addEventListener(
  "click",
  (e) => {
    if (
      pickerEl &&
      !pickerEl.contains(e.target) &&
      !e.target.closest(".pin-btn, .case-save")
    )
      closeFolderPicker();
  },
  true
);

document.addEventListener("click", (e) => {
  const b = e.target.closest(".pin-btn");
  if (!b) return;
  const oid = (b.dataset.pinid || "").split("|")[0];
  if (/^OP\d{6}$/.test(oid)) openFolderPicker(b, oid);
});

async function runMyCases() {
  const box = document.getElementById("folders-list");
  box.innerHTML = "<p class='meta'>Loading…</p>";
  const d = await apiSend("/api/folders", "GET");
  const folders = d.folders || [];
  if (!folders.length) {
    box.innerHTML =
      "<p>No folders yet. Create one above, then save cases from any case page or search result.</p>";
    return;
  }
  const parts = await Promise.all(
    folders.map(async (f) => {
      const fd = await apiSend(`/api/folders/${f.folder_id}`, "GET");
      const cases = fd.cases || [];
      const rows = cases
        .map(
          (c) => `<li>
            <a href="#/case/${esc(c.opinion_id)}">${esc(c.case_name)}</a>
            <span class="meta">${esc(leadCite(c.citation))} · ${esc((c.decision_date || "").slice(0, 4))}</span>
            <button type="button" class="folder-remove" data-fid="${f.folder_id}" data-oid="${esc(c.opinion_id)}">Remove</button>
          </li>`
        )
        .join("");
      return `<details class="folder-card" open>
        <summary>
          <span class="folder-name">${esc(f.name)}</span>
          <span class="meta">${cases.length} case${cases.length === 1 ? "" : "s"}</span>
          <button type="button" class="folder-delete" data-fid="${f.folder_id}" data-fname="${esc(f.name)}">Delete folder</button>
        </summary>
        ${rows ? `<ul class="folder-cases">${rows}</ul>` : "<p class='meta folder-empty'>Empty. Save cases from a case page.</p>"}
      </details>`;
    })
  );
  box.innerHTML = parts.join("");
}

document.getElementById("folder-create")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("folder-name");
  const name = input.value.trim();
  if (!name) return;
  const res = await apiSend("/api/folders", "POST", { name });
  if (res.error) {
    input.setCustomValidity(res.error);
    input.reportValidity();
    setTimeout(() => input.setCustomValidity(""), 1500);
    return;
  }
  input.value = "";
  runMyCases();
});

document.addEventListener("click", async (e) => {
  const del = e.target.closest(".folder-delete");
  if (del) {
    e.preventDefault();
    if (!confirm(`Delete folder "${del.dataset.fname}"? Its saved cases are removed from My Cases (the cases themselves are unaffected).`))
      return;
    await apiSend(`/api/folders/${del.dataset.fid}`, "DELETE");
    runMyCases();
    return;
  }
  const rem = e.target.closest(".folder-remove");
  if (rem) {
    await apiSend(`/api/folders/${rem.dataset.fid}/items/${rem.dataset.oid}`, "DELETE");
    runMyCases();
  }
});

/* ---------- search ---------- */

let lastSearch = null;

// Wrap query terms in <mark> on the raw text, escaping around the matches.
// Quoted spans highlight as phrases; loose words highlight individually.
function highlightQuote(raw, q) {
  const terms = [];
  const phraseRe = /"([^"]+)"/g;
  let m;
  while ((m = phraseRe.exec(q || ""))) terms.push(m[1].trim());
  for (const w of (q || "").replace(phraseRe, " ").split(/\s+/)) {
    if (w.length >= 3) terms.push(w);
  }
  if (!terms.length) return esc(raw);
  const pat = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return String(raw ?? "")
    .split(new RegExp(`(${pat})`, "gi"))
    .map((part, i) => (i % 2 ? `<mark class="hl">${esc(part)}</mark>` : esc(part)))
    .join("");
}

function setHomeExtras(visible) {
  const extras = document.getElementById("home-extras");
  if (extras) extras.classList.toggle("hidden", !visible);
}

function caseStripHtml(cases) {
  if (!cases.length) return "";
  const rows = cases
    .map(
      (c) => `
    <div class="case-strip-row">
      <a href="#/case/${esc(c.opinion_id)}">${esc(c.case_name)}</a>
      <span class="meta">${esc(leadCite(c.citation))} · ${esc(c.court_abbrev || "")} · ${esc(c.decision_date || "")}${c.publication_status === "unpublished" ? " · unpublished" : ""}</span>
    </div>`
    )
    .join("");
  return `<div class="case-strip"><h3>Cases</h3>${rows}</div>`;
}

const SEARCH_FILTER_IDS = { court: "sf-court", factor: "sf-factor", outcome: "sf-outcome" };
const ADV_FILTER_IDS = {
  circuit: "af-circuit",
  court_exact: "af-court-exact",
  pub: "af-pub",
  date_from: "af-date-from",
  date_to: "af-date-to",
  merits: "af-merits",
  posture: "af-posture",
  voice: "af-voice",
  direction: "af-direction",
  work_type: "af-work-type",
  use_type: "af-use-type",
  tech: "af-tech",
};
const ADV_TOKEN_LABELS = {
  circuit: "Circuit",
  court_exact: "Court",
  pub: "",
  date_from: "From year",
  date_to: "To year",
  merits: "Final merits",
  posture: "Posture",
  voice: "Voice",
  direction: "Direction",
  work_type: "Work type",
  use_type: "Use type",
  tech: "Technology",
};

function searchFilterParams() {
  const params = new URLSearchParams();
  for (const [key, id] of Object.entries(SEARCH_FILTER_IDS)) {
    const v = document.getElementById(id).value;
    if (v) params.set(key, v);
  }
  for (const [key, id] of Object.entries(ADV_FILTER_IDS)) {
    const el = document.getElementById(id);
    const v = el ? String(el.value).trim() : "";
    if (v) params.set(key, v);
  }
  return params;
}

/* ---------- advanced filters card ---------- */

let facetsLoaded = false;

function fillFacetSelect(id, rows, labelFn) {
  const el = document.getElementById(id);
  if (!el) return;
  const keep = el.value;
  el.innerHTML =
    '<option value="">Any</option>' +
    rows
      .map((r) => `<option value="${esc(r.value)}">${esc(labelFn(r))}</option>`)
      .join("");
  el.value = keep;
}

async function loadFacets() {
  if (facetsLoaded) return;
  try {
    const f = await api("/api/facets");
    const nice = (v) => String(v).replace(/_/g, " ");
    fillFacetSelect("af-court-exact", f.courts, (r) => `${r.value} (${r.n})`);
    fillFacetSelect("af-posture", f.postures, (r) => `${nice(r.value)} (${r.n})`);
    fillFacetSelect("af-work-type", f.workTypes, (r) => `${nice(r.value)} (${r.n})`);
    fillFacetSelect("af-use-type", f.useTypes, (r) => `${nice(r.value)} (${r.n})`);
    fillFacetSelect("af-tech", f.technologyContexts, (r) => `${nice(r.value)} (${r.n})`);
    facetsLoaded = true;
  } catch {
    /* card still works with the static selects */
  }
}

function advFilterCount() {
  let n = 0;
  for (const id of Object.values(ADV_FILTER_IDS)) {
    const el = document.getElementById(id);
    if (el && String(el.value).trim()) n++;
  }
  return n;
}

function renderFilterTokens() {
  const box = document.getElementById("filter-tokens");
  if (!box) return;
  const tokens = [];
  for (const [key, id] of Object.entries(ADV_FILTER_IDS)) {
    const el = document.getElementById(id);
    const v = el ? String(el.value).trim() : "";
    if (!v) continue;
    const sel = el.tagName === "SELECT" ? el.options[el.selectedIndex] : null;
    const display = (sel ? sel.textContent : v).replace(/\s*\(\d[\d,]*\)$/, "");
    const label = ADV_TOKEN_LABELS[key];
    tokens.push(
      `<button type="button" class="ftoken" data-fkey="${esc(key)}">${label ? esc(label) + ": " : ""}${esc(display)}<span class="ftoken-x">×</span></button>`
    );
  }
  box.innerHTML = tokens.join("");
  const toggle = document.getElementById("filters-toggle");
  if (toggle) {
    const n = advFilterCount();
    toggle.textContent = n ? `Filters · ${n}` : "Filters";
    toggle.classList.toggle("has-filters", n > 0);
  }
}

function wireFiltersCard() {
  const card = document.getElementById("filters-card");
  const toggle = document.getElementById("filters-toggle");
  if (!card || !toggle) return;
  toggle.addEventListener("click", () => {
    card.classList.toggle("hidden");
    toggle.classList.toggle("open", !card.classList.contains("hidden"));
    if (!card.classList.contains("hidden")) loadFacets();
  });
  document.getElementById("filters-apply").addEventListener("click", () => {
    card.classList.add("hidden");
    toggle.classList.remove("open");
    renderFilterTokens();
    rerunActive();
  });
  document.getElementById("filters-clear").addEventListener("click", () => {
    for (const id of Object.values(ADV_FILTER_IDS)) {
      const el = document.getElementById(id);
      if (el) el.value = "";
    }
    renderFilterTokens();
    rerunActive();
  });
  document.getElementById("filter-tokens").addEventListener("click", (e) => {
    const t = e.target.closest(".ftoken");
    if (!t) return;
    const el = document.getElementById(ADV_FILTER_IDS[t.dataset.fkey]);
    if (el) el.value = "";
    renderFilterTokens();
    rerunActive();
  });
}

async function runSearch(q, page = 1) {
  const box = document.getElementById("search-results");
  setHomeExtras(false);
  box.innerHTML = "<p class='meta'>Searching…</p>";
  const filterQs = searchFilterParams().toString();
  const [data, caseData] = await Promise.all([
    api(`/api/search?q=${encodeURIComponent(q)}&page=${page}` +
        (filterQs ? `&${filterQs}` : "")),
    api(`/api/case-search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] })),
  ]);
  const count = document.getElementById("sf-count");
  if (count) count.textContent = `${data.total.toLocaleString()} quotes`;
  lastSearch = { q, page, total: data.total };
  const strip = caseStripHtml(caseData.results || []);
  const panel = document.getElementById("context-panel");
  if (!data.results.length) {
    box.innerHTML = strip + "<p>No quotes matched.</p>";
    if (panel) panel.classList.add("hidden");
    return;
  }
  searchHits = data.results;
  const first = (page - 1) * data.pageSize + 1;
  const rows = data.results
    .map((r, i) => {
      const year = (r.decision_date || "").slice(0, 4);
      const oLabel = OUTCOME_LABELS[r.outcome] || r.outcome || "";
      return `
    <div class="result-row" data-hit="${i}">
      <div class="row-line1">
        <span class="row-num">${first + i}.</span>
        <a class="row-case" href="#/case/${esc(r.opinion_id)}" target="_blank" rel="noopener">${esc(r.case_name)}</a>
        <span class="row-cite">${esc(leadCite(r.citation))}${year ? ` · ${esc(year)}` : ""}</span>
        ${r.outcome ? `<span class="row-outcome ${esc(r.outcome)}"><span class="odot"></span>${esc(oLabel)}</span>` : ""}
        ${voiceBadge(r.voice)}
        <span class="row-right">
          <span class="row-chips">${miniFactorChips(r.factors_agg)}</span>
        </span>
      </div>
      <div class="row-line2">
        <span class="row-quote">“${highlightQuote(r.quote, q)}”
          <span class="row-page">— p. ${esc(r.page)}${r.section ? ", " + esc(r.section) : ""}</span></span>
        <span class="row-acts">
          ${copyIconButton({ q: r.quote, p: r.page, n: r.case_name, c: r.citation, a: r.court_abbrev || r.court, d: r.decision_date })}
          ${pinIconButton(r)}
        </span>
      </div>
    </div>`;
    })
    .join("");
  const pages = Math.ceil(data.total / data.pageSize);
  const last = Math.min(page * data.pageSize, data.total);
  const rangeLine = `<p class="range-line">${first.toLocaleString()}–${last.toLocaleString()} of ${data.total.toLocaleString()}</p>`;
  const pagerLine =
    `<div class="pager-line">${rangeLine}${numberedPagerHtml(page, pages, `search:${q}`)}</div>`;
  box.innerHTML = strip + `<div class="result-list">${rows}</div>` + pagerLine;
  selectHit(0);
}

/* ---------- selected-result context panel ---------- */

let searchHits = [];
const caseCache = new Map();

const DIRECTION_CHIP = {
  favors_fair_use: ["favor", "favors"],
  disfavors_fair_use: ["against", "against"],
  neutral: ["na", "neutral"],
  mixed: ["na", "mixed"],
  unclear: ["na", "unclear"],
  not_analyzed: ["na", "not reached"],
};

// Per-row mini chips from the server's "1:favors_fair_use,4:disfavors_fair_use"
// aggregate. Duplicate factor numbers (multi-unit opinions) keep the first
// analyzed direction, matching factorChips below.
function miniFactorChips(agg) {
  if (!agg) return "";
  const byNum = new Map();
  for (const part of String(agg).split(",")) {
    const idx = part.indexOf(":");
    if (idx < 1) continue;
    const n = Number(part.slice(0, idx));
    const dir = part.slice(idx + 1);
    if (!n) continue;
    if (!byNum.has(n) || byNum.get(n) === "not_analyzed") byNum.set(n, dir);
  }
  return [...byNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, dir]) => {
      const [cls] = DIRECTION_CHIP[dir] || ["na"];
      return `<span class="mfchip ${cls}" title="Factor ${n}: ${esc(DIRECTION_LABELS[dir] || dir)}">F${n}</span>`;
    })
    .join("");
}

function factorChips(factors) {
  if (!factors || !factors.length) return "";
  const byNum = new Map();
  for (const f of factors) {
    // Multi-unit opinions repeat factor numbers; keep the first analyzed one.
    if (!byNum.has(f.factor_number) ||
        byNum.get(f.factor_number) === "not_analyzed") {
      byNum.set(f.factor_number, f.direction);
    }
  }
  return [...byNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, dir]) => {
      const [cls, label] = DIRECTION_CHIP[dir] || ["na", human(dir)];
      return `<span class="fchip ${cls}">F${n} ${esc(label)}</span>`;
    })
    .join("");
}

async function selectHit(i) {
  const panel = document.getElementById("context-panel");
  const hit = searchHits[i];
  if (!panel || !hit) return;
  document.querySelectorAll(".result-row").forEach((c) =>
    c.classList.toggle("selected", Number(c.dataset.hit) === i)
  );
  const year = (hit.decision_date || "").slice(0, 4);
  const q = lastSearch ? lastSearch.q : "";
  const pid = pinId(hit);
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-head-top">
        <p class="eyebrow">Selected result</p>
        <button type="button" class="pin-btn pin-text" data-pinid="${esc(pid)}">${PIN_SVG}<span class="pin-label">Save to My Cases</span></button>
      </div>
      <div class="panel-head-main">
        <div class="panel-identity">
          <h3 class="panel-case"><a href="#/case/${esc(hit.opinion_id)}" target="_blank" rel="noopener">${esc(hit.case_name)}</a></h3>
          <div class="meta">${esc(leadCite(hit.citation))} (${esc(hit.court_abbrev || hit.court || "")} ${esc(year)})</div>
          <div class="panel-badge">${outcomeBadge(hit.outcome)}${voiceBadge(hit.voice)}<span class="chips-inline" id="panel-factor-chips">${miniFactorChips(hit.factors_agg)}</span></div>
        </div>
        <div class="panel-mini-ctas">
          <button type="button" class="copy-cite btn-outline btn-sm" data-cite="${esc(JSON.stringify({ q: hit.quote, p: hit.page, n: hit.case_name, c: hit.citation, a: hit.court_abbrev || hit.court, d: hit.decision_date }))}">Copy citation</button>
          <a class="panel-cta btn-sm" href="#/case/${esc(hit.opinion_id)}" target="_blank" rel="noopener">Read full analysis</a>
        </div>
      </div>
    </div>
    <div class="panel-section">
      <h4>Selected quote</h4>
      <blockquote class="panel-quote">“${highlightQuote(hit.quote, q)}”
        <span class="quote-page">— p. ${esc(hit.page)}${hit.section ? ", " + esc(hit.section) : ""}</span></blockquote>
    </div>
    <div class="panel-section">
      <h4>Work / use pair</h4>
      <table class="panel-pair">
        <tr><th>Original work</th><td>${human(hit.copyrighted_work_label || "—")}</td></tr>
        <tr><th>Challenged use</th><td>${human(hit.challenged_use_label || "—")}</td></tr>
      </table>
    </div>
    <div class="panel-section" id="panel-posture"></div>
    <div class="panel-section" id="panel-other"></div>`;
  let caseData = caseCache.get(hit.opinion_id);
  if (!caseData) {
    try {
      caseData = await api(`/api/case/${hit.opinion_id}`);
      caseCache.set(hit.opinion_id, caseData);
    } catch {
      caseData = null;
    }
  }
  const slot = document.getElementById("panel-factor-chips");
  // Guard against a stale response after the user clicked another row.
  if (!slot || !panel.innerHTML.includes(hit.opinion_id)) return;
  if (caseData && caseData.factors && caseData.factors.length) {
    slot.innerHTML = factorChips(caseData.factors);
  }
  const postureSlot = document.getElementById("panel-posture");
  if (postureSlot) {
    const postures = caseData && caseData.postures
      ? caseData.postures.map((p) => human(p.posture)).filter(Boolean)
      : [];
    postureSlot.innerHTML = postures.length
      ? `<h4>Procedural posture</h4><p class="panel-posture-line">${postures.join(", ")}</p>`
      : "";
  }
  const otherSlot = document.getElementById("panel-other");
  if (otherSlot) {
    const others = caseData && caseData.evidence
      ? caseData.evidence
          .filter((ev) => ev.quote && ev.quote !== hit.quote)
          .slice(0, 3)
      : [];
    otherSlot.innerHTML = others.length
      ? `<h4>Other quotes from this case</h4>
         <ul class="panel-other-list">${others
           .map(
             (ev) => `<li><a href="#/case/${esc(hit.opinion_id)}" target="_blank" rel="noopener">
               <span class="other-quote">“${esc(ev.quote)}”</span>
               <span class="other-page">p. ${esc(ev.page)}</span>
               <span class="other-arrow">›</span></a></li>`
           )
           .join("")}</ul>`
      : "";
  }
}

document.addEventListener("click", (e) => {
  const card = e.target.closest(".result-row");
  if (!card || e.target.closest("a") || e.target.closest("button")) return;
  selectHit(Number(card.dataset.hit));
});

/* ---------- cases mode (#/browse) ---------- */

// One filter band, two result shapes: "quotes" runs the FTS search, "cases"
// lists opinions through the same filter grammar. #/browse is the cases mode
// of the search view; the standalone browse page is gone.
let resultsMode = "quotes";

const CASES_HASH_IDS = {
  outcome: "sf-outcome",
  court_level: "sf-court",
  factor: "sf-factor",
  circuit: "af-circuit",
  direction: "af-direction",
  court_exact: "af-court-exact",
  pub: "af-pub",
  date_from: "af-date-from",
  date_to: "af-date-to",
  posture: "af-posture",
  work_type: "af-work-type",
  use_type: "af-use-type",
  tech: "af-tech",
};

function setMode(mode) {
  resultsMode = mode;
  const qBtn = document.getElementById("mode-quotes");
  const cBtn = document.getElementById("mode-cases");
  if (qBtn) qBtn.classList.toggle("active", mode === "quotes");
  if (cBtn) cBtn.classList.toggle("active", mode === "cases");
  const input = document.getElementById("search-input");
  if (input) {
    input.placeholder =
      mode === "cases"
        ? "Filter by case name (optional)"
        : "Search court language or a case name";
  }
}

function rerunActive(page = 1) {
  if (resultsMode === "cases") runCases(page);
  else if (lastSearch && lastSearch.q) runSearch(lastSearch.q, page);
}

// Factor-block pivots and saved links arrive as #/browse?factor=4&...; map
// those params onto the shared band controls. A bare #/browse leaves the
// band exactly as the user set it.
function applyBrowseHash(hash) {
  const qs = hash.split("?")[1] || "";
  if (!qs) return;
  const params = new URLSearchParams(qs);
  for (const [key, id] of Object.entries(CASES_HASH_IDS)) {
    const el = document.getElementById(id);
    if (el) el.value = params.get(key) || "";
  }
}

async function runCases(page = 1) {
  const box = document.getElementById("search-results");
  setHomeExtras(false);
  const panel = document.getElementById("context-panel");
  if (panel) panel.classList.add("hidden");
  box.innerHTML = "<p class='meta'>Loading…</p>";
  const params = searchFilterParams();
  const court = params.get("court");
  if (court) {
    params.delete("court");
    params.set("court_level", court);
  }
  const q = document.getElementById("search-input").value.trim();
  if (q) params.set("q", q);
  params.set("page", page);
  const data = await api(`/api/cases?${params}`);
  const count = document.getElementById("sf-count");
  if (count) count.textContent = `${data.total.toLocaleString()} cases`;
  if (!data.results.length) {
    box.innerHTML = "<p>No cases matched.</p>";
    return;
  }
  const cards = data.results
    .map((r) => {
      const outcomes = (r.outcomes || "")
        .split(",")
        .filter(Boolean)
        .map(outcomeBadge)
        .join("");
      const unitNote =
        r.unit_count > 1 ? `<span class="meta"> · ${r.unit_count} work/use units</span>` : "";
      return `
    <div class="card">
      <h3><a href="#/case/${esc(r.opinion_id)}">${esc(r.case_name)}</a>${outcomes}</h3>
      <div class="meta">${esc(r.citation || "")} · ${esc(r.court_abbrev || r.court || "")} · ${esc(r.decision_date || "")}${unitNote}</div>
    </div>`;
    })
    .join("");
  const pages = Math.ceil(data.total / data.pageSize);
  box.innerHTML = cards + numberedPagerHtml(page, pages, "browse");
}

// Numbered pager (search results): first/last always visible, a window of
// neighbors around the current page, ellipses between gaps.
function numberedPagerHtml(page, pages, ctx) {
  if (pages <= 1) return "";
  const nums = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p >= 1 && p <= pages) nums.add(p);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  let items = "";
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) items += `<span class="pager-gap">…</span>`;
    items +=
      p === page
        ? `<span class="pager-num current">${p}</span>`
        : `<button class="pager-num" data-pager="${esc(ctx)}" data-page="${p}">${p}</button>`;
    prev = p;
  }
  const prevBtn =
    page > 1
      ? `<button class="pager-num pager-word" data-pager="${esc(ctx)}" data-page="${page - 1}">Previous</button>`
      : `<button class="pager-num pager-word" disabled>Previous</button>`;
  const nextBtn =
    page < pages
      ? `<button class="pager-num pager-word" data-pager="${esc(ctx)}" data-page="${page + 1}">Next</button>`
      : `<button class="pager-num pager-word" disabled>Next</button>`;
  return `<div class="pager pager-numbered">${prevBtn}${items}${nextBtn}</div>`;
}

function pagerHtml(page, pages, ctx) {
  if (pages <= 1) return "";
  const prev =
    page > 1
      ? `<button data-pager="${esc(ctx)}" data-page="${page - 1}">Previous</button>`
      : "";
  const next =
    page < pages
      ? `<button data-pager="${esc(ctx)}" data-page="${page + 1}">Next</button>`
      : "";
  return `<div class="pager">${prev}<span>Page ${page} of ${pages}</span>${next}</div>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pager]");
  if (!b) return;
  const page = parseInt(b.dataset.page, 10);
  const ctx = b.dataset.pager;
  if (ctx === "browse") runCases(page);
  else if (ctx.startsWith("search:")) runSearch(ctx.slice(7), page);
});

/* ---------- stats ---------- */

async function runStats() {
  const box = document.getElementById("stats-body");
  const s = await api("/api/stats");
  const outcomeRows = s.outcomes
    .map(
      (r) =>
        `<tr><td>${esc(OUTCOME_LABELS[r.outcome] || r.outcome)}</td><td>${r.n}</td></tr>`
    )
    .join("");
  const dirMatrix = {};
  for (const r of s.factorDirections) {
    (dirMatrix[r.factor_number] ||= {})[r.direction] = r.n;
  }
  const dirCols = ["favors_fair_use", "disfavors_fair_use", "neutral", "mixed", "unclear", "not_analyzed"];
  const dirRows = [1, 2, 3, 4]
    .map(
      (f) =>
        `<tr><td>${esc(FACTOR_NAMES[f])}</td>` +
        dirCols.map((d) => `<td>${dirMatrix[f]?.[d] || 0}</td>`).join("") +
        "</tr>"
    )
    .join("");
  const COHORT_LABELS = {
    decisive_merits: "Decisive on the merits",
    substantive_other: "Substantive (other)",
    uncertain: "Uncertain",
    excluded: "Screened out (non-substantive)",
  };
  const cohortOrder = ["decisive_merits", "substantive_other", "uncertain", "excluded"];
  const funnelMap = Object.fromEntries(
    (s.screeningFunnel || []).map((r) => [r.cohort_class, r.n])
  );
  const screened = Object.values(funnelMap).reduce((t, n) => t + n, 0);
  const funnelRows = cohortOrder
    .filter((c) => funnelMap[c])
    .map(
      (c) =>
        `<tr><td>${esc(COHORT_LABELS[c] || c)}</td><td>${funnelMap[c].toLocaleString()}</td></tr>`
    )
    .join("");
  // The two single-dimension tables render as the same citable figure
  // component the Ask charts use, so "Copy chart" and the Bluebook line
  // travel with them; the factor matrix stays tabular with a citation.
  const rel = s.release ? s.release.release_id : "v0.2.0";
  statsChartEvs = {
    outcomes: {
      type: "stat", measure: "work_use_unit_count", group_by: "outcome",
      rows: s.outcomes.map((r) => ({ value: r.outcome, count: r.n })),
      denominator: s.unitCount, missing_or_unknown: 0, mutually_exclusive: true,
      release: rel, unit_of_analysis: "work/use units",
    },
    funnel: {
      type: "stat", measure: "opinion_count", group_by: "screening_cohort",
      rows: cohortOrder.filter((c) => funnelMap[c])
        .map((c) => ({ value: c, count: funnelMap[c] })),
      denominator: screened, missing_or_unknown: 0, mutually_exclusive: true,
      release: rel, unit_of_analysis: "screened opinions",
    },
  };
  box.innerHTML = `
    <h2>Corpus</h2>
    <p>${s.quoteCount.toLocaleString()} verified quotes across ${s.unitCount.toLocaleString()} work/use units.
      ${s.release ? `Release ${esc(s.release.release_id)}, coverage through ${esc(s.release.coverage_end)}.` : ""}</p>
    <h2>Screening funnel</h2>
    <p class="meta">${screened.toLocaleString()} opinions screened. Non-substantive opinions stay listed in the screening ledger; the coded database covers the substantive cohorts.</p>
    ${askStatChart(statsChartEvs.funnel, "s", "funnel", "bars")}
    <h2>Unit outcomes</h2>
    ${askStatChart(statsChartEvs.outcomes, "s", "outcomes", "bars")}
    <h2>Factor directions (selected extractions)</h2>
    <table class="stats">
      <tr><th>Factor</th>${dirCols.map((d) => `<th>${esc(DIRECTION_LABELS[d])}</th>`).join("")}</tr>
      ${dirRows}
    </table>
    <div class="ask-chart-cite">${esc(askChartCitation({ release: rel }))}</div>`;
}

// Stat evidence backing the Statistics-page figures, keyed for the copy
// button's delegated handler.
let statsChartEvs = {};

/* ---------- case detail ---------- */

// Holding strip: answer "what happened" before any metadata.
function holdingStripHtml(d) {
  const coded = d.units.filter((u) => u.extraction_id != null);
  const outcomes = [...new Set(coded.map((u) => u.outcome).filter(Boolean))];
  const motions = d.motionOutcomes
    .map((m) => `${metadataLabel(m.posture)}: ${metadataLabel(m.result)}`)
    .join(" · ");
  const merits = coded.some((u) => u.final_merits_status === "yes")
    ? "Final merits determination."
    : "";
  // Label and result badge share a header row; the holding prose starts on
  // its own clean axis below, with the disposition line subordinate.
  let badge = "";
  let prose;
  if (!coded.length) {
    prose = "No coded work/use holding.";
  } else if (outcomes.length <= 1 && coded.length === 1) {
    badge = outcomeBadge(outcomes[0]);
    prose = coded[0].scope ? esc(coded[0].scope) : "";
  } else if (outcomes.length <= 1) {
    badge = outcomeBadge(outcomes[0]);
    prose = `${coded.length} work/use analyses.`;
  } else {
    prose = `Mixed outcomes across ${coded.length} work/use analyses.`;
  }
  const sub = `${motions ? motions + ". " : ""}${merits}`;
  return `<div class="holding-strip">
    <div class="holding-head"><span class="holding-label">Holding</span>${badge}</div>
    ${prose ? `<p class="holding-line">${prose}</p>` : ""}
    ${sub.trim() ? `<p class="meta holding-motions">${sub}</p>` : ""}
  </div>`;
}

async function runCase(opinionId) {
  const box = document.getElementById("case-body");
  box.innerHTML = "<p class='meta'>Loading…</p>";
  const d = await api(`/api/case/${encodeURIComponent(opinionId)}`);
  const o = d.opinion;
  const authors = safeJsonArray(o.opinion_authors).join(", ");
  const judges = safeJsonArray(o.judges).join(", ");
  const postures = d.postures.map((p) => human(p.posture)).join(", ");
  const CLASS_LABELS = {
    workTypes: "Work types",
    useTypes: "Use types",
    technologyContexts: "Technology",
  };
  // One line per class_type, values grouped ("Work types — Photograph; visual art").
  const classGroups = {};
  for (const c of d.classifications) {
    (classGroups[c.class_type] ||= []).push(
      String(c.value ?? "").replace(/_/g, " ")
    );
  }
  const classifications = Object.entries(classGroups)
    .map(
      ([type, vals]) =>
        `<div><span>${esc(CLASS_LABELS[type] || type)}</span>${sentenceLabel(vals.join("; "))}</div>`
    )
    .join("");

  // Layered unit layout: a glanceable factor strip, factor accordions that
  // file each quote under the factor it grounds, and everything else behind
  // progressive disclosure. Dense at a glance, calm in detail.
  const quoteFig = (e) =>
    `<figure class="grounding-quote">
      <blockquote class="q-jump" role="link" tabindex="0" data-q="${esc(e.quote)}" data-p="${esc(e.page ?? "")}" aria-label="View this passage in the opinion">“${esc(e.quote)}”</blockquote>
      <figcaption>
        <span>${(() => {
          const vl = VOICE_BADGE_LABELS[e.voice] ? sentenceLabel(VOICE_BADGE_LABELS[e.voice]) : "";
          const sec = e.section ? sentenceLabel(String(e.section)) : "";
          const parts = [...new Set([vl, sec].filter(Boolean).map((s) => s.trim()))];
          const dedup = parts.filter((p, i) => !parts.some((q, j) => j < i && q.toLowerCase() === p.toLowerCase()));
          return dedup.length ? esc(dedup.join(" · ")) + " · " : "";
        })()}p. ${esc(e.page)}</span>
        <span class="quote-actions">
          <button type="button" class="quote-locate q-jump" data-q="${esc(e.quote)}" data-p="${esc(e.page ?? "")}">Open p. ${esc(e.page)}</button>
          ${copyButton({ q: e.quote, p: e.page, n: o.case_name, c: o.citation, a: o.court_abbrev || o.court, d: o.decision_date })}
        </span>
      </figcaption>
    </figure>`;

  const unitBlocks = d.units
    .map((u) => {
      const factors = d.factors.filter((f) => f.extraction_id === u.extraction_id);
      const evidence = d.evidence.filter((e) => e.extraction_id === u.extraction_id);
      const evForFactor = (n) =>
        evidence.filter((e) => (e.field_paths || "").includes(`factors[${n - 1}]`));
      const filed = new Set();
      const accId = (n) => `acc-${u.unit_id}-${n}`;

      // Glance layer: four cells, whole analysis visible in one row.
      const strip = [1, 2, 3, 4]
        .map((n) => {
          const f = factors.find((x) => x.factor_number === n);
          const dir = f?.direction || "not_analyzed";
          const mark = DIR_MARK[dir] ? `<span class="fs-mark">${DIR_MARK[dir]}</span> ` : "";
          return `<button type="button" class="fs-cell fs-${esc(dir)}" data-acc="${accId(n)}" title="${esc(FACTOR_NAMES[n])}">
            <span class="fs-num">${n} · ${FACTOR_SHORT[n]}</span>
            <span class="fs-dir">${mark}${DIR_SHORT[dir] || sentenceLabel(dir)}</span>
          </button>`;
        })
        .join("");

      const factorHtml = factors
        .map((f) => {
          const comps = d.components
            .filter((c) => c.factor_row_id === f.factor_row_id)
            .map(
              (c) =>
                `<li><strong>${componentLabel(c.component_code)}</strong>${c.polarity ? " (" + human(c.polarity) + ")" : ""}${c.note ? " — " + esc(c.note) : ""}</li>`
            )
            .join("");
          const analyzed = f.direction && f.direction !== "not_analyzed";
          const pivot = analyzed
            ? `<a class="pivot" href="#/browse?factor=${f.factor_number}&direction=${esc(f.direction)}">More cases where Factor ${f.factor_number} ${esc(DIRECTION_LABELS[f.direction] || f.direction)} →</a>`
            : "";
          const fEvs = evForFactor(f.factor_number);
          fEvs.forEach((e) => filed.add(e.evidence_id));
          const dirLabel = DIR_SHORT[f.direction] || sentenceLabel(f.direction);
          const chip = fEvs.length
            ? `<button type="button" class="factor-chip q-jump dir-${esc(f.direction)}" data-q="${esc(fEvs[0].quote)}" data-p="${esc(fEvs[0].page ?? "")}" title="Jump to this factor's discussion in the opinion">${dirLabel}</button>`
            : `<span class="factor-dir">${dirLabel}</span>`;
          const quotes = fEvs.map(quoteFig).join("");
          const title = `Factor ${f.factor_number}: ${esc(FACTOR_NAMES[f.factor_number] || f.canonical_name)}`;
          if (!analyzed && !f.summary && !comps && !quotes) {
            return `<div class="factor-row-empty" id="${accId(f.factor_number)}">
              <span>${title}</span><span class="factor-dir">${dirLabel}</span>
            </div>`;
          }
          return `<details class="factor-acc" id="${accId(f.factor_number)}">
            <summary><span class="fa-title">${title}</span>${chip}</summary>
            <div class="fa-body">
              ${f.summary ? `<p class="fa-summary">${esc(f.summary)}</p>` : ""}
              ${comps ? `<div class="fa-sec">Component findings</div><ul class="component-list">${comps}</ul>` : ""}
              ${quotes ? `<div class="fa-sec">Supporting passages</div><div class="fa-quotes">${quotes}</div>` : ""}
              ${pivot}
            </div>
          </details>`;
        })
        .join("");

      const unitNo =
        u.unit_number ?? (u.unit_id.match(/-(\d+)$/)?.[1] ?? "1").replace(/^0+/, "");
      const unitLabel =
        u.copyrighted_work_label || u.challenged_use_label
          ? `${metadataLabel(u.copyrighted_work_label)} → ${metadataLabel(u.challenged_use_label)}`
          : `Work/use unit ${esc(unitNo)}`;
      // Outcome badge jumps to the quote grounding the holding, when tagged.
      const hEv = evidence.find((e) => (e.field_paths || "").includes("holding"));
      if (hEv) filed.add(hEv.evidence_id);
      const outcomeHtml = hEv
        ? `<span class="q-jump outcome-jump" role="link" tabindex="0" aria-label="View the holding in the opinion" data-q="${esc(hEv.quote)}" data-p="${esc(hEv.page ?? "")}" title="Jump to the holding discussion in the opinion">${outcomeBadge(u.outcome)}</span>`
        : outcomeBadge(u.outcome);
      const rest = evidence.filter((e) => !filed.has(e.evidence_id));
      const restHtml = rest.length
        ? `<details class="factor-acc extra-ev">
            <summary><span class="fa-title">Additional evidence</span><span class="factor-dir">${rest.length} quote${rest.length === 1 ? "" : "s"}</span></summary>
            <div class="fa-body">${rest.map(quoteFig).join("")}</div>
          </details>`
        : "";
      return `
      <div class="card unit-card">
        <div class="unit-heading">
          <div>
            <div class="unit-kicker">${d.units.length > 1 ? `Unit ${esc(unitNo)} of ${d.units.length}` : "Work/use analysis"}</div>
            <h3>${unitLabel}${u.provisional ? '<span class="badge provisional">provisional</span>' : ""}</h3>
          </div>
          ${outcomeHtml}
        </div>
        ${u.scope_note ? `<p class="meta">${esc(u.scope_note)}</p>` : ""}
        <div class="factor-strip">${strip}</div>
        ${factorHtml ? `<div class="fa-section-label">Factor analysis</div>` : ""}
        ${factorHtml}
        ${restHtml}
      </div>`;
    })
    .join("");

  const crumbTail = lastSearch
    ? `<a href="#/search">Back to ${lastSearch.total} matching quotes</a>`
    : `<span>Case analysis</span>`;
  box.innerHTML = `
    <p class="case-breadcrumb"><a href="#/search">Cases</a>
      <span aria-hidden="true">/</span> ${crumbTail}</p>
    <h2>${esc(o.case_name)}</h2>
    <p class="meta case-meta-row"><span>${esc(o.citation || "")} · ${esc(o.court || "")} · ${esc(o.decision_date || "")}
      ${o.publication_status ? " · " + esc(o.publication_status) : ""}</span>
      <button type="button" class="pin-btn pin-text case-save" data-pinid="${esc(opinionId)}|">${PIN_SVG}<span class="pin-label">Save to My Cases</span></button></p>
    ${holdingStripHtml(d)}
    <details class="case-details">
      <summary><span class="cd-label">Case details</span><span class="cd-preview">${[authors ? esc(authors) : "", d.postures.length ? sentenceLabel(String(d.postures[0].posture ?? "").replace(/_/g, " ")) : ""].filter(Boolean).join(" · ")}</span></summary>
      <table class="stats case-metadata">
        ${authors ? `<tr><th>Opinion by</th><td>${esc(authors)}</td></tr>` : ""}
        ${judges ? `<tr><th>Panel</th><td>${esc(judges)}</td></tr>` : ""}
        ${postures ? `<tr><th>Posture</th><td>${sentenceLabel(d.postures.map((p) => String(p.posture ?? "").replace(/_/g, " ")).join(", "))}</td></tr>` : ""}
        ${o.standard_of_review ? `<tr><th>Standard of review</th><td>${safeJsonArray(o.standard_of_review).map(metadataLabel).join(", ")}</td></tr>` : ""}
        ${o.jury_involved ? `<tr><th>Jury</th><td>${metadataLabel(o.jury_involved)}</td></tr>` : ""}
        ${o.fair_use_resolved_at_stage ? `<tr><th>Fair use resolved at this stage</th><td>${metadataLabel(o.fair_use_resolved_at_stage)}</td></tr>` : ""}
        ${classifications ? `<tr><th>Classifications</th><td><div class="classification-list">${classifications}</div></td></tr>` : ""}
      </table>
    </details>
    ${unitBlocks || "<p>No coded work/use units for this opinion.</p>"}`;
  initPdfViewer(opinionId).catch(() => {});
}

function safeJsonArray(v) {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [String(v)];
  }
}

/* ---------- opinion PDF viewer (concept 04 split pane) ----------
   Custom pdf.js viewer: lazy page render into #pdf-scroll, invisible text
   layer for selection, and quote-jump: clicking a quote or factor chip in
   the analysis column locates the passage in the PDF text and highlights
   it. Matching is alphanumeric-only (case, punctuation, and star-pagination
   pins like [*534] all stripped) so cleaned-JSON quotes match rendered
   PDF text despite typographic differences. */

const STAR_PIN_RE = /\[?\*+\d+[A-Za-z]?\]?/g;

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("/vendor/pdfjs/pdf.min.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return lib;
    });
  }
  return pdfjsLibPromise;
}

let pdfView = null;

function destroyPdfViewer() {
  if (!pdfView) return;
  try {
    pdfView.doc?.destroy();
  } catch {}
  pdfView.observer?.disconnect();
  pdfView = null;
  const pane = document.getElementById("case-pdf-pane");
  if (pane) pane.classList.add("hidden");
}

function setPdfStatus(msg) {
  const el = document.getElementById("pdf-status");
  if (el) el.textContent = msg || "";
}

function updatePdfPageInfo() {
  if (!pdfView) return;
  const el = document.getElementById("pdf-pageinfo");
  if (el) el.textContent = `${pdfView.current} / ${pdfView.doc.numPages}`;
  const prev = document.getElementById("pdf-prev");
  const next = document.getElementById("pdf-next");
  if (prev) prev.disabled = pdfView.current <= 1;
  if (next) next.disabled = pdfView.current >= pdfView.doc.numPages;
}

function updatePdfZoomLevel() {
  const el = document.getElementById("pdf-zoom-level");
  if (el && pdfView) el.textContent = `${Math.round(pdfView.scale * 100)}%`;
}

// Alphanumeric-only lowercase; star pins removed first so their digits
// cannot pollute the match stream.
function normForSearch(s) {
  return String(s || "")
    .replace(STAR_PIN_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function initPdfViewer(opinionId) {
  destroyPdfViewer();
  const pane = document.getElementById("case-pdf-pane");
  const scroll = document.getElementById("pdf-scroll");
  if (!pane || !scroll) return;
  pane.classList.remove("hidden");
  scroll.innerHTML = "<p class='meta pdf-msg'>Loading opinion…</p>";
  setPdfStatus("");
  const dl = document.getElementById("pdf-download");
  if (dl) dl.href = `/api/opinion-pdf/${opinionId}`;
  let lib, doc;
  try {
    lib = await loadPdfjs();
    doc = await lib.getDocument({ url: `/api/opinion-pdf/${opinionId}` }).promise;
  } catch {
    scroll.innerHTML =
      "<p class='meta pdf-msg'>The standardized PDF for this opinion is not available yet.</p>";
    return;
  }
  // A navigation may have replaced the viewer while the document loaded.
  if (!document.getElementById("view-case") ||
      document.getElementById("view-case").classList.contains("hidden")) {
    doc.destroy();
    return;
  }
  const page1 = await doc.getPage(1);
  const base = page1.getViewport({ scale: 1 });
  const view = (pdfView = {
    id: opinionId,
    lib,
    doc,
    base,
    scale: 1,
    pages: [],
    textCache: new Map(),
    current: 1,
    pendingHl: null,
    observer: null,
  });
  view.scale = Math.min(
    1.35,
    Math.max(0.75, (scroll.clientWidth - 32) / base.width)
  );
  buildPdfPlaceholders(view, scroll);
  updatePdfPageInfo();
  updatePdfZoomLevel();
}

function buildPdfPlaceholders(view, scroll) {
  scroll.innerHTML = "";
  view.observer?.disconnect();
  view.pages = [];
  const w = view.base.width * view.scale;
  const h = view.base.height * view.scale;
  for (let n = 1; n <= view.doc.numPages; n++) {
    const el = document.createElement("div");
    el.className = "pdf-page";
    el.dataset.page = n;
    el.style.width = w + "px";
    el.style.height = h + "px";
    scroll.appendChild(el);
    view.pages.push({ el, rendered: false, rendering: false, textDivs: null });
  }
  view.observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting)
          renderPdfPage(view, Number(en.target.dataset.page));
      }
    },
    { root: scroll, rootMargin: "600px 0px" }
  );
  view.pages.forEach((p) => view.observer.observe(p.el));
  scroll.onscroll = () => {
    if (!pdfView) return;
    const mid = scroll.scrollTop + scroll.clientHeight / 3;
    let cur = 1;
    for (const p of pdfView.pages) {
      if (p.el.offsetTop <= mid) cur = Number(p.el.dataset.page);
      else break;
    }
    if (cur !== pdfView.current) {
      pdfView.current = cur;
      updatePdfPageInfo();
    }
  };
}

async function renderPdfPage(view, n) {
  const p = view.pages[n - 1];
  if (!p || p.rendered || p.rendering || view !== pdfView) return;
  p.rendering = true;
  try {
    const page = await view.doc.getPage(n);
    const vp = page.getViewport({ scale: view.scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    if (view !== pdfView) return;
    const tl = document.createElement("div");
    tl.className = "textLayer";
    tl.style.setProperty("--scale-factor", vp.scale);
    const textLayer = new view.lib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: tl,
      viewport: vp,
    });
    await textLayer.render();
    if (view !== pdfView) return;
    p.el.replaceChildren(canvas, tl);
    p.textDivs = textLayer.textDivs;
    p.rendered = true;
    const hl = view.pendingHl;
    if (hl && (hl.page === n || hl.ranges?.some((r) => !r.applied && r.page === n)))
      applyPdfHighlight(view);
  } finally {
    p.rendering = false;
  }
}

// Per-page search text: normalized concatenation of text items plus each
// item's [start,end) range in that normalized stream, for span mapping.
async function pdfPageSearchText(view, n) {
  if (view.textCache.has(n)) return view.textCache.get(n);
  const page = await view.doc.getPage(n);
  const tc = await page.getTextContent();
  let norm = "";
  const spans = [];
  const raw = [];
  for (const it of tc.items) {
    const s = it.str || "";
    raw.push(s);
    const start = norm.length;
    norm += normForSearch(s);
    spans.push({ start, end: norm.length });
  }
  const entry = { norm, spans, raw };
  view.textCache.set(n, entry);
  return entry;
}

async function findQuoteInPdf(view, quote, starPage) {
  // Ellipses mark omitted text, so a quote is only contiguous between them.
  // Each segment is located in full — head and tail probes bound the span —
  // so the highlight covers the whole quoted passage, not just a probe hit.
  const segments = String(quote || "")
    .split(/\[\s*\.\s*\.\s*\.\s*\]|\.\s*\.\s*\.|…/)
    .map(normForSearch)
    .filter((s) => s.length >= 12);
  const ranges = [];
  const findOnPages = async (probe, from = 0) => {
    for (let n = 1; n <= view.doc.numPages; n++) {
      const t = await pdfPageSearchText(view, n);
      if (view !== pdfView) return null;
      const idx = t.norm.indexOf(probe);
      if (idx !== -1) return { page: n, idx, norm: t.norm };
    }
    return undefined; // undefined = not found; null = view torn down
  };
  for (const needle of segments) {
    if (needle.length <= 180) {
      const hit = await findOnPages(needle);
      if (hit === null) return null;
      if (hit) ranges.push({ page: hit.page, start: hit.idx, end: hit.idx + needle.length });
      continue;
    }
    const head = needle.slice(0, 140);
    const tail = needle.slice(-140);
    const hit = await findOnPages(head);
    if (hit === null) return null;
    if (hit) {
      const j = hit.norm.indexOf(tail, hit.idx);
      if (j !== -1) {
        ranges.push({ page: hit.page, start: hit.idx, end: j + tail.length });
      } else {
        // Passage runs onto the next page: mark to the end of this page,
        // then from the top of the next page through the tail.
        ranges.push({ page: hit.page, start: hit.idx, end: hit.norm.length });
        if (hit.page < view.doc.numPages) {
          const t2 = await pdfPageSearchText(view, hit.page + 1);
          if (view !== pdfView) return null;
          const j2 = t2.norm.indexOf(tail);
          if (j2 !== -1) ranges.push({ page: hit.page + 1, start: 0, end: j2 + tail.length });
        }
      }
      continue;
    }
    // Head not found (typographic noise): fall back to tail, then middle.
    const mid = needle.length >> 1;
    for (const probe of [tail, needle.slice(Math.max(0, mid - 70), mid + 70)]) {
      const alt = await findOnPages(probe);
      if (alt === null) return null;
      if (alt) {
        ranges.push({ page: alt.page, start: alt.idx, end: alt.idx + probe.length });
        break;
      }
    }
  }
  if (ranges.length) return { page: ranges[0].page, ranges };
  // Fallback: locate the star-pagination marker for the quote's source page.
  if (starPage) {
    const marker = `*${starPage}`;
    for (let n = 1; n <= view.doc.numPages; n++) {
      const t = await pdfPageSearchText(view, n);
      if (view !== pdfView) return null;
      const i = t.raw.findIndex((s) => s.includes(marker));
      if (i !== -1) return { page: n, itemIndex: i };
    }
  }
  return null;
}

function clearPdfHighlights() {
  document
    .querySelectorAll(".textLayer .quote-hit")
    .forEach((el) => el.classList.remove("quote-hit"));
}

function applyPdfHighlight(view) {
  const hit = view.pendingHl;
  if (!hit) return;
  let first = null;
  if (hit.itemIndex != null) {
    const p = view.pages[hit.page - 1];
    if (!p?.textDivs) return;
    first = p.textDivs[hit.itemIndex] || null;
    if (first) first.classList.add("quote-hit");
    view.pendingHl = null;
  } else {
    // Ranges may span several pages; apply what's rendered and keep the
    // rest pending so later page renders pick them up.
    let remaining = false;
    for (const r of hit.ranges) {
      if (r.applied) continue;
      const p = view.pages[r.page - 1];
      const t = view.textCache.get(r.page);
      if (!p?.textDivs || !t) {
        remaining = true;
        continue;
      }
      t.spans.forEach((sp, i) => {
        if (sp.end > r.start && sp.start < r.end && sp.end > sp.start) {
          const div = p.textDivs[i];
          if (div) {
            div.classList.add("quote-hit");
            if (r.page === hit.page) first ||= div;
          }
        }
      });
      r.applied = true;
    }
    if (!remaining) view.pendingHl = null;
  }
  if (first && !hit.scrolled) {
    hit.scrolled = true;
    first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function scrollToPdfPage(view, n) {
  const p = view.pages[n - 1];
  const scroll = document.getElementById("pdf-scroll");
  if (p && scroll) scroll.scrollTo({ top: p.el.offsetTop - 8 });
}

let jumpToken = 0;
async function jumpToQuoteInPdf(quote, starPage) {
  const view = pdfView;
  if (!view) return;
  const token = ++jumpToken;
  setPdfStatus("Locating passage…");
  let hit = null;
  try {
    hit = await findQuoteInPdf(view, quote, starPage);
  } catch {}
  if (view !== pdfView || token !== jumpToken) return;
  if (!hit) {
    setPdfStatus("Passage not located in this PDF");
    setTimeout(() => token === jumpToken && setPdfStatus(""), 4000);
    return;
  }
  setPdfStatus("");
  clearPdfHighlights();
  view.pendingHl = hit;
  scrollToPdfPage(view, hit.page);
  if (view.pages[hit.page - 1].rendered) applyPdfHighlight(view);
  else renderPdfPage(view, hit.page);
}

function rerenderPdfAtScale(scale) {
  const view = pdfView;
  const scroll = document.getElementById("pdf-scroll");
  if (!view || !scroll) return;
  const frac = scroll.scrollTop / Math.max(1, scroll.scrollHeight);
  view.scale = Math.min(2.5, Math.max(0.5, scale));
  buildPdfPlaceholders(view, scroll);
  scroll.scrollTop = frac * scroll.scrollHeight;
  updatePdfZoomLevel();
}

document.getElementById("pdf-prev")?.addEventListener("click", () => {
  if (pdfView) scrollToPdfPage(pdfView, Math.max(1, pdfView.current - 1));
});
document.getElementById("pdf-next")?.addEventListener("click", () => {
  if (pdfView)
    scrollToPdfPage(pdfView, Math.min(pdfView.doc.numPages, pdfView.current + 1));
});
document.getElementById("pdf-zoom-in")?.addEventListener("click", () => {
  if (pdfView) rerenderPdfAtScale(pdfView.scale * 1.2);
});
document.getElementById("pdf-zoom-out")?.addEventListener("click", () => {
  if (pdfView) rerenderPdfAtScale(pdfView.scale / 1.2);
});
document.getElementById("pdf-fit")?.addEventListener("click", () => {
  const scroll = document.getElementById("pdf-scroll");
  if (pdfView && scroll)
    rerenderPdfAtScale((scroll.clientWidth - 32) / pdfView.base.width);
});

// Factor-strip cells open their accordion (and scroll to it); if the cell's
// factor has a grounded quote the accordion's chip handles the PDF jump.
document.addEventListener("click", (e) => {
  const cell = e.target.closest(".fs-cell");
  if (!cell) return;
  const acc = document.getElementById(cell.dataset.acc);
  if (!acc) return;
  if (acc.tagName === "DETAILS") acc.open = true;
  acc.scrollIntoView({ block: "center", behavior: "smooth" });
  const chip = acc.querySelector?.(".factor-chip.q-jump");
  if (chip?.dataset.q) jumpToQuoteInPdf(chip.dataset.q, chip.dataset.p || null);
});

document.addEventListener("click", (e) => {
  const j = e.target.closest(".q-jump");
  if (!j) return;
  if (e.target.closest(".copy-cite, .pin-btn, a")) return;
  if (!j.dataset.q) return;
  // A chip inside a <summary> must jump, not toggle the accordion.
  if (j.closest("summary")) e.preventDefault();
  // Select the quote record itself even when the jump came from its
  // "View in opinion" button.
  const activeSource = j.matches(".quote-locate")
    ? j.closest(".grounding-quote")?.querySelector("blockquote.q-jump") || j
    : j;
  document
    .querySelectorAll(".q-jump.is-active")
    .forEach((el) => el.classList.remove("is-active"));
  activeSource.classList.add("is-active");
  jumpToQuoteInPdf(j.dataset.q, j.dataset.p || null);
  if (matchMedia("(max-width: 1320px)").matches) {
    document
      .getElementById("case-pdf-pane")
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
});

// Keyboard activation for focusable quote blocks (role="link").
document.addEventListener("keydown", (e) => {
  const target = e.target.closest?.(".q-jump[tabindex]");
  if (!target || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  target.click();
});

/* ---------- Ask Folsom: chat over the corpus ---------- */

// Conversation state for the current question thread. History sent to the
// server is plain text only; evidence manifests are turn-local.
// Each assistant message carries its own manifest (handle -> evidence entry),
// so a handle minted in one turn can never resolve a same-numbered handle in
// another, and reopening a saved chat renders each answer from what the server
// stored for that answer.
let askMsgs = [];        // {role:"user"|"assistant", content, cards?, manifest?}
let askBusy = false;
let askConvoId = null;   // server conversation id once the thread is saved
// Generation counter: bumped by every send, reset, and conversation load. An
// in-flight stream whose generation is stale stops touching shared state.
let askGen = 0;

const ASK_EXAMPLES = [
  "Which cases involve AI training on copyrighted works, and how did they come out?",
  "How often does factor 4 favor fair use when the use is commercial?",
  "Find quotes about parody needing to target the original work.",
  "Explain how Andy Warhol Foundation v. Goldsmith is coded.",
];

function askMdRender(text) {
  // Minimal safe markdown: escape everything, then tables, subheads, bold,
  // paragraphs, and both list flavors. No raw HTML from the model survives.
  const lines = esc(text).split("\n");
  let html = "", listTag = null, tableRows = null;
  const closeList = () => {
    if (listTag) { html += `</${listTag}>`; listTag = null; }
  };
  const openList = (tag) => {
    if (listTag !== tag) { closeList(); html += `<${tag}>`; listTag = tag; }
  };
  const flushTable = () => {
    if (!tableRows) return;
    if (tableRows.length) {
      const [head, ...body] = tableRows;
      html += `<div class="ask-table-wrap"><table class="ask-table"><thead><tr>${
        head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
      }</tbody></table></div>`;
    }
    tableRows = null;
  };
  for (const line of lines) {
    const t = line.trim();
    if (/^\|.*\|$/.test(t)) {
      closeList();
      if (/^\|[\s\-:|]+\|$/.test(t)) continue; // separator row
      tableRows = tableRows || [];
      tableRows.push(t.slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    // A markdown subhead, or a line that is nothing but a bold label, is a
    // heading rather than emphasis inside a paragraph.
    const mdHeading = line.match(/^\s*#{2,4}\s+(.+)$/);
    const boldHeading = line.match(/^\s*\*\*([^*]+)\*\*\s*$/);
    if (mdHeading || boldHeading) {
      closeList();
      html += `<h4>${(mdHeading ? mdHeading[1] : boldHeading[1]).trim()}</h4>`;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = bullet ? null : line.match(/^\s*\d+\.\s+(.*)/);
    if (bullet || numbered) {
      openList(bullet ? "ul" : "ol");
      html += `<li>${(bullet || numbered)[1]}</li>`;
    } else {
      closeList();
      if (line.trim()) html += `<p>${line}</p>`;
    }
  }
  flushTable();
  closeList();
  return html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Bluebook citation for exported charts: release attribution plus the
// last-visited date, so a pasted chart stays traceable to its snapshot.
function askChartCitation(ev) {
  const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June",
    "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const d = new Date();
  const visited = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  return `Thomas A. Reichert, The Fair Use Database, release ${ev.release || "v0.2.0"} ` +
    `(2026), https://thefairusedatabase.com (last visited ${visited}).`;
}

// Sentence case, not title case: the figure caption reads as a caption, and the
// PNG export carries the same words.
function askChartTitle(ev) {
  const label = (v) => String(v).replace(/_/g, " ");
  const s = `${label(ev.measure)} by ${label(ev.group_by)}${
    ev.compare_by ? `, split by ${label(ev.compare_by)}` : ""}${
    ev.factor_number ? `, factor ${ev.factor_number}` : ""}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Publication-style source note, shared by the on-screen figure and the PNG.
function askChartNoteText(ev) {
  const unit = String(ev.unit_of_analysis || "").trim();
  const unclass = Number(ev.group_unclassified ?? ev.missing_or_unknown ?? 0);
  let s = `${Number(ev.denominator).toLocaleString()}${unit ? ` ${unit}` : ""}`;
  if (unclass > 0) {
    const pct = ev.group_unclassified_percent && ev.group_unclassified_percent !== "N/A"
      ? ` (${ev.group_unclassified_percent})` : "";
    s += `; unclassified ${String(ev.group_by || "").replace(/_/g, " ")}: ${unclass.toLocaleString()}${pct}`;
  }
  if (!ev.mutually_exclusive) s += "; categories overlap, so shares can sum past 100%";
  if (ev.compare_by) {
    const cu = ev.compare_unclassified;
    if (cu && cu.count > 0) {
      s += `; unclassified ${String(ev.compare_by).replace(/_/g, " ")}: ${Number(cu.count).toLocaleString()}` +
        (cu.percent && cu.percent !== "N/A" ? ` (${cu.percent})` : "");
    }
    if (ev.compare_mutually_exclusive === false) {
      s += "; comparison categories overlap, so row percentages can sum past 100%";
    }
  }
  if (ev.truncated) s += "; list truncated to the 40 largest categories";
  return s + `; release ${ev.release}.`;
}

/* ---- Stat figures. The client, not the model, picks the form: the payload
   shape maps deterministically onto one of four Phase A presentations
   (single-result figure, categorical bars, incidence table, decade trend).
   All forms share the caption header, source note, citation line, and the
   same preformatted percent strings the model quotes, so no surface can
   disagree with another. ---- */

function askPctStr(count, denom) {
  if (!Number.isFinite(denom) || denom <= 0) return "N/A";
  if (count === 0) return "0.0%";
  const share = count / denom;
  if (share < 0.0005) return "<0.1%";
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}

// Older evidence (saved chats, stats-page synthetics) predates label/share/
// percent/group_unclassified; fill the gaps so every renderer sees one shape.
function askNormStatEv(ev) {
  const denom = Number(ev.denominator);
  const rows = (ev.rows || []).map((r) => ({
    ...r,
    label: r.label || String(r.value).replace(/_/g, " "),
    share: r.share ?? (denom > 0 ? r.count / denom : null),
    percent: r.percent || askPctStr(r.count, denom),
  }));
  const unclass = Number(ev.group_unclassified ?? ev.missing_or_unknown ?? 0);
  return {
    ...ev, rows, group_unclassified: unclass,
    group_unclassified_percent:
      ev.group_unclassified_percent || askPctStr(unclass, denom),
  };
}

function askStatForm(ev) {
  const denom = Number(ev.denominator);
  const R = ev.rows.length;
  if (!Number.isFinite(denom) || denom <= 0) return "none";
  if (R === 0) return ev.group_unclassified > 0 ? "single" : "none";
  if (typeof ev.compare_by === "string") {
    // Column cap is 5, not Sol's 4: outcome legitimately carries five coded
    // values and is the flagship comparison dimension.
    const C = (ev.columns || []).length;
    if (ev.group_by === "decade" && R >= 2 && C >= 2 && C <= 5 && !ev.compare_truncated) {
      return "ctrend";
    }
    const complete = !ev.truncated && !ev.compare_truncated;
    if (ev.group_by !== "decade" && ev.presentation === "counts" && complete &&
        R >= 2 && R <= 10 && C >= 2 && C <= 5) return "gbars";
    if (ev.group_by !== "decade" && ev.presentation !== "counts" && complete &&
        ev.compare_mutually_exclusive === true &&
        R >= 2 && R <= 15 && C >= 2 && C <= 5) return "cbars";
    return "twoway";
  }
  if (ev.truncated) return "table";
  if (R === 1) return "single";
  if (ev.group_by === "decade") return "trend";
  if (ev.mutually_exclusive && R >= 2 && R <= 15) return "bars";
  return "table";
}

function askRowTh(r) {
  return r.link
    ? `<a class="asb-rowlink" href="${esc(r.link)}" target="_blank" rel="noopener"
         title="Open these ${r.count} cases">${esc(r.label)}</a>`
    : esc(r.label);
}

function askFigSingleBody(ev) {
  const r = ev.rows[0] || {
    label: "unclassified", count: ev.group_unclassified,
    percent: ev.group_unclassified_percent,
  };
  const pct = r.percent && r.percent !== "N/A"
    ? ` · ${esc(r.percent)} of ${Number(ev.denominator).toLocaleString()}` : "";
  return `<div class="asf-single">
      <span class="asf-big">${Number(r.count).toLocaleString()}</span>
      <span class="asf-sub">${askRowTh(r)}${pct}</span>
    </div>`;
}

function askFigBarsBody(ev) {
  const max = Math.max(...ev.rows.map((r) => r.count), 1);
  return `<table class="ask-chart-table">${ev.rows.map((r) => `
    <tr><th scope="row">${askRowTh(r)}</th>
    <td class="asb-n">${Number(r.count).toLocaleString()}${r.percent !== "N/A"
      ? ` <span class="asb-pct">${esc(r.percent)}</span>` : ""}</td>
    <td class="asb-bar"><span class="asb-track" aria-hidden="true"><span class="asb-fill"
      style="width:${Math.round((r.count / max) * 100)}%"></span></span></td></tr>`).join("")}
  </table>`;
}

function askFigTableBody(ev) {
  return `<table class="ask-chart-table asf-inc">
    <tr class="asf-inc-head"><th>Category</th><th>Count</th><th>%</th><th></th></tr>
    ${ev.rows.map((r) => `<tr>
      <th scope="row">${askRowTh(r)}</th>
      <td class="asb-n">${Number(r.count).toLocaleString()}</td>
      <td class="asb-n">${esc(r.percent)}</td>
      <td class="asb-bar"><span class="asf-micro" aria-hidden="true"
        style="width:${Math.min(100, Math.round((r.share || 0) * 100))}%"></span></td>
    </tr>`).join("")}
  </table>`;
}

// Axis ticks at 1/2/5 x 10^k, at most 5 including zero; the top tick bounds
// the data so the line never clips.
function askNiceTicks(maxN) {
  if (!(maxN > 0)) return [0, 1];
  for (let k = 0; k < 12; k++) {
    for (const s of [1, 2, 5]) {
      const step = s * Math.pow(10, k);
      if (Math.ceil(maxN / step) <= 4) {
        const ticks = [];
        for (let v = 0; v <= Math.ceil(maxN / step) * step; v += step) ticks.push(v);
        return ticks;
      }
    }
  }
  return [0, maxN];
}

function askFigTrendBody(ev) {
  const rows = ev.rows;
  const W = 680, H = 280, mL = 52, mR = 16, mT = 18, mB = 34;
  const iw = W - mL - mR, ih = H - mT - mB;
  const ticks = askNiceTicks(Math.max(...rows.map((r) => r.count), 0));
  const yMax = ticks[ticks.length - 1];
  const x = (i) => mL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (n) => mT + ih - (n / yMax) * ih;
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.count).toFixed(1)}`).join(" ");
  const idxMax = rows.reduce((b, r, i) => (r.count > rows[b].count ? i : b), 0);
  let idxMin = -1;
  rows.forEach((r, i) => {
    if (r.count > 0 && (idxMin === -1 || r.count < rows[idxMin].count)) idxMin = i;
  });
  const labelIdx = new Set([0, rows.length - 1, idxMax]);
  if (idxMin >= 0) labelIdx.add(idxMin);
  const grid = ticks.map((t) =>
    `<line class="asf-grid" x1="${mL}" y1="${y(t).toFixed(1)}" x2="${W - mR}" y2="${y(t).toFixed(1)}"/>
     <text class="asf-ytick" x="${mL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t.toLocaleString()}</text>`).join("");
  const xTicks = rows.map((r, i) =>
    (i % 3 === 0 || i === rows.length - 1)
      ? `<text class="asf-xtick" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>` : "").join("");
  const marks = rows.map((r, i) => {
    const lbl = labelIdx.has(i)
      ? `<text class="asf-ptlbl" x="${x(i).toFixed(1)}" y="${(y(r.count) - 9).toFixed(1)}" text-anchor="middle">${Number(r.count).toLocaleString()}</text>` : "";
    return `<circle class="asf-pt" cx="${x(i).toFixed(1)}" cy="${y(r.count).toFixed(1)}" r="3.2"/>${lbl}`;
  }).join("");
  return `<svg class="asf-trend" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(askChartTitle(ev))}">
      ${grid}
      <polyline class="asf-line" points="${pts}"/>
      ${marks}
      ${xTicks}
    </svg>
    <details class="asf-data"><summary>Data table</summary>
      <table class="ask-chart-table asf-inc">
        <tr class="asf-inc-head"><th>Decade</th><th>Count</th><th>%</th></tr>
        ${rows.map((r) => `<tr><th scope="row">${askRowTh(r)}</th>
          <td class="asb-n">${Number(r.count).toLocaleString()}</td>
          <td class="asb-n">${esc(r.percent)}</td></tr>`).join("")}
      </table>
    </details>`;
}

/* ---- Comparison forms (Phase B). Series are distinguished by fill and
   line style, never color alone: oxblood solid, oxblood dashed/light,
   ink-gray solid, ink-gray dotted/hatched. ---- */

const ASK_SERIES = [
  { fill: "#7d2a33", dash: "", marker: "circle" },
  { fill: "#c08e93", dash: "7 4", marker: "square" },
  { fill: "#6b6558", dash: "", marker: "triangle" },
  { fill: "#b3ab99", dash: "2 4", marker: "diamond" },
  { fill: "#43403a", dash: "10 3 2 3", marker: "circle" },
];

function askCellA(cell, inner) {
  return cell.link
    ? `<a class="asb-rowlink" href="${esc(cell.link)}" target="_blank" rel="noopener">${inner}</a>`
    : inner;
}

// Shared two-way data table: row label, row n, then n + row % per comparison
// column, then the unclassified supplement when any row has one.
function askTwoWayTableBody(ev) {
  const cols = ev.columns || [];
  const anyUnclass = ev.rows.some((r) => r.compare_unclassified && r.compare_unclassified.count > 0);
  return `<div class="asf-scroll"><table class="ask-chart-table asf-inc asf-twoway">
    <tr class="asf-inc-head"><th>${esc(String(ev.group_by).replace(/_/g, " "))}</th><th>Row n</th>
      ${cols.map((c) => `<th colspan="2">${esc(c.label)}</th>`).join("")}
      ${anyUnclass ? "<th colspan=\"2\">Unclassified</th>" : ""}</tr>
    ${ev.rows.map((r) => `<tr>
      <th scope="row">${askRowTh(r)}</th>
      <td class="asb-n">${Number(r.count).toLocaleString()}</td>
      ${r.cells.map((c) => {
        const tint = c.share ? Math.min(0.25, c.share * 0.25) : 0;
        return `<td class="asb-n" style="background:rgba(125,42,51,${tint.toFixed(3)})">${
          askCellA(c, Number(c.count).toLocaleString())}</td>
        <td class="asb-n asf-rowpct">${esc(c.percent)}</td>`;
      }).join("")}
      ${anyUnclass ? `<td class="asb-n">${Number(r.compare_unclassified.count).toLocaleString()}</td>
        <td class="asb-n asf-rowpct">${esc(r.compare_unclassified.percent)}</td>` : ""}
    </tr>`).join("")}
  </table></div>`;
}

function askFigLegend(ev) {
  return `<div class="asf-legend">${(ev.columns || []).map((c, i) =>
    `<span class="asf-leg-item"><span class="asf-swatch asf-s${i}"></span>${esc(c.label)}</span>`).join("")}
  </div>`;
}

// 100% composition bars: every bar spans its full row denominator; the gray
// hatched tail is the row's unclassified share.
function askFigCompBody(ev) {
  const bars = ev.rows.map((r) => {
    const segs = r.cells.map((c, i) => {
      const w = (c.share || 0) * 100;
      const lbl = w >= 9 ? `<span class="asf-seg-lbl">${esc(c.percent)}</span>` : "";
      return `<span class="asf-seg asf-s${i}" style="width:${w.toFixed(2)}%" title="${esc(
        `${(ev.columns[i] || {}).label}: ${c.count} (${c.percent})`)}">${lbl}</span>`;
    }).join("");
    const cu = r.compare_unclassified;
    const cuw = cu && cu.share ? cu.share * 100 : 0;
    const cuSeg = cuw > 0
      ? `<span class="asf-seg asf-seg-unclass" style="width:${cuw.toFixed(2)}%" title="${esc(
          `Unclassified: ${cu.count} (${cu.percent})`)}">${cuw >= 9 ? `<span class="asf-seg-lbl">${esc(cu.percent)}</span>` : ""}</span>`
      : "";
    return `<div class="asf-comp-row">
      <span class="asf-comp-lbl">${askRowTh(r)} <span class="asf-rown">n=${Number(r.count).toLocaleString()}</span></span>
      <span class="asf-comp-track">${segs}${cuSeg}</span>
    </div>`;
  }).join("");
  return `${askFigLegend(ev)}<div class="asf-comp">${bars}</div>${askTwoWayTableBody(ev)}`;
}

// Grouped count bars: one cluster per primary category, shared count scale.
function askFigGroupedBody(ev) {
  const max = Math.max(...ev.rows.flatMap((r) => r.cells.map((c) => c.count)), 1);
  const rows = ev.rows.map((r) => `<div class="asf-grp-row">
      <span class="asf-comp-lbl">${askRowTh(r)} <span class="asf-rown">n=${Number(r.count).toLocaleString()}</span></span>
      <span class="asf-grp-bars">${r.cells.map((c, i) => `
        <span class="asf-grp-line"><span class="asf-grp-fill asf-s${i}"
          style="width:${Math.max(0.5, (c.count / max) * 100).toFixed(2)}%"></span>
          <span class="asf-grp-n">${Number(c.count).toLocaleString()}</span></span>`).join("")}
      </span>
    </div>`).join("");
  return `${askFigLegend(ev)}<div class="asf-grp">${rows}</div>${askTwoWayTableBody(ev)}`;
}

// Comparative decade trend: one line per comparison column. Default plots
// each cell's percentage of its row; presentation "counts" plots raw counts.
function askFigCTrendBody(ev) {
  const rows = ev.rows;
  const cols = ev.columns || [];
  const counts = ev.presentation === "counts";
  const val = (r, i) => counts
    ? r.cells[i].count
    : (r.cells[i].share === null ? null : r.cells[i].share * 100);
  const W = 680, H = 300, mL = 52, mR = 70, mT = 18, mB = 34;
  const iw = W - mL - mR, ih = H - mT - mB;
  let maxV = 0;
  rows.forEach((r) => cols.forEach((c, i) => {
    const v = val(r, i);
    if (v !== null && v > maxV) maxV = v;
  }));
  const ticks = askNiceTicks(maxV);
  const yMax = ticks[ticks.length - 1];
  const x = (i) => mL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => mT + ih - (v / yMax) * ih;
  const grid = ticks.map((t) =>
    `<line class="asf-grid" x1="${mL}" y1="${y(t).toFixed(1)}" x2="${W - mR}" y2="${y(t).toFixed(1)}"/>
     <text class="asf-ytick" x="${mL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t.toLocaleString()}${counts ? "" : "%"}</text>`).join("");
  const xTicks = rows.map((r, i) =>
    (i % 3 === 0 || i === rows.length - 1)
      ? `<text class="asf-xtick" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>` : "").join("");
  const mark = (sx, sy, kind, color) => {
    if (kind === "square") return `<rect x="${(sx - 3).toFixed(1)}" y="${(sy - 3).toFixed(1)}" width="6" height="6" fill="#faf7f2" stroke="${color}" stroke-width="1.5"/>`;
    if (kind === "triangle") return `<polygon points="${sx},${(sy - 4).toFixed(1)} ${(sx - 3.6).toFixed(1)},${(sy + 3).toFixed(1)} ${(sx + 3.6).toFixed(1)},${(sy + 3).toFixed(1)}" fill="#faf7f2" stroke="${color}" stroke-width="1.5"/>`;
    if (kind === "diamond") return `<polygon points="${sx},${(sy - 4).toFixed(1)} ${(sx + 4).toFixed(1)},${sy} ${sx},${(sy + 4).toFixed(1)} ${(sx - 4).toFixed(1)},${sy}" fill="#faf7f2" stroke="${color}" stroke-width="1.5"/>`;
    return `<circle cx="${sx}" cy="${sy}" r="3" fill="#faf7f2" stroke="${color}" stroke-width="1.5"/>`;
  };
  const series = cols.map((c, i) => {
    const st = ASK_SERIES[i] || ASK_SERIES[0];
    // Break the line at N/A decades (zero row denominator in percent mode).
    const runs = [];
    let run = [];
    rows.forEach((r, j) => {
      const v = val(r, i);
      if (v === null) { if (run.length) runs.push(run); run = []; }
      else run.push([x(j), y(v)]);
    });
    if (run.length) runs.push(run);
    const lines = runs.map((pts) =>
      `<polyline fill="none" stroke="${st.fill}" stroke-width="2"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}
        points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}"/>`).join("");
    const marks = rows.map((r, j) => {
      const v = val(r, i);
      return v === null ? "" : mark(x(j), y(v), st.marker, st.fill);
    }).join("");
    // Direct label at the final plotted point.
    let lastIdx = -1;
    rows.forEach((r, j) => { if (val(r, i) !== null) lastIdx = j; });
    const endLbl = lastIdx >= 0
      ? `<text class="asf-endlbl" x="${(x(lastIdx) + 8).toFixed(1)}" y="${(y(val(rows[lastIdx], i) ?? 0) + 4).toFixed(1)}" fill="${st.fill}">${esc(c.label)}</text>` : "";
    return lines + marks + endLbl;
  }).join("");
  return `<svg class="asf-trend" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(askChartTitle(ev))}">
      ${grid}${series}${xTicks}
    </svg>${askFigLegend(ev)}
    <details class="asf-data"><summary>Data table</summary>${askTwoWayTableBody(ev)}</details>`;
}

// Dispatcher. `force` pins a form (the Statistics page pins "bars" for its
// hand-built funnel/outcome evidence, which bypasses the selector).
function askStatChart(ev, mi, key, force) {
  if (!ev || ev.type !== "stat" || !Array.isArray(ev.rows)) return "";
  const norm = askNormStatEv(ev);
  const form = force || askStatForm(norm);
  if (form === "none") return "";
  const body =
    form === "single" ? askFigSingleBody(norm) :
    form === "trend" ? askFigTrendBody(norm) :
    form === "table" ? askFigTableBody(norm) :
    form === "ctrend" ? askFigCTrendBody(norm) :
    form === "cbars" ? askFigCompBody(norm) :
    form === "gbars" ? askFigGroupedBody(norm) :
    form === "twoway" ? askTwoWayTableBody(norm) :
    askFigBarsBody(norm);
  return `<figure class="ask-chart asf-${form}-fig">
    <figcaption class="ask-chart-head">
      <span class="ask-chart-title">${esc(askChartTitle(norm))}</span>
      <button type="button" class="ask-chart-copy" data-mi="${mi}" data-h="${esc(key)}"
        title="Copy a high-resolution image of this chart">Copy chart</button>
    </figcaption>
    ${body}
    <div class="ask-chart-note">${esc(askChartNoteText(norm))}</div>
    <div class="ask-chart-cite">${esc(askChartCitation(norm))}</div>
  </figure>`;
}

/* ---- PNG export. Drawn from the normalized model, never a DOM screenshot,
   at 3x scale on the parchment background with the same title, note, and
   Bluebook line as the on-screen figure. Each form has its own body
   painter; header and footer are shared. ---- */

function pngBodyBars(c, ev, top, W) {
  const rows = ev.rows;
  const rowH = 30;
  const max = Math.max(...rows.map((r) => r.count), 1);
  const labelW = 170, barX = 24 + labelW + 96;
  const barW = W - barX - 32;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    c.fillStyle = "#1d1d1b";
    c.font = "13px Georgia, serif";
    c.fillText(String(r.label).slice(0, 26), 24, y + 15);
    c.font = "bold 13px Georgia, serif";
    c.fillText(Number(r.count).toLocaleString(), 24 + labelW, y + 15);
    if (r.percent !== "N/A") {
      c.fillStyle = "#8a8371";
      c.font = "12px Georgia, serif";
      c.fillText(r.percent, 24 + labelW + 46, y + 15);
    }
    c.fillStyle = "#7d2a33";
    c.fillRect(barX, y + 4, Math.max(2, (r.count / max) * barW), 14);
  });
  return rows.length * rowH;
}

function pngBodySingle(c, ev, top, W) {
  const r = ev.rows[0] || {
    label: "unclassified", count: ev.group_unclassified,
    percent: ev.group_unclassified_percent,
  };
  c.fillStyle = "#7d2a33";
  c.font = "bold 44px Georgia, serif";
  c.fillText(Number(r.count).toLocaleString(), 24, top + 44);
  c.fillStyle = "#1d1d1b";
  c.font = "14px Georgia, serif";
  const pct = r.percent && r.percent !== "N/A"
    ? ` · ${r.percent} of ${Number(ev.denominator).toLocaleString()}` : "";
  c.fillText(`${r.label}${pct}`, 24, top + 68);
  return 84;
}

function pngBodyTable(c, ev, top, W) {
  const rows = ev.rows;
  const rowH = 24;
  const labelW = 250, countX = 24 + labelW, pctX = countX + 70, microX = pctX + 70;
  const microW = W - microX - 32;
  c.fillStyle = "#8a8371";
  c.font = "bold 11px Georgia, serif";
  c.fillText("CATEGORY", 24, top + 12);
  c.fillText("COUNT", countX, top + 12);
  c.fillText("%", pctX, top + 12);
  rows.forEach((r, i) => {
    const y = top + 20 + i * rowH;
    c.fillStyle = "#1d1d1b";
    c.font = "12px Georgia, serif";
    c.fillText(String(r.label).slice(0, 40), 24, y + 14);
    c.font = "bold 12px Georgia, serif";
    c.fillText(Number(r.count).toLocaleString(), countX, y + 14);
    c.fillStyle = "#8a8371";
    c.font = "12px Georgia, serif";
    c.fillText(r.percent, pctX, y + 14);
    c.fillStyle = "#7d2a33";
    c.fillRect(microX, y + 6, Math.max(1, Math.min(1, r.share || 0) * microW), 6);
  });
  return 20 + rows.length * rowH + 6;
}

function pngBodyTrend(c, ev, top, W) {
  const rows = ev.rows;
  const ch = 240, mL = 60, mR = 32, mT = 14, mB = 30;
  const iw = W - mL - mR, ih = ch - mT - mB;
  const ticks = askNiceTicks(Math.max(...rows.map((r) => r.count), 0));
  const yMax = ticks[ticks.length - 1];
  const x = (i) => mL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (n) => top + mT + ih - (n / yMax) * ih;
  c.strokeStyle = "#e2dbcd";
  c.lineWidth = 1;
  c.fillStyle = "#8a8371";
  c.font = "11px Georgia, serif";
  c.textAlign = "right";
  for (const t of ticks) {
    c.beginPath();
    c.moveTo(mL, y(t));
    c.lineTo(W - mR, y(t));
    c.stroke();
    c.fillText(t.toLocaleString(), mL - 8, y(t) + 4);
  }
  c.textAlign = "center";
  rows.forEach((r, i) => {
    if (i % 3 === 0 || i === rows.length - 1) c.fillText(r.label, x(i), top + ch - 8);
  });
  c.strokeStyle = "#7d2a33";
  c.lineWidth = 2;
  c.beginPath();
  rows.forEach((r, i) => (i ? c.lineTo(x(i), y(r.count)) : c.moveTo(x(i), y(r.count))));
  c.stroke();
  const idxMax = rows.reduce((b, r, i) => (r.count > rows[b].count ? i : b), 0);
  let idxMin = -1;
  rows.forEach((r, i) => {
    if (r.count > 0 && (idxMin === -1 || r.count < rows[idxMin].count)) idxMin = i;
  });
  const labelIdx = new Set([0, rows.length - 1, idxMax]);
  if (idxMin >= 0) labelIdx.add(idxMin);
  rows.forEach((r, i) => {
    c.beginPath();
    c.arc(x(i), y(r.count), 3.2, 0, Math.PI * 2);
    c.fillStyle = "#faf7f2";
    c.fill();
    c.strokeStyle = "#7d2a33";
    c.lineWidth = 1.6;
    c.stroke();
    if (labelIdx.has(i)) {
      c.fillStyle = "#1d1d1b";
      c.font = "bold 11px Georgia, serif";
      c.fillText(Number(r.count).toLocaleString(), x(i), y(r.count) - 8);
    }
  });
  c.textAlign = "left";
  return ch;
}

function pngLegend(c, ev, top, W) {
  let lx = 24;
  (ev.columns || []).forEach((col, i) => {
    const st = ASK_SERIES[i] || ASK_SERIES[0];
    c.fillStyle = st.fill;
    c.fillRect(lx, top + 4, 12, 12);
    c.fillStyle = "#1d1d1b";
    c.font = "12px Georgia, serif";
    c.fillText(col.label, lx + 17, top + 14);
    lx += 27 + c.measureText(col.label).width + 14;
  });
  return 24;
}

function pngBodyComp(c, ev, top, W) {
  const legH = pngLegend(c, ev, top, W);
  const rowH = 32, labelW = 190;
  const barX = 24 + labelW, barW = W - barX - 32;
  ev.rows.forEach((r, i) => {
    const y = top + legH + i * rowH;
    c.fillStyle = "#1d1d1b";
    c.font = "12px Georgia, serif";
    c.fillText(`${String(r.label).slice(0, 22)}  n=${Number(r.count).toLocaleString()}`, 24, y + 15);
    let sx = barX;
    r.cells.forEach((cell, k) => {
      const w = (cell.share || 0) * barW;
      c.fillStyle = (ASK_SERIES[k] || ASK_SERIES[0]).fill;
      c.fillRect(sx, y + 4, w, 16);
      if ((cell.share || 0) >= 0.09) {
        c.fillStyle = k === 0 || k === 2 ? "#faf7f2" : "#1d1d1b";
        c.font = "10px Georgia, serif";
        c.fillText(cell.percent, sx + 4, y + 15.5);
      }
      sx += w;
    });
    const cu = r.compare_unclassified;
    if (cu && cu.share > 0) {
      const w = cu.share * barW;
      c.fillStyle = "#d9d1c1";
      c.fillRect(sx, y + 4, w, 16);
      c.strokeStyle = "#8a8371";
      c.lineWidth = 1;
      for (let hx = sx; hx < sx + w; hx += 5) {
        c.beginPath();
        c.moveTo(hx, y + 20);
        c.lineTo(Math.min(hx + 6, sx + w), y + 4);
        c.stroke();
      }
    }
  });
  return legH + ev.rows.length * rowH;
}

function pngBodyGrouped(c, ev, top, W) {
  const legH = pngLegend(c, ev, top, W);
  const nC = (ev.columns || []).length;
  const rowH = nC * 15 + 14, labelW = 190;
  const barX = 24 + labelW, barW = W - barX - 90;
  const max = Math.max(...ev.rows.flatMap((r) => r.cells.map((x) => x.count)), 1);
  ev.rows.forEach((r, i) => {
    const y = top + legH + i * rowH;
    c.fillStyle = "#1d1d1b";
    c.font = "12px Georgia, serif";
    c.fillText(`${String(r.label).slice(0, 22)}  n=${Number(r.count).toLocaleString()}`, 24, y + 14);
    r.cells.forEach((cell, k) => {
      const by = y + 4 + k * 15;
      c.fillStyle = (ASK_SERIES[k] || ASK_SERIES[0]).fill;
      c.fillRect(barX, by, Math.max(1, (cell.count / max) * barW), 11);
      c.fillStyle = "#1d1d1b";
      c.font = "11px Georgia, serif";
      c.fillText(Number(cell.count).toLocaleString(),
        barX + Math.max(1, (cell.count / max) * barW) + 6, by + 9.5);
    });
  });
  return legH + ev.rows.length * rowH;
}

function pngBodyTwoWay(c, ev, top, W) {
  const cols = ev.columns || [];
  const anyUnclass = ev.rows.some((r) => r.compare_unclassified && r.compare_unclassified.count > 0);
  const nGroups = cols.length + (anyUnclass ? 1 : 0);
  const labelW = 165, rowNW = 52;
  const groupW = (W - 24 - labelW - rowNW - 24) / nGroups;
  const rowH = 22;
  c.font = "bold 10px Georgia, serif";
  c.fillStyle = "#8a8371";
  c.fillText(String(ev.group_by || "").replace(/_/g, " ").toUpperCase(), 24, top + 12);
  c.fillText("ROW N", 24 + labelW, top + 12);
  cols.forEach((col, k) => {
    c.fillText(String(col.label).slice(0, 18).toUpperCase(), 24 + labelW + rowNW + k * groupW, top + 12);
  });
  if (anyUnclass) c.fillText("UNCLASSIFIED", 24 + labelW + rowNW + cols.length * groupW, top + 12);
  ev.rows.forEach((r, i) => {
    const y = top + 20 + i * rowH;
    c.fillStyle = "#1d1d1b";
    c.font = "11px Georgia, serif";
    c.fillText(String(r.label).slice(0, 24), 24, y + 13);
    c.font = "bold 11px Georgia, serif";
    c.fillText(Number(r.count).toLocaleString(), 24 + labelW, y + 13);
    r.cells.forEach((cell, k) => {
      const gx = 24 + labelW + rowNW + k * groupW;
      c.fillStyle = "#1d1d1b";
      c.font = "11px Georgia, serif";
      c.fillText(Number(cell.count).toLocaleString(), gx, y + 13);
      c.fillStyle = "#8a8371";
      c.fillText(cell.percent, gx + groupW * 0.45, y + 13);
    });
    if (anyUnclass) {
      const gx = 24 + labelW + rowNW + cols.length * groupW;
      const cu = r.compare_unclassified || { count: 0, percent: "0.0%" };
      c.fillStyle = "#1d1d1b";
      c.font = "11px Georgia, serif";
      c.fillText(Number(cu.count).toLocaleString(), gx, y + 13);
      c.fillStyle = "#8a8371";
      c.fillText(cu.percent, gx + groupW * 0.45, y + 13);
    }
  });
  return 20 + ev.rows.length * rowH + 6;
}

function pngBodyCTrend(c, ev, top, W) {
  const rows = ev.rows;
  const cols = ev.columns || [];
  const counts = ev.presentation === "counts";
  const val = (r, i) => counts
    ? r.cells[i].count
    : (r.cells[i].share === null ? null : r.cells[i].share * 100);
  const ch = 250, mL = 60, mR = 100, mT = 14, mB = 30;
  const iw = W - mL - mR, ih = ch - mT - mB;
  let maxV = 0;
  rows.forEach((r) => cols.forEach((_, i) => {
    const v = val(r, i);
    if (v !== null && v > maxV) maxV = v;
  }));
  const ticks = askNiceTicks(maxV);
  const yMax = ticks[ticks.length - 1];
  const x = (i) => mL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => top + mT + ih - (v / yMax) * ih;
  c.strokeStyle = "#e2dbcd";
  c.lineWidth = 1;
  c.fillStyle = "#8a8371";
  c.font = "11px Georgia, serif";
  c.textAlign = "right";
  for (const t of ticks) {
    c.beginPath(); c.moveTo(mL, y(t)); c.lineTo(W - mR, y(t)); c.stroke();
    c.fillText(`${t.toLocaleString()}${counts ? "" : "%"}`, mL - 8, y(t) + 4);
  }
  c.textAlign = "center";
  rows.forEach((r, i) => {
    if (i % 3 === 0 || i === rows.length - 1) c.fillText(r.label, x(i), top + ch - 8);
  });
  c.textAlign = "left";
  cols.forEach((col, si) => {
    const st = ASK_SERIES[si] || ASK_SERIES[0];
    c.strokeStyle = st.fill;
    c.lineWidth = 2;
    c.setLineDash(st.dash ? st.dash.split(" ").map(Number) : []);
    c.beginPath();
    let pen = false;
    rows.forEach((r, j) => {
      const v = val(r, si);
      if (v === null) { pen = false; return; }
      if (pen) c.lineTo(x(j), y(v)); else c.moveTo(x(j), y(v));
      pen = true;
    });
    c.stroke();
    c.setLineDash([]);
    rows.forEach((r, j) => {
      const v = val(r, si);
      if (v === null) return;
      c.beginPath();
      c.arc(x(j), y(v), 3, 0, Math.PI * 2);
      c.fillStyle = "#faf7f2";
      c.fill();
      c.strokeStyle = st.fill;
      c.lineWidth = 1.5;
      c.stroke();
    });
    let lastIdx = -1;
    rows.forEach((r, j) => { if (val(r, si) !== null) lastIdx = j; });
    if (lastIdx >= 0) {
      c.fillStyle = st.fill;
      c.font = "11px Georgia, serif";
      c.fillText(String(col.label).slice(0, 14), x(lastIdx) + 8, y(val(rows[lastIdx], si)) + 4);
    }
  });
  return ch;
}

// Render a stat figure to a high-resolution PNG (3x scale) carrying its
// title, body, denominator note, and Bluebook citation, and copy it to the
// clipboard.
function askChartCopyPng(rawEv, btn, force) {
  const ev = askNormStatEv(rawEv);
  const form = force || askStatForm(ev);
  if (form === "none") return;
  const S = 3;
  const W = 760;
  const top = 56, noteGap = 18;
  const bodyH =
    form === "single" ? 84 :
    form === "trend" ? 240 :
    form === "table" ? 20 + ev.rows.length * 24 + 6 :
    form === "ctrend" ? 250 :
    form === "cbars" ? 24 + ev.rows.length * 32 :
    form === "gbars" ? 24 + ev.rows.length * ((ev.columns || []).length * 15 + 14) :
    form === "twoway" ? 20 + ev.rows.length * 22 + 6 :
    ev.rows.length * 30;
  const citeLines = wrapText(askChartCitation(ev), 96);
  const noteLines = wrapText(askChartNoteText(ev), 96);
  const H = top + bodyH + noteGap + (noteLines.length + citeLines.length) * 17 + 24;
  const canvas = document.createElement("canvas");
  canvas.width = W * S;
  canvas.height = H * S;
  const c = canvas.getContext("2d");
  c.scale(S, S);
  c.fillStyle = "#faf7f2";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#1d1d1b";
  c.font = "bold 16px Georgia, serif";
  c.fillText(askChartTitle(ev), 24, 32);
  const painter =
    form === "single" ? pngBodySingle :
    form === "trend" ? pngBodyTrend :
    form === "table" ? pngBodyTable :
    form === "ctrend" ? pngBodyCTrend :
    form === "cbars" ? pngBodyComp :
    form === "gbars" ? pngBodyGrouped :
    form === "twoway" ? pngBodyTwoWay :
    pngBodyBars;
  painter(c, ev, top, W);
  let y = top + bodyH + noteGap;
  c.fillStyle = "#8a8371";
  c.font = "11px Georgia, serif";
  for (const line of noteLines) { c.fillText(line, 24, y); y += 17; }
  c.fillStyle = "#555";
  c.font = "italic 11px Georgia, serif";
  for (const line of citeLines) { c.fillText(line, 24, y); y += 17; }
  const blob = new Promise((res) => canvas.toBlob(res, "image/png"));
  navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => {
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = old; }, 1600);
  }).catch(() => {
    btn.textContent = "Copy failed";
    setTimeout(() => { btn.textContent = "Copy chart"; }, 1600);
  });
}

function wrapText(text, width) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// Replace [CASE:..]/[QUOTE:..]/[CODE:..]/[STAT:..] tokens with citation chips.
// Only handles present in the server-issued manifest render; anything else is
// silently removed (the model may not mint its own citations).
function askResolveTokens(html, manifest) {
  return html.replace(/\[?\[(CASE|QUOTE|CODE|STAT):([A-Za-z0-9_-]+)\]\]?/g, (_, kind, id) => {
    const ev = manifest[`${kind}:${id}`];
    if (!ev) return "";
    if (ev.type === "case") {
      const year = (ev.date || "").slice(0, 4);
      return ` <a class="ask-chip chip-case" target="_blank" rel="noopener" href="#/case/${esc(ev.opinion_id)}"
        title="${esc(ev.citation || "")}">${esc(shortCaseName(ev.case_name))}${year ? ` (${year})` : ""}</a>`;
    }
    if (ev.type === "quote") {
      return ` <a class="ask-chip chip-quote" target="_blank" rel="noopener" href="#/case/${esc(ev.opinion_id)}"
        title="${esc(String(ev.quote || "").slice(0, 220))}">quote${ev.page ? `, p. ${esc(String(ev.page))}` : ""}</a>`;
    }
    if (ev.type === "code") {
      return ` <a class="ask-chip chip-code" target="_blank" rel="noopener" href="#/case/${esc(ev.opinion_id)}"
        title="${esc(ev.summary || "")}">F${esc(String(ev.factor_number))} coding</a>`;
    }
    if (ev.type === "stat") {
      const method = `${ev.measure} by ${ev.group_by} · denominator ${ev.denominator} ${ev.unit_of_analysis} · unclassified ${ev.group_unclassified ?? ev.missing_or_unknown ?? 0} · release ${ev.release}`;
      return ` <a class="ask-chip chip-stat" target="_blank" rel="noopener" href="${esc(ev.link || "#/stats")}"
        title="${esc(method)}">methodology</a>`;
    }
    return "";
  });
}

function shortCaseName(name) {
  return String(name || "").length > 60
    ? String(name).slice(0, 57) + "…" : String(name || "");
}

// Query provenance. The server mints one card per tool call, shaped
// {kind, query, filters, release, total, returned, truncated, sort, link}.
const ASK_CARD_KINDS = {
  stats: "Corpus statistics",
  quote_search: "Quotation search",
  case_search: "Case search",
  case_detail: "Case record",
};

function askQueryCard(card) {
  const kind = ASK_CARD_KINDS[card.kind]
    || String(card.kind || "corpus query").replace(/_/g, " ");
  const filters = Object.entries(card.filters || {})
    .map(([k, v]) => `${esc(k)}: ${esc(String(v))}`)
    .join("; ");
  const total = Number(card.total || 0);
  const resultCount = `${total.toLocaleString()} match${total === 1 ? "" : "es"}`
    + (card.truncated ? `; ${Number(card.returned || 0).toLocaleString()} shown` : "");
  return `<div class="ask-card" role="note" aria-label="Corpus query used">
    <div class="qc-main">
      <span class="qc-kind">${esc(kind)}</span>
      ${card.query ? `<span class="qc-q">“${esc(String(card.query).slice(0, 80))}”</span>` : ""}
      ${filters ? `<span class="qc-filter">${filters}</span>` : ""}
    </div>
    <div class="qc-meta">${esc(resultCount)}${card.release ? ` · ${esc(card.release)}` : ""}</div>
    ${card.link ? `<a class="qc-open" href="${esc(card.link)}"
      target="_blank" rel="noopener">${
        card.kind === "stats" && !Object.keys(card.filters || {}).length
          ? "Browse all counted cases ↗" : "Open result set ↗"}</a>` : ""}
  </div>`;
}

// Release/coverage for the Ask copy, read off the release badge that
// /api/stats already fills in. Falls back to the build-time values.
function askRelease() {
  const badge = document.getElementById("release-badge");
  const m = String(badge ? badge.textContent : "")
    .trim().match(/^(\S+)\s*·\s*Through\s+(.+)$/i);
  return m ? { release: m[1], coverage: m[2] }
           : { release: "v0.2.0", coverage: "July 8, 2026" };
}

// Scroll policy: a new question anchors its own message to the top of the
// viewport, a reopened conversation starts at the beginning, and every
// streaming re-render leaves the reader where they were.
function renderAsk({ anchorIndex = null, resetToTop = false } = {}) {
  const box = document.getElementById("ask-messages");
  const previousTop = box.scrollTop;
  const settle = () => requestAnimationFrame(() => {
    if (resetToTop) { box.scrollTop = 0; return; }
    if (anchorIndex !== null) {
      const el = box.querySelector(`[data-msg-index="${anchorIndex}"]`);
      box.scrollTop = el ? Math.max(0, el.offsetTop) : 0;
      return;
    }
    box.scrollTop = previousTop;
  });
  document.getElementById("ask-reset").classList.toggle("hidden", !askMsgs.length);
  if (!askMsgs.length) {
    box.innerHTML = `
      <div class="ask-empty">
        <div class="ask-empty-intro">
          <img class="ask-avatar big" src="/folsom_owl.png?v=1" alt="Folsom">
          <div>
            <p class="ask-empty-kicker">Corpus research assistant</p>
            <h3>Begin with a research question</h3>
            <p>Folsom searches every coded substantive federal fair-use opinion
              through ${esc(askRelease().coverage)} and returns cited cases,
              quotations, and corpus statistics.</p>
          </div>
        </div>
        <p class="ask-example-label">Suggested starting points</p>
        <div class="ask-examples">
          ${ASK_EXAMPLES.map((x) => `<button type="button" class="ask-example">${esc(x)}</button>`).join("")}
        </div>
      </div>`;
    settle();
    return;
  }
  box.innerHTML = askMsgs.map((m, i) => {
    if (m.role === "user")
      return `<div class="ask-msg ask-user" data-msg-index="${i}"><div class="ask-bubble">${esc(m.content)}</div></div>`;
    // Split model-suggested follow-ups ("NEXT: ..." lines) out of the body.
    const followups = [];
    const bodyText = m.content.split("\n").filter((line) => {
      const fm = line.match(/^\s*(?:[-*]\s*)?NEXT:\s*(.+)$/);
      if (fm) { followups.push(fm[1].trim()); return false; }
      return true;
    }).join("\n").replace(/\n?\s*(?:\*\*)?(?:Follow|Suggested follow)[- ]?ups?:?(?:\*\*)?\s*$/i, "");
    const manifest = m.manifest || {};
    let body = askResolveTokens(askMdRender(bodyText), manifest);
    // Auto-render a bar chart for every distinct statistic the answer cites.
    const statHandles = [...new Set(
      [...m.content.matchAll(/\[STAT:([A-Za-z0-9_-]+)\]/g)].map((x) => `STAT:${x[1]}`))];
    const charts = statHandles.map((h) => askStatChart(manifest[h], i, h)).join("");
    if (m.streaming) body += `<span class="ask-cursor"></span>`;
    const cards = (m.cards || []).map(askQueryCard).join("");
    const note = m.toolNote && m.streaming
      ? `<div class="ask-toolnote">${esc(m.toolNote)}</div>` : "";
    const isLast = i === askMsgs.length - 1;
    const fu = !m.streaming && isLast && followups.length
      ? `<section class="ask-followups" aria-label="Related questions">
          <p class="ask-followups-label">Related questions from Folsom</p>
          <div class="ask-followups-list">
            ${followups.slice(0, 3).map((q) =>
              `<button type="button" class="ask-example ask-followup">${esc(q)}</button>`).join("")}
          </div>
        </section>`
      : "";
    return `<div class="ask-msg ask-assistant" data-msg-index="${i}">
      <img class="ask-avatar" src="/folsom_owl.png?v=1" alt="">
      <div class="ask-content">${note}<div class="ask-body">${body}</div>${charts}${cards}${fu}</div></div>`;
  }).join("");
  settle();
}

const TOOL_NOTES = {
  search_quotes: "Searching opinion passages…",
  search_cases: "Finding matching cases…",
  get_case: "Reading the case coding…",
  stats: "Counting…",
};

// Enable/disable every control that mutates the thread while a turn streams.
function askSetBusy(busy) {
  askBusy = busy;
  const send = document.getElementById("ask-send");
  if (send) send.disabled = busy;
  const reset = document.getElementById("ask-reset");
  if (reset) {
    reset.disabled = busy;
    reset.classList.toggle("is-disabled", busy);
  }
  const hist = document.getElementById("ask-history");
  if (hist) {
    hist.classList.toggle("is-disabled", busy);
    hist.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
  }
}

async function askSend(text) {
  if (askBusy || !text.trim()) return;
  const gen = ++askGen;
  askSetBusy(true);
  // The conversation this request belongs to; if the thread changes underneath
  // us the response must not be attached to whatever is on screen later.
  const sentConvoId = askConvoId;
  askMsgs.push({ role: "user", content: text.trim() });
  const reply = { role: "assistant", content: "", cards: [], manifest: {},
                  streaming: true };
  askMsgs.push(reply);
  // Anchor the question the user just asked to the top; the answer grows below.
  renderAsk({ anchorIndex: askMsgs.length - 2 });
  try {
    // History is server-derived from the conversation; the client sends none.
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text.trim(),
                             conversation_id: sentConvoId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (gen !== askGen) return;
      reply.content = err.error || `The assistant is unavailable (${res.status}).`;
      reply.error = true;
      reply.streaming = false;
      renderAsk();
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Thread was reset or another conversation opened: abandon this stream.
      if (gen !== askGen) { reader.cancel().catch(() => {}); return; }
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === "delta") { reply.content += ev.text; reply.toolNote = null; }
        else if (ev.type === "tool") reply.toolNote = TOOL_NOTES[ev.name] || "Working…";
        else if (ev.type === "card") reply.cards.push(ev.card);
        else if (ev.type === "evidence" || ev.type === "done") {
          Object.assign(reply.manifest, ev.manifest || {});
          if (ev.type === "done" && ev.conversation_id && gen === askGen)
            askConvoId = ev.conversation_id;
        }
        else if (ev.type === "error") { reply.content ||= ev.message; reply.error = true; }
        renderAsk();
      }
    }
  } catch {
    reply.content ||= "Connection lost. Try again.";
    reply.error = true;
  } finally {
    reply.streaming = false;
    reply.toolNote = null;
    askSetBusy(false);
    if (gen === askGen) {
      renderAsk();
      askRefreshHistory();
    }
  }
}

document.getElementById("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("ask-input");
  const v = input.value;
  input.value = "";
  askSend(v);
});
document.getElementById("ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("ask-form").requestSubmit();
  }
});
document.getElementById("stats-body").addEventListener("click", (e) => {
  const copy = e.target.closest(".ask-chart-copy");
  if (copy && statsChartEvs[copy.dataset.h]) askChartCopyPng(statsChartEvs[copy.dataset.h], copy, "bars");
});
document.getElementById("ask-messages").addEventListener("click", (e) => {
  const copy = e.target.closest(".ask-chart-copy");
  if (copy) {
    const m = askMsgs[Number(copy.dataset.mi)];
    const ev = m && m.manifest && m.manifest[copy.dataset.h];
    if (ev) askChartCopyPng(ev, copy);
    return;
  }
  const ex = e.target.closest(".ask-example");
  if (ex) askSend(ex.textContent);
});
document.getElementById("ask-reset").addEventListener("click", () => {
  if (askBusy) return;
  askGen++;
  askMsgs = [];
  askConvoId = null;
  renderAsk({ resetToTop: true });
});

/* Saved chats drawer (below 1,100 pixels the rail is off-canvas). */

const askRail = document.querySelector(".ask-rail");
const askHistToggle = document.getElementById("ask-history-toggle");

function askCloseHistoryDrawer() {
  if (!askRail) return;
  askRail.classList.remove("is-open");
  if (askHistToggle) askHistToggle.setAttribute("aria-expanded", "false");
}

if (askHistToggle && askRail) {
  askHistToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = askRail.classList.toggle("is-open");
    askHistToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("click", (e) => {
    if (!askRail.classList.contains("is-open")) return;
    if (askRail.contains(e.target)) return;
    askCloseHistoryDrawer();
  });
}

/* Saved chats: list, reopen, delete. */

async function askRefreshHistory() {
  const panel = document.getElementById("ask-history");
  try {
    const d = await api("/api/chats");
    if (!d.chats.length) {
      panel.innerHTML = `<p class="meta">No saved chats yet. Every question you ask is saved here.</p>`;
      return;
    }
    panel.innerHTML = d.chats.map((c) => {
      const updated = new Date(c.updated * 1000);
      const when = updated.toLocaleDateString(undefined,
        { month: "short", day: "numeric" });
      return `<div class="ask-hist-row${c.conversation_id === askConvoId ? " current" : ""}"
        data-cid="${c.conversation_id}">
        <button type="button" class="ask-hist-open">
          <span class="ask-hist-title">${esc(c.title)}</span>
          <time class="ask-hist-date" datetime="${esc(updated.toISOString())}">${esc(when)}</time>
        </button>
        <button type="button" class="ask-hist-del"
          aria-label="Delete saved chat: ${esc(c.title)}">Delete</button>
      </div>`;
    }).join("");
  } catch {
    panel.innerHTML = `<p class="meta">Could not load saved chats.</p>`;
  }
}

async function askLoadConversation(cid) {
  if (askBusy) return;
  const gen = ++askGen;
  try {
    const d = await api(`/api/chats/${cid}`);
    if (gen !== askGen) return;
    askConvoId = cid;
    askMsgs = d.messages.map((m) => {
      if (m.role === "assistant") {
        // Per-message manifest, exactly as it was stored for that answer.
        let manifest = {};
        try { manifest = JSON.parse(m.manifest || "{}") || {}; } catch {}
        let cards = [];
        try { cards = JSON.parse(m.cards || "[]"); } catch {}
        return { role: "assistant", content: m.content, cards, manifest };
      }
      return { role: "user", content: m.content };
    });
    renderAsk({ resetToTop: true });
    askRefreshHistory();
  } catch { /* api() already routed auth failures */ }
}

document.getElementById("ask-history").addEventListener("click", async (e) => {
  const row = e.target.closest(".ask-hist-row");
  if (!row) return;
  if (askBusy) return;   // no thread surgery while an answer is streaming
  const cid = Number(row.dataset.cid);
  if (e.target.closest(".ask-hist-del")) {
    if (!confirm("Delete this saved chat?")) return;
    await apiSend(`/api/chats/${cid}`, "DELETE");
    row.remove();
    if (askConvoId === cid) {
      askGen++;
      askMsgs = [];
      askConvoId = null;
      renderAsk({ resetToTop: true });
    }
    return;
  }
  if (e.target.closest(".ask-hist-open")) {
    askCloseHistoryDrawer();
    askLoadConversation(cid);
  }
});

/* ---------- routing ---------- */

function route() {
  if (!me.authenticated) {
    show("gate");
    return;
  }
  const hash = location.hash || "#/";
  const caseMatch = hash.match(/^#\/case\/(OP\d{6})$/);
  if (caseMatch) {
    show("case");
    runCase(caseMatch[1]);
    return;
  }
  // #/browse survives as a deep-link alias for the Cases mode of the search
  // view (stats-page factor pivots, saved links); there is no Browse tab.
  if (hash.startsWith("#/browse")) {
    show("search");
    setMode("cases");
    if (hash.includes("?")) {
      // A parameterized pivot link defines the case set by itself, including
      // its case-name query; anything stale in the box would silently narrow
      // it. Facets must be loaded before the hash is applied, or select-backed
      // filters fail to stick in a fresh tab.
      const params = new URLSearchParams(hash.split("?")[1]);
      document.getElementById("search-input").value = (params.get("q") || "").trim();
      loadFacets().then(() => {
        applyBrowseHash(hash);
        renderFilterTokens();
        runCases();
      });
      return;
    }
    renderFilterTokens();
    runCases();
    return;
  }
  if (hash.startsWith("#/ask")) {
    show("ask");
    renderAsk();
    askRefreshHistory();
    return;
  }
  if (hash.startsWith("#/mycases")) {
    show("mycases");
    runMyCases();
    return;
  }
  if (hash.startsWith("#/stats")) {
    show("stats");
    runStats();
    return;
  }
  if (hash.startsWith("#/about")) {
    show("about");
    return;
  }
  show("search");
  setMode("quotes");
  // Deep link with a query (e.g. Folsom's "Open result set"): apply the
  // link's filters to the band, then run it. Facets load first so
  // select-backed filters stick in a fresh tab.
  if (hash.startsWith("#/search") && hash.includes("?")) {
    const params = new URLSearchParams(hash.split("?")[1]);
    const q = (params.get("q") || "").trim();
    if (q) {
      document.getElementById("search-input").value = q;
      loadFacets().then(() => {
        applyBrowseHash(hash);
        renderFilterTokens();
        runSearch(q);
      });
      return;
    }
  }
  if (hash === "#/" || hash === "") {
    // Home: reset to the landing state.
    document.getElementById("search-results").innerHTML = "";
    document.getElementById("search-input").value = "";
    const count = document.getElementById("sf-count");
    if (count) count.textContent = "";
    const panel = document.getElementById("context-panel");
    if (panel) panel.classList.add("hidden");
    lastSearch = null;
    setHomeExtras(true);
  }
}

window.addEventListener("hashchange", routeAndOnboard);

document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (resultsMode === "cases") {
    runCases(1);
    return;
  }
  const q = document.getElementById("search-input").value.trim();
  if (q) {
    location.hash = "#/search";
    runSearch(q);
  }
});
for (const id of Object.values(SEARCH_FILTER_IDS)) {
  document.getElementById(id).addEventListener("change", () => rerunActive());
}
// Guarded: a cached index.html without the toggle must not throw here and
// kill the rest of the script (boot included).
document.getElementById("mode-quotes")?.addEventListener("click", () => {
  if (resultsMode === "quotes") return;
  setMode("quotes");
  if (location.hash.startsWith("#/browse")) location.hash = "#/search";
  const q = document.getElementById("search-input").value.trim();
  if (q) runSearch(q, 1);
});
document.getElementById("mode-cases")?.addEventListener("click", () => {
  if (resultsMode === "cases") return;
  if (location.hash.startsWith("#/browse")) {
    setMode("cases");
    runCases(1);
  } else {
    location.hash = "#/browse"; // route() switches mode and runs the listing
  }
});

// Example chips (hero buttons and task-path links) run a canned search.
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip, .chip-link");
  if (!chip || !chip.dataset.q) return;
  e.preventDefault();
  document.getElementById("search-input").value = chip.dataset.q;
  location.hash = "#/search";
  runSearch(chip.dataset.q);
});

// Back to results: rerun the saved search, restore scroll.
document.addEventListener("click", (e) => {
  const back = e.target.closest("#back-to-results");
  if (!back || !lastSearch) return;
  e.preventDefault();
  const saved = lastSearch;
  location.hash = "#/search";
  runSearch(saved.q, saved.page).then(() => {
    if (saved.scrollY != null) window.scrollTo(0, saved.scrollY);
  });
});

// Leaving a result list for a case page: remember scroll position.
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="#/case/"]');
  if (link && lastSearch) lastSearch.scrollY = window.scrollY;
});

/* ---------- example card (build-stamped from release v0.2.0) ---------- */

const EXAMPLE_CARD = {
  release_id: "v0.2.0",
  opinion_id: "OP000900",
  unit_id: "WU000900-01",
  case_name: "Hachette Book Grp., Inc. v. Internet Archive",
  citation: "115 F.4th 163",
  court_abbrev: "2d Cir.",
  decision_date: "2024-09-04",
  outcome: "not_fair_use",
  factors: { 1: "disfavors_fair_use", 2: "disfavors_fair_use", 3: "disfavors_fair_use", 4: "disfavors_fair_use" },
  component: "f4_substitution (cuts against fair use)",
  quote: "IA's Free Digital Library serves as a satisfactory substitute for the original Works.",
  page: 18,
  voice: "deciding_court_controlling",
  work: "127 published books",
  use: "scanning and free online distribution through controlled digital lending",
};

function renderExampleCard() {
  const el = document.getElementById("example-card");
  if (!el) return;
  const c = EXAMPLE_CARD;
  el.innerHTML = `
    <div class="card example-card">
      <h3><a href="#/case/${esc(c.opinion_id)}">${esc(c.case_name)}</a>${outcomeBadge(c.outcome)}</h3>
      <div class="meta">${esc(c.citation)} · ${esc(c.court_abbrev)} · ${esc(c.decision_date)} ·
        <span class="anno">controlling opinion</span></div>
      <div class="meta">${esc(c.work)} → ${esc(c.use)} <span class="anno">the work/use pair</span></div>
      <div class="meta">Factor 4: disfavors fair use · ${esc(c.component)}
        <span class="anno">factor coding</span></div>
      <blockquote>“${esc(c.quote)}”
        <span class="quote-page">— source page ${esc(c.page)}</span>
        <span class="anno">the court's own words, pin-cited</span></blockquote>
      <p class="meta"><a href="#/case/${esc(c.opinion_id)}">View the full Factor 4 analysis →</a> ·
        <a href="#/search" class="chip-link" data-q='"satisfactory substitute"'>Run this search</a></p>
    </div>`;
}

async function fillStats() {
  try {
    const s = await api("/api/stats");
    const screened = (s.screeningFunnel || []).reduce((t, r) => t + r.n, 0);
    const substantive = s.opinionsByCohort.reduce((t, r) => t + r.n, 0);
    const rel = s.release || {};
    const funnelText =
      `${screened.toLocaleString()} screened → ${substantive.toLocaleString()} substantive → ` +
      `${s.unitCount.toLocaleString()} analyses → ${s.quoteCount.toLocaleString()} selected quotes`;
    // One human-readable date format for every footer surface, so the
    // release line and the suggested citation can never drift apart.
    const coverageHuman = (iso) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
      if (!m) return iso || "";
      const months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
    };
    document.getElementById("footer-data-version").textContent =
      `Release ${rel.release_id || "v0.2.0"}` +
      (rel.coverage_end ? ` · coverage through ${coverageHuman(rel.coverage_end)}` : "") + ".";
    const counts = document.getElementById("footer-corpus-counts");
    if (counts) {
      counts.textContent =
        `${substantive.toLocaleString()} federal opinions · ` +
        `${s.unitCount.toLocaleString()} work/use analyses · ` +
        `${s.quoteCount.toLocaleString()} selected quotes.`;
    }
    const citeRel = document.getElementById("footer-citation-release");
    if (citeRel && rel.release_id) citeRel.textContent = rel.release_id;
    const citeYear = document.getElementById("footer-citation-year");
    if (citeYear && rel.coverage_end) citeYear.textContent = rel.coverage_end.slice(0, 4);
    const trust = document.getElementById("trust-counts");
    if (trust) {
      trust.textContent =
        `${screened.toLocaleString()} opinions screened · ` +
        `${substantive.toLocaleString()} substantive opinions · ` +
        `${s.unitCount.toLocaleString()} work/use analyses · ` +
        `${s.quoteCount.toLocaleString()} searchable selected quotes`;
    }
    const funnel = document.getElementById("funnel-line");
    if (funnel) funnel.textContent = funnelText;
    if (rel.release_id && rel.coverage_end) {
      const badge = document.getElementById("release-badge");
      if (badge) badge.textContent = `${rel.release_id} · Through ${rel.coverage_end}`;
      const aboutRel = document.getElementById("about-release");
      if (aboutRel) aboutRel.textContent = `${rel.release_id}, coverage through ${rel.coverage_end}.`;
    }
  } catch {
    /* leave the static fallback text */
  }
}

/* ---------- auth boot ---------- */

function renderAccountBox() {
  document.body.classList.toggle("gated", !me.authenticated);
  document.body.classList.toggle("app", me.authenticated);
  const box = document.getElementById("account-box");
  if (!box) return;
  box.innerHTML = me.authenticated
    ? `<span class="side-user-name">${esc(me.name || me.email)}</span>
       <a href="/auth/logout">Sign out</a>`
    : "";
}

// Signing in navigates away; keep the intended hash so a shared link like
// #/case/OP000900 survives the round trip through Google.
document.addEventListener("click", (e) => {
  const link = e.target.closest(".signin-link");
  if (link && location.hash.length > 2) {
    sessionStorage.setItem("postLoginHash", location.hash);
  }
});

/* ---------- email sign-in ---------- */

function emailError(msg) {
  const el = document.getElementById("email-error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function wireEmailSignin() {
  if (!me.emailSignin) return;
  document.getElementById("email-signin").classList.remove("hidden");
  const startForm = document.getElementById("email-start-form");
  const codeForm = document.getElementById("email-code-form");
  startForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    emailError("");
    const email = document.getElementById("email-input").value.trim();
    const res = await fetch("/auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      emailError(body.error || "Could not send the code. Try again.");
      return;
    }
    document.getElementById("email-sent-note").textContent =
      `We sent a code and a sign-in link to ${email}. Enter the code here, or open the link.`;
    codeForm.classList.remove("hidden");
    document.getElementById("code-input").focus();
  });
  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    emailError("");
    const email = document.getElementById("email-input").value.trim();
    const code = document.getElementById("code-input").value.trim();
    const res = await fetch("/auth/email/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      emailError(body.error || "Verification failed. Try again.");
      return;
    }
    document.cookie = "fud_login_evt=email; Path=/; Secure; SameSite=Lax; Max-Age=120";
    location.reload();
  });
}

function wireContactForm() {
  const dialog = document.getElementById("contact-dialog");
  const form = document.getElementById("contact-form");
  const errEl = document.getElementById("contact-error");
  const sentEl = document.getElementById("contact-sent");
  const submitBtn = document.getElementById("contact-submit");
  document.getElementById("contact-link").addEventListener("click", (e) => {
    e.preventDefault();
    form.reset();
    errEl.classList.add("hidden");
    sentEl.classList.add("hidden");
    submitBtn.disabled = false;
    dialog.showModal();
  });
  document.getElementById("contact-cancel").addEventListener("click", () => {
    dialog.close();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.classList.add("hidden");
    submitBtn.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    let res;
    try {
      res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => ({})) : {};
      errEl.textContent =
        body.error || "Could not send the message. Please try again.";
      errEl.classList.remove("hidden");
      submitBtn.disabled = false;
      return;
    }
    sentEl.classList.remove("hidden");
    setTimeout(() => dialog.close(), 1500);
  });
}

/* ---------- first-login orientation ----------
   Permanent dismissal lives in a cookie so it survives a cleared web-storage
   profile; the per-session suppression stays in sessionStorage. */
const ONBOARDING_COOKIE = "fud_onboard";
const ONBOARDING_SESSION_KEY = "fud.onboarding.shownThisSession.v1";

let onboardingConsideredThisBoot = false;
let onboardingReturnFocus = null;

function storageGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
}

function storageRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing else is required.
  }
}

function onboardingDismissedForever() {
  return document.cookie
    .split(";")
    .some((part) => part.trim() === `${ONBOARDING_COOKIE}=dismissed`);
}

function setOnboardingCookie() {
  document.cookie =
    `${ONBOARDING_COOKIE}=dismissed; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function wireOnboarding() {
  const dialog = document.getElementById("onboarding-dialog");
  const never = document.getElementById("onboarding-never");
  if (!dialog || !never) return;
  const persistIfNever = () => {
    if (never.checked) setOnboardingCookie();
  };
  // The button dismissal, Escape, and the close event all land here. Covering
  // submit and cancel as well as close keeps the cookie reliable in embedded
  // browsers that do not deliver the dialog close event.
  const form = dialog.querySelector("form");
  if (form) form.addEventListener("submit", persistIfNever);
  dialog.addEventListener("cancel", persistIfNever);
  dialog.addEventListener("close", () => {
    persistIfNever();
    const target = onboardingReturnFocus;
    onboardingReturnFocus = null;
    if (target && document.contains(target) && typeof target.focus === "function") {
      target.focus();
    }
  });
}

function maybeShowOnboarding() {
  if (!me.authenticated || onboardingConsideredThisBoot) return;
  onboardingConsideredThisBoot = true;
  if (onboardingDismissedForever()) return;
  if (storageGet(sessionStorage, ONBOARDING_SESSION_KEY) === "1") return;
  const dialog = document.getElementById("onboarding-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  storageSet(sessionStorage, ONBOARDING_SESSION_KEY, "1");
  requestAnimationFrame(() => {
    if (!me.authenticated || dialog.open) return;
    onboardingReturnFocus = document.activeElement;
    dialog.showModal();
  });
}

/* Routing happens first, so a restored deep link is already underneath the
   card. The orientation code never touches location.hash. */
function routeAndOnboard() {
  route();
  maybeShowOnboarding();
}

// One GA login event per fresh sign-in. The worker (OAuth, verify link) or
// the code form sets fud_login_evt; consume it exactly once here.
function reportLoginEvent() {
  const m = document.cookie.match(/(?:^|;\s*)fud_login_evt=([a-z]+)/);
  if (!m) return;
  document.cookie = "fud_login_evt=; Path=/; Secure; SameSite=Lax; Max-Age=0";
  if (typeof gtag === "function") gtag("event", "login", { method: m[1] });
}

async function init() {
  wireContactForm();
  wireOnboarding();
  wireFiltersCard();
  try {
    me = await api("/api/me");
  } catch {
    me = { authenticated: false };
  }
  if (typeof gtag === "function")
    gtag("set", "user_properties", { user_state: me.authenticated ? "signed_in" : "gate" });
  reportLoginEvent();
  renderAccountBox();
  if (!me.authenticated) {
    storageRemove(sessionStorage, ONBOARDING_SESSION_KEY);
    wireEmailSignin();
    show("gate");
    return;
  }
  renderExampleCard();
  fillStats();
  const saved = sessionStorage.getItem("postLoginHash");
  sessionStorage.removeItem("postLoginHash");
  if (saved && saved !== location.hash) {
    location.hash = saved; // hashchange fires routeAndOnboard()
  } else {
    routeAndOnboard();
  }
}
init();
