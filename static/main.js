// Identifies this page load. Runs are tagged with it so the funded browser
// lists only what has been run since the page was opened, not leftovers
// the server still remembers from earlier.
const SESSION_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Cities with a run in progress (a count, in case the same city is started
// twice). On Verification & Review a running city's results stay hidden -
// neither its previous allocation nor a partial one is shown - while the
// other city's finished results remain visible.
const RUNNING = {};
const RUN_QUEUE = [];   // runs waiting their turn, in the order Run was pressed
let ACTIVE_JOB = null;  // the one run executing now
const RUNS_BY_DS = {};   // latest finished allocation per city
const CITY_NAME = { pasig: 'Pasig City', qc: 'Quezon City' };
function isRunning(ds) { return (RUNNING[ds] || 0) > 0; }
function runningCities() { return Object.keys(RUNNING).filter(isRunning); }
function runningNames() { return runningCities().map(d => CITY_NAME[d]).join(' and '); }
function runningVerb() { return runningCities().length > 1 ? 'are' : 'is'; }
// e.g. "Pasig City is still running and Quezon City is queued"
function pendingSentence() {
  return runningCities().map(d =>
    `${CITY_NAME[d]} is ${ACTIVE_JOB && ACTIVE_JOB.ds === d ? 'still running' : 'queued'}`).join(' and ');
}

/* ── Floating progress window ─────────────────────────────────────────────
   Each run keeps its own progress record, so the window can follow it while
   you move between phases. It shows on every phase; on Execution & Results it
   leaves out the run already shown in full by the live race panel. */
const PROGRESS = {};          // run id -> progress of one run
let RUN_SEQ = 0;
let CURRENT_PAGE = 'setup';
let DOCK_MIN = false;
let DOCK_TICK = null;
const ALGO_SHORT = { bnb: 'KB (Pure B&B)', ga: 'KBG (B&B + GA)' };

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtMs(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`;
}
function announceRun(text) {
  const live = document.getElementById('runDockLive');
  if (live) live.textContent = text;
}

function dockRunHTML(r) {
  const order = (r.order && r.order.length) ? r.order : Object.keys(r.algos);
  // Trials are interleaved (trial 1 of every algorithm, then trial 2 ...), so
  // the algorithm computing now is the first unfinished one with the fewest
  // completed trials.
  let current = null;
  if (r.status === 'running') {
    const pending = order.filter(a => r.algos[a] && !r.algos[a].done);
    if (pending.length) {
      const minT = Math.min(...pending.map(a => r.algos[a].trial));
      current = pending.find(a => r.algos[a].trial === minT);
    }
  }
  const lanes = order.filter(a => r.algos[a]).map(a => {
    const L = r.algos[a];
    const pct = L.trials ? Math.round(L.trial / L.trials * 100) : 0;
    const what = L.done ? 'finished'
      : a === current ? `computing trial ${L.trial + 1}`
      : 'waiting for its turn';
    return `
      <div class="rd-algo ${L.done ? 'done' : ''} ${a === current ? 'active' : ''}">
        <div class="rd-algo-top"><span>${ALGO_SHORT[a] || escHtml(L.label)}</span>
          <span class="rd-count">${L.trial}/${L.trials}</span></div>
        <div class="rd-bar"><div class="rd-fill" style="width:${pct}%"></div></div>
        <div class="rd-sub"><span>${what}</span>
          <span>${L.mean_runtime == null ? '' : 'mean runtime ' + fmtMs(L.mean_runtime)}</span></div>
      </div>`;
  }).join('');

  if (r.status === 'queued') {
    const pos = RUN_QUEUE.findIndex(j => j.id === r.id) + 1;
    const before = pos > 1 ? `${pos - 1} queued run${pos - 1 === 1 ? '' : 's'} and ` : '';
    const now = ACTIVE_JOB ? CITY_NAME[ACTIVE_JOB.ds] : 'the current run';
    return `
      <div class="rd-run queued">
        <div class="rd-run-hdr">
          <div>
            <div class="rd-city">${CITY_NAME[r.ds] || escHtml(r.ds)}</div>
            <div class="rd-meta">${r.n.toLocaleString()} projects · ${r.trials} trial${r.trials === 1 ? '' : 's'} each</div>
          </div>
          <div class="rd-state">Queued · #${pos}</div>
          <button class="rd-x" onclick="cancelQueued(${r.id})" aria-label="Remove ${CITY_NAME[r.ds]} from the queue" title="Remove from the queue">×</button>
        </div>
        <div class="rd-note wait">Starts automatically after ${before}${now} finish${before ? '' : 'es'}.</div>
      </div>`;
  }

  const elapsed = fmtElapsed((r.ended || Date.now()) - r.started);

  // A finished run shrinks to one line so the window covers as little of
  // the page as possible while you read the results.
  if (r.status === 'done') {
    return `
      <div class="rd-run done compact">
        <div class="rd-run-hdr">
          <div class="rd-city">${CITY_NAME[r.ds] || escHtml(r.ds)}</div>
          <div class="rd-state">✓ Finished in ${elapsed}</div>
          <button class="rd-x" onclick="dismissRun(${r.id})" aria-label="Dismiss ${CITY_NAME[r.ds]}">×</button>
        </div>
      </div>`;
  }

  const state = r.status === 'running'
    ? `<span class="rd-dot" aria-hidden="true"></span>Running · <span class="rd-elapsed" data-start="${r.started}">${elapsed}</span>`
    : r.status === 'done' ? `✓ Finished in ${elapsed}` : '⚠ Stopped';

  return `
    <div class="rd-run ${r.status}">
      <div class="rd-run-hdr">
        <div>
          <div class="rd-city">${CITY_NAME[r.ds] || escHtml(r.ds)}</div>
          <div class="rd-meta">${r.n.toLocaleString()} projects · ${r.trials} trial${r.trials === 1 ? '' : 's'} each</div>
        </div>
        <div class="rd-state">${state}</div>
        ${r.status !== 'running'
          ? `<button class="rd-x" onclick="dismissRun(${r.id})" aria-label="Dismiss ${CITY_NAME[r.ds]}">×</button>` : ''}
      </div>
      ${lanes || '<div class="rd-sub"><span>Starting…</span></div>'}
      ${r.status === 'done' ? '<div class="rd-note">Results are ready in Reporting &amp; History and Verification &amp; Review.</div>' : ''}
      ${r.status === 'error' ? `<div class="rd-note err">${escHtml(r.error || 'The run did not finish.')}</div>` : ''}
    </div>`;
}

function renderDock() {
  const dock = document.getElementById('runDock');
  if (!dock) return;
  const app = document.getElementById('app-container');
  const appOn = app && app.style.display !== 'none';
  // Running first, then the queue in order, then finished runs.
  const rank = { running: 0, queued: 1, error: 2, done: 3 };
  const runs = Object.values(PROGRESS)
    .filter(r => !(CURRENT_PAGE === 'execution' && r.status === 'running' && r.algos === LIVE))
    .filter(r => !(CURRENT_PAGE === 'execution' && r.status === 'done' && r.algos === LIVE))
    .sort((a, b) => (rank[a.status] - rank[b.status]) || (a.id - b.id));
  if (!appOn || !runs.length) {
    // The space reserved under the page stays until you change pages, so the
    // page does not jump while you are reading when the window closes.
    dock.style.display = 'none';
    return;
  }

  const summary = runs.map(r => {
    if (r.status === 'done')  return `${CITY_NAME[r.ds]} ✓`;
    if (r.status === 'queued') return `${CITY_NAME[r.ds]} queued`;
    if (r.status === 'error') return `${CITY_NAME[r.ds]} ⚠`;
    const L = Object.values(r.algos);
    const done = L.reduce((t, x) => t + x.trial, 0), all = L.reduce((t, x) => t + x.trials, 0);
    return `${CITY_NAME[r.ds]} ${all ? Math.round(done / all * 100) : 0}%`;
  }).join(' · ');

  dock.style.display = 'block';
  dock.classList.toggle('min', DOCK_MIN);
  positionDock();
  dock.innerHTML = `
    <div class="rd-head">
      <span class="rd-title">Algorithm progress</span>
      ${DOCK_MIN ? `<span class="rd-summary">${summary}</span>` : ''}
      <button class="rd-btn" onclick="toggleDock()" aria-expanded="${!DOCK_MIN}"
              aria-label="${DOCK_MIN ? 'Expand' : 'Minimize'} the progress window">${DOCK_MIN ? '▴' : '▾'}</button>
    </div>
    ${DOCK_MIN ? '' : `<div class="rd-body">${runs.map(dockRunHTML).join('')}</div>`}`;
  // Leave room under the current page's content so its last buttons can
  // scroll clear of the window instead of sitting underneath it.
  // It only grows during a page visit (never shrinks under you), and is
  // reset when you change pages.
  const view = document.getElementById('page-' + CURRENT_PAGE);
  const need = dock.offsetHeight + 28;
  if (view && (parseFloat(view.style.paddingBottom) || 0) < need) view.style.paddingBottom = need + 'px';
}

// On Execution & Results the action bar (with the Run button) sticks to the
// bottom of the screen and rides up above the footer at the end of the page,
// so the window is kept just above wherever the bar currently is.
function positionDock() {
  const dock = document.getElementById('runDock');
  if (!dock || dock.style.display === 'none') return;
  const bar = document.querySelector('.actionbar');
  let gap = 20;
  if (CURRENT_PAGE === 'execution' && bar && bar.offsetParent !== null) {
    gap = Math.max(20, Math.round(window.innerHeight - bar.getBoundingClientRect().top) + 14);
  }
  dock.style.bottom = gap + 'px';
  dock.style.maxHeight = `calc(100vh - ${gap + 110}px)`;
}
let _dockRAF = 0;
['scroll', 'resize'].forEach(evt => window.addEventListener(evt, () => {
  if (_dockRAF) return;
  _dockRAF = requestAnimationFrame(() => { _dockRAF = 0; positionDock(); });
}, { passive: true }));

function toggleDock() { DOCK_MIN = !DOCK_MIN; renderDock(); }
function dismissRun(id) { delete PROGRESS[id]; renderDock(); }

// Keeps the elapsed clocks moving between trials (a single Quezon City trial
// can take several seconds) without redrawing the whole window.
function ensureDockTick() {
  if (DOCK_TICK) return;
  DOCK_TICK = setInterval(() => {
    document.querySelectorAll('#runDock .rd-elapsed').forEach(el => {
      el.textContent = fmtElapsed(Date.now() - Number(el.dataset.start));
    });
    if (!Object.values(PROGRESS).some(r => r.status === 'running')) {
      clearInterval(DOCK_TICK); DOCK_TICK = null;
    }
  }, 1000);
}

// ── Landing Page ─────────────────────────────────────────────────────────────
function goHome(e) {
  if (e) e.preventDefault();
  returnToLanding();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function goAbout(e) {
  if (e) e.preventDefault();
  if (document.getElementById('landing-container').style.display === 'none') {
    returnToLanding();
  }
  setTimeout(() => {
    const el = document.querySelector('.landing-middle');
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({top, behavior: 'smooth'});
    }
  }, 100);
}

function goDevelopers(e) {
  if (e) e.preventDefault();
  if (document.getElementById('landing-container').style.display === 'none') {
    returnToLanding();
  }
  setTimeout(() => {
    const el = document.querySelector('.landing-bottom');
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({top, behavior: 'smooth'});
    }
  }, 100);
}

function goTool(e) {
  if (e) e.preventDefault();
  startApp();
}

// Side nav observer
document.addEventListener("DOMContentLoaded", () => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        document.querySelectorAll('.side-dot').forEach(d => d.classList.remove('active'));
        if (entry.target.classList.contains('landing-top')) {
          document.querySelector('.side-dot[data-target="home"]')?.classList.add('active');
        } else if (entry.target.classList.contains('landing-middle')) {
          document.querySelector('.side-dot[data-target="about"]')?.classList.add('active');
        } else if (entry.target.classList.contains('landing-bottom')) {
          document.querySelector('.side-dot[data-target="devs"]')?.classList.add('active');
        }
      }
    });
  }, { threshold: 0.3 });
  
  document.querySelectorAll('.landing-top, .landing-middle, .landing-bottom').forEach(section => {
    observer.observe(section);
  });
});

function startApp() {
  document.getElementById('landing-container').style.display = 'none';
  document.getElementById('app-container').style.display = 'flex';
  document.getElementById('navTitle').style.display = 'block';
  document.getElementById('sideNav').style.display = 'none';
  // Fade in
  setTimeout(() => {
    document.getElementById('app-container').style.opacity = '1';
    renderDock();
  }, 10);
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function returnToLanding() {
  document.getElementById('app-container').style.opacity = '0';
  document.getElementById('navTitle').style.display = 'none';
  document.getElementById('sideNav').style.display = 'flex';
  setTimeout(() => {
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('landing-container').style.display = 'flex';
    renderDock();
  }, 500);
}

function copyEmail() {
  const email = 'hybridknapsack@gmail.com';
  navigator.clipboard.writeText(email).then(() => {
    const toast = document.getElementById('emailToast');
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 3000);
  }).catch(err => {
    console.error('Failed to copy email: ', err);
  });
}

// ── Page Navigation ────────────────────────────────────────────────────────
function switchPage(pageId) {
  CURRENT_PAGE = pageId;
  document.querySelectorAll('.page-view').forEach(v => { v.style.paddingBottom = ''; });
  // Update Tabs
  document.querySelectorAll('.tab-link').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.page === pageId);
  });
  
  // Update Views
  document.querySelectorAll('.page-view').forEach(view => {
    view.style.display = 'none';
    view.classList.remove('active');
  });
  
  const activeView = document.getElementById('page-' + pageId);
  if (activeView) {
    activeView.style.display = 'block';
    // Small delay to allow display:block to apply before adding opacity class
    setTimeout(() => activeView.classList.add('active'), 10);
  }
  
  // Toggle ActionBar visibility
  const actionBar = document.querySelector('.actionbar');
  if (actionBar) {
    actionBar.style.display = pageId === 'execution' ? 'block' : 'none';
  }

  // Toggle footer text visibility
  const footerTxt = document.getElementById('footerTxt');
  if (footerTxt) {
    footerTxt.style.display = pageId === 'execution' ? 'block' : 'none';
  }

  // Each phase starts at the top rather than mid-scroll from the last one.
  window.scrollTo({ top: 0, behavior: 'smooth' });
  updatePhaseNav();
  if (pageId === 'review') loadReview();
  renderDock();
}

/* Keeps the sequential "continue" buttons in step with the current state:
   the Setup phase cannot be left until projects have actually been chosen,
   and the reason is stated rather than the click silently failing. */
function updatePhaseNav() {
  const selCount = CHECKED.size;

  const toExec = document.getElementById('toExecutionBtn');
  const hint   = document.getElementById('setupHint');
  if (toExec) {
    toExec.disabled = selCount === 0;
  }
  if (hint) {
    hint.textContent = selCount === 0
      ? 'Select at least one project above to continue.'
      : `${selCount.toLocaleString()} project${selCount === 1 ? '' : 's'} selected.`;
    hint.classList.toggle('warn', selCount === 0);
  }

  const execHint = document.getElementById('execHint');
  if (execHint) {
    const hasResults = !!document.querySelector('#results .compare-grid');
    execHint.textContent = hasResults
      ? 'Results recorded. Continue to view the history and statistical report.'
      : 'Run the algorithms above to record results.';
    execHint.classList.toggle('warn', !hasResults);
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let DS       = 'pasig';
let PROJECTS = [];   // full dataset for current DS
let FILTERED = [];   // after sector + search filter
let CHECKED  = new Set();
let BUDGET   = 5_000_000_000;
let SECTOR   = 'All';
let PAGE     = 0;
const PAGE_SIZE = 50;

let currentTab  = 2;
const _expandedNodes = new Set();
let activeAlgos = {bnb: true, ga: true};

function toggleAlgo(name, el) {
  // Prevent unchecking the last remaining algorithm
  const others = Object.keys(activeAlgos).filter(k => k !== name);
  const anyOtherActive = others.some(k => activeAlgos[k]);
  if (!el.checked && !anyOtherActive) {
    el.checked = true;
    return;
  }
  activeAlgos[name] = el.checked;
  document.getElementById('lbl-'+name).classList.toggle('checked', el.checked);
  updateActionBar();
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await loadDs('pasig');
  updateMeta();
  updateActionBar();
}

async function loadDs(ds) {
  DS = ds;
  const resp = await fetch(`/api/projects?ds=${ds}`);
  const data = await resp.json();
  PROJECTS = data.projects;
  CHECKED.clear();
  SECTOR = 'All';
  PAGE   = 0;
  document.getElementById('searchBox').value = '';
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('on', b.dataset.sector === 'All'));

  // Update switcher
  document.getElementById('btnPasig').className = 'ds-card' + (ds==='pasig' ? ' active' : '');
  document.getElementById('btnQC').className    = 'ds-card' + (ds==='qc'    ? ' active' : '');
  const bar = document.getElementById('infoBar');
  bar.className = 'ds-infobar ' + ds;
  const info = {
    pasig: '<b>Pasig City APP FY 2025 (General Fund)</b> — Source: City Government of Pasig, LGU Transparency Portal. Used as the <b>small dataset</b> to establish a standard of optimality and verify algorithm accuracy.',
    qc:    '<b>Quezon City APP FY 2025 (4th Quarter)</b> — Source: QC Bids and Awards Committee, LGU Transparency Portal. Used as the <b>large dataset</b> to stress-test scalability and efficiency of the hybrid algorithm.',
  };
  document.getElementById('infoText').innerHTML = info[ds];
  document.getElementById('footerTxt').textContent = ds==='pasig'
    ? 'Pasig City · Annual Procurement Plan FY 2025 (General Fund) | Knapsack DP · Branch & Bound · Genetic Algorithm'
    : 'Quezon City · Annual Procurement Plan FY 2025 (4th Quarter) | Knapsack DP · Branch & Bound · Genetic Algorithm';

  filterProjects();
  preselectTop();
  // Restore the empty state rather than blanking the panel. Blanking left
  // step 5 of the Execution tab visibly empty with no explanation of what
  // to do next.
  resetResultsPanel();
}

function resetResultsPanel() {
  document.getElementById('results').innerHTML = `
    <div class="card">
      <div class="empty-state">
        <p>No results yet.</p>
        <p class="es-sub">Choose your projects and algorithms, then run. Each algorithm's
        runtime, execution time and pruning rate will be compared here.</p>
      </div>
    </div>`;
}

function switchDs(ds) {
  if (ds === DS) return;
  loadDs(ds);
  const bp = document.getElementById('btnPasig');
  const bq = document.getElementById('btnQC');
  if (bp) bp.setAttribute('aria-pressed', ds === 'pasig');
  if (bq) bq.setAttribute('aria-pressed', ds === 'qc');
}

function updateMeta() {
  fetch('/api/meta').then(r=>r.json()).then(d=>{
    document.getElementById('pasigMeta').textContent =
      `${d.pasig.count.toLocaleString()} Projects`;
    document.getElementById('qcMeta').textContent =
      `${d.qc.count.toLocaleString()} Projects`;
  });
}

// ── Budget ─────────────────────────────────────────────────────────────────
const BUDGET_MAX = 50000000000;

function updateBudget(v, source) {
  let n;
  if (source === 'input') {
    // Strip everything except digits (allow the user to type commas freely)
    n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
    if (isNaN(n)) n = 0;
  } else {
    n = parseInt(v, 10);
    if (isNaN(n)) n = 0;
  }
  // Clamp to [0, BUDGET_MAX]
  if (n < 0) n = 0;
  if (n > BUDGET_MAX) n = BUDGET_MAX;
  BUDGET = n;

  // Sync the slider (always reflects the clamped value)
  document.getElementById('budgetSlider').value = n;

  // Sync the text input. While the user is actively typing in it, don't
  // fight their cursor by reformatting mid-edit; only push the formatted
  // value when the change came from the slider.
  if (source !== 'input') {
    document.getElementById('budgetInput').value = n.toLocaleString();
  }
  updateActionBar();
}

function normalizeBudgetInput() {
  // On blur, snap the text field to the clean formatted, clamped value.
  document.getElementById('budgetInput').value = BUDGET.toLocaleString();
}

function fmt(n) {
  return '₱' + Math.round(n).toLocaleString();
}
function fmtB(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  return Math.round(n).toLocaleString();
}

// ── Filter + render ────────────────────────────────────────────────────────
function setSector(btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  SECTOR = btn.dataset.sector;
  PAGE = 0;
  filterProjects();
}

function filterProjects() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  FILTERED = PROJECTS.filter(p => {
    if (SECTOR !== 'All' && p.sector !== SECTOR) return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.pmo.toLowerCase().includes(q)) return false;
    return true;
  });
  PAGE = 0;
  renderTable();
}

function renderTable() {
  const start = PAGE * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, FILTERED.length);
  const page_items = FILTERED.slice(start, end);

  const tbody = document.getElementById('projTbody');
  if (!FILTERED.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No projects match the filter.</td></tr>';
    renderPagination();
    updateSelCount();
    return;
  }

  tbody.innerHTML = page_items.map((p, li) => {
    const pi = p._idx;  // index in PROJECTS
    const chk = CHECKED.has(pi);
    return `<tr>
      <td><input type="checkbox" class="chk" ${chk?'checked':''} onchange="toggleCheck(${pi},this.checked)"></td>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(p.name)}">${escHtml(p.name)}</td>
      <td><span class="s-badge s-${p.sector.replace(/ /g,'-')}">${p.sector}</span></td>
      <td style="font-size:11px;color:var(--tx-secondary);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.pmo)}</td>
      <td class="cost-col">${fmtB(p.cost)}</td>
      <td class="benefit-col"><span class="b-pill" style="background:${bcolor(p.benefit)}">${p.benefit.toFixed(1)}</span></td>
    </tr>`;
  }).join('');

  // Update pool stats
  document.getElementById('totalCount').textContent  = PROJECTS.length.toLocaleString();
  document.getElementById('poolLabel').textContent   = DS==='pasig'
    ? 'Pasig City APP FY 2025' : 'Quezon City APP FY 2025';
  const tot = PROJECTS.reduce((s,p)=>s+p.cost,0);
  document.getElementById('totalBudgetLbl').textContent = fmtB(tot);

  renderPagination();
  updateSelCount();
  syncChkAll();
}

function renderPagination() {
  const total_pages = Math.ceil(FILTERED.length / PAGE_SIZE);
  const start = PAGE * PAGE_SIZE + 1;
  const end   = Math.min((PAGE+1)*PAGE_SIZE, FILTERED.length);
  document.getElementById('pageInfo').textContent = `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${FILTERED.length.toLocaleString()}`;

  const cont = document.getElementById('pageBtns');
  if (total_pages <= 1) { cont.innerHTML=''; return; }

  let btns = `<button class="page-btn" onclick="goPage(${PAGE-1})" ${PAGE===0?'disabled':''}>←</button>`;
  // Show at most 7 page buttons around current
  const lo = Math.max(0, PAGE-3), hi = Math.min(total_pages-1, PAGE+3);
  if (lo > 0) btns += `<button class="page-btn" onclick="goPage(0)">1</button>${lo>1?'<span style="color:var(--tx-muted);padding:0 4px">…</span>':''}`;
  for (let i=lo; i<=hi; i++) btns += `<button class="page-btn ${i===PAGE?'active':''}" onclick="goPage(${i})">${i+1}</button>`;
  if (hi < total_pages-1) btns += `${hi<total_pages-2?'<span style="color:var(--tx-muted);padding:0 4px">…</span>':''}<button class="page-btn" onclick="goPage(${total_pages-1})">${total_pages}</button>`;
  btns += `<button class="page-btn" onclick="goPage(${PAGE+1})" ${PAGE===total_pages-1?'disabled':''}>→</button>`;
  cont.innerHTML = btns;
}

function goPage(p) { PAGE = p; renderTable(); }

function toggleCheck(pi, checked) {
  if (checked) CHECKED.add(pi); else CHECKED.delete(pi);
  updateSelCount();
}

function toggleAll(checked) {
  // Select / deselect ALL filtered projects across every page
  FILTERED.forEach(p => {
    if (checked) CHECKED.add(p._idx); else CHECKED.delete(p._idx);
  });
  renderTable();
}

function syncChkAll() {
  const el = document.getElementById('chkAll');
  if (!el) return;
  const total    = FILTERED.length;
  const selected = FILTERED.filter(p => CHECKED.has(p._idx)).length;
  el.checked       = total > 0 && selected === total;
  el.indeterminate = selected > 0 && selected < total;
}

function updateSelCount() {
  const sel   = [...CHECKED];
  const total = sel.reduce((s,i) => s + PROJECTS[i].cost, 0);
  document.getElementById('selPill').textContent = `${sel.length.toLocaleString()} selected`;
  document.getElementById('selCost').textContent  = `${fmt(total)} total cost`;
  updateActionBar();
}

function preselectTop() {
  CHECKED.clear();
  // Select top-50 by benefit score
  [...PROJECTS]
    .map((p,i)=>({i, b:p.benefit, c:p.cost}))
    .sort((a,b)=>b.b-a.b||a.c-b.c)
    .slice(0,50)
    .forEach(x=>CHECKED.add(x.i));
  renderTable();
}

function bcolor(b) {
  if (b >= 9)  return '#16A34A';
  if (b >= 7)  return '#0284C7';
  if (b >= 5)  return '#B45309';
  return '#9CA3AF';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ── Run algorithms (streamed) ─────────────────────────────────────────────
// Progress arrives over Server-Sent Events instead of waiting for one big
// response, so every algorithm's trial counter, latest timing and running
// mean update live, and each algorithm's result renders the moment it
// finishes its own trials.
let LIVE = {};   // algo -> live tallies for the race panel

/* ── Run queue ────────────────────────────────────────────────────────────
   Only one run executes at a time, so no two runs ever share the processor
   and every timing stays clean. Pressing Run while a run is in progress adds
   the new run to a queue; it starts automatically when the one before it
   finishes. Each queued run keeps the city, budget, projects, algorithms and
   trial count that were set when Run was pressed. */
function runAlgos() {
  const selected_indices = [...CHECKED];
  if (!selected_indices.length) {
    showMsg('warn', 'Select at least one project in step 3 before running.');
    document.getElementById('stepProjects').scrollIntoView({block:'center'});
    return Promise.resolve();
  }
  const algos = Object.keys(activeAlgos).filter(k => activeAlgos[k]);
  if (!algos.length) {
    showMsg('warn', 'Select at least one algorithm in step 4 before running.');
    document.getElementById('setup').scrollIntoView({block:'center'});
    return Promise.resolve();
  }
  clearMsg();

  const job = {
    id: ++RUN_SEQ, ds: DS, budget: BUDGET, selected: selected_indices,
    algos, trials: getTrials(),
  };
  job.finished = new Promise(res => { job.resolve = res; });

  // From this moment the city counts as pending: its earlier results stay
  // hidden on Verification & Review until this run has finished.
  RUNNING[job.ds] = (RUNNING[job.ds] || 0) + 1;
  PROGRESS[job.id] = {
    id: job.id, ds: job.ds, n: selected_indices.length, trials: job.trials,
    algos: {}, order: algos, status: 'queued', started: null,
  };

  if (ACTIVE_JOB) {
    RUN_QUEUE.push(job);
    announceRun(`${CITY_NAME[job.ds]} added to the queue.`);
    renderDock(); refreshReview(); updateActionBar();
  } else {
    executeRun(job, false);
  }
  return job.finished;
}

function startNextQueued() {
  if (ACTIVE_JOB || !RUN_QUEUE.length) return;
  executeRun(RUN_QUEUE.shift(), true);
}

function cancelQueued(id) {
  const i = RUN_QUEUE.findIndex(j => j.id === id);
  if (i < 0) return;
  const [job] = RUN_QUEUE.splice(i, 1);
  RUNNING[job.ds] = Math.max(0, (RUNNING[job.ds] || 0) - 1);
  delete PROGRESS[id];
  announceRun(`${CITY_NAME[job.ds]} removed from the queue.`);
  job.resolve();
  renderDock(); refreshReview(); updateActionBar();
}

async function executeRun(job, fromQueue) {
  ACTIVE_JOB = job;
  const prog = PROGRESS[job.id];
  prog.status = 'running';
  prog.started = Date.now();
  updateActionBar();

  // The old single bar is replaced by the per-algorithm race panel.
  document.getElementById('progressWrap').style.display = 'none';

  // A run started with the Run button takes over the live race panel on
  // Execution & Results. A run that starts from the queue leaves the previous
  // results on screen and is followed in the progress window instead; its own
  // results replace them when it finishes.
  const live = prog.algos;
  if (!fromQueue) LIVE = live;
  const showRace = () => !fromQueue && LIVE === live;

  renderDock(); ensureDockTick(); refreshReview();
  announceRun(`${CITY_NAME[job.ds]} run started.`);
  const finished = {};
  let doneData = null;

  try {
    const resp = await fetch('/api/run/stream', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({
        ds: job.ds, budget: job.budget, selected: job.selected,
        algos: job.algos, trials: job.trials, pop_size: 60, gens: 100,  // mutation defaults to 1/n server-side
        session: SESSION_ID,
      }),
    });

    if (!resp.ok) {
      let msg = 'Run failed.';
      try { msg = (await resp.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));

        if (ev.type === 'start') {
          prog.order = ev.algos;
          ev.algos.forEach(a => {
            live[a] = { label: ev.labels[a], trial: 0, trials: ev.trials,
                        runtime: null, mean_runtime: null, mean_exec: null,
                        mean_pruning: null, done: false };
          });
          if (showRace()) renderRacePanel();
          renderDock();

        } else if (ev.type === 'progress') {
          const L = live[ev.algo];
          if (L) {
            L.trial        = ev.trial;
            L.trials       = ev.trials;
            L.runtime      = ev.runtime_ms;
            L.mean_runtime = ev.mean_runtime;
            L.mean_exec    = ev.mean_exec;
            L.mean_pruning = ev.mean_pruning;
            L.benefit      = ev.total_benefit;
          }
          if (showRace()) renderRacePanel();
          renderDock();

        } else if (ev.type === 'result') {
          if (live[ev.algo]) live[ev.algo].done = true;
          finished[ev.algo] = ev.result;
          if (showRace()) renderRacePanel();
          renderDock();

        } else if (ev.type === 'done') {
          doneData = ev;
        }
      }
    }

    if (doneData) {
      // Runs never overlap, so the run finishing now is the newest result.
      LIVE = live;
      currentTab = doneData.results.length - 1;
      renderResults(doneData);
      renderHistory(doneData.history);
      captureAllocation(doneData, job.selected);
      loadStats();
      updatePhaseNav();
    }

  } catch(err) {
    prog.error = err.message;
    if (showRace()) {
      document.getElementById('results').innerHTML =
        `<div class="banner warn"><span>⚠</span> Error: ${escHtml(err.message)}</div>`;
    }
  } finally {
    RUNNING[job.ds] = Math.max(0, (RUNNING[job.ds] || 0) - 1);
    ACTIVE_JOB = null;
    prog.status = doneData ? 'done' : 'error';
    prog.ended = Date.now();
    announceRun(doneData ? `${CITY_NAME[job.ds]} finished.` : `${CITY_NAME[job.ds]} run stopped.`);
    // A finished run leaves the window after a while; a failed one stays
    // until dismissed so the message is not missed.
    if (doneData) setTimeout(() => { if (PROGRESS[job.id]) dismissRun(job.id); }, 15000);
    // Show the finished city only where the view had nothing to show; never
    // switch away from finished results being read.
    if (doneData && (!VERIFY_PICK || isRunning(VERIFY_PICK) || !RUNS_BY_DS[VERIFY_PICK])) VERIFY_PICK = job.ds;
    job.resolve();
    startNextQueued();          // the next queued run, if any, starts now
    refreshReview(); renderDock(); updateActionBar();
  }
}

/* Live race panel: one lane per algorithm, updated on every trial. */
function renderRacePanel() {
  const algos = Object.keys(LIVE);
  if (!algos.length) return;

  const allDone = algos.every(a => LIVE[a].done);
  const lanes = algos.map(a => {
    const L   = LIVE[a];
    const pct = L.trials ? Math.round((L.trial / L.trials) * 100) : 0;
    return `
      <div class="lane ${L.done ? 'done' : ''}">
        <div class="lane-hdr">
          <span class="lane-name">${escHtml(L.label)}</span>
          <span class="lane-count">${L.done ? 'finished' : `run ${L.trial} / ${L.trials}`}</span>
        </div>
        <div class="lane-bar"><div class="lane-fill" style="width:${pct}%"></div></div>
        <div class="lane-stats">
          <div><span class="ls-l">last runtime</span><span class="ls-v">${L.runtime==null?'—':L.runtime.toFixed(2)+' ms'}</span></div>
          <div><span class="ls-l">mean runtime</span><span class="ls-v">${L.mean_runtime==null?'—':L.mean_runtime.toFixed(2)+' ms'}</span></div>
          <div><span class="ls-l">mean exec.</span><span class="ls-v">${L.mean_exec==null?'—':L.mean_exec.toFixed(2)+' ms'}</span></div>
          <div><span class="ls-l">mean pruning</span><span class="ls-v">${L.mean_pruning==null?'—':L.mean_pruning.toFixed(1)+'%'}</span></div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('results').innerHTML = `
    <div class="card race-card">
      <div class="card-hdr">
        <div class="card-title">${allDone ? 'Run complete' : 'Running…'}</div>
        <div class="card-meta">${allDone ? 'Compiling comparison…' : 'Trials are interleaved, so each timing is measured without contention'}</div>
      </div>
      <div class="race-lanes">${lanes}</div>
    </div>`;
}

function renderResults(data) {
  const results    = data.results;
  const sel_items  = data.selected_items;
  const budget_used = data.budget;

  const benefits = results.map(r=>r.total_benefit);
  const maxBen   = Math.max(...benefits);
  const minBen   = Math.min(...benefits);
  const allMatch = benefits.every(b=>b===maxBen);
  const gapPct   = maxBen>0 ? (maxBen-minBen)/maxBen*100 : 0;

  // A small gap (< 1%) is almost always the standard DP's discretization
  // rounding (it works on a bucketed cost axis), not a GA convergence
  // problem - the exact methods (B&B, B&B+GA) always agree with each other.
  const banner = results.length === 1
    ? `<div class="banner ok"><span>✓</span> ${escHtml(results[0].label)} reached a benefit score of ${maxBen.toFixed(2)}.</div>`
    : allMatch
    ? `<div class="banner ok"><span>✓</span> All algorithms reached the same optimal benefit score (${maxBen.toFixed(2)}) — results are consistent.</div>`
    : gapPct < 1.0
    ? `<div class="banner ok"><span>✓</span> Branch-and-Bound methods agree on the optimum (${maxBen.toFixed(2)}); standard DP is within ${gapPct.toFixed(3)}% due to its discretized cost axis — expected behaviour.</div>`
    : `<div class="banner warn"><span>⚠</span> Benefit scores differ by ${gapPct.toFixed(2)}%. For very large selections, standard DP uses a coarser cost grid; B&B and B&B+GA remain exact.</div>`;

  const barColors = ['#4F6EF7','#0284C7','#7C3AED'];
  const ccards = results.map((r,ri)=>{
    const isBest = r.total_benefit === maxBen;
    const tc = r.selected.reduce((s,i)=>s+sel_items[i].cost,0);
    const pct = maxBen>0 ? Math.round((r.total_benefit/maxBen)*100) : 0;
    const bc = isBest ? '#16A34A' : barColors[ri % barColors.length];
    const hasNodes = r.pruning_rate != null;
    const ntOpen = hasNodes && _expandedNodes.has(ri);
    return `<div class="ccard ${isBest?'best':''}">
      <div class="ccard-eye">${isBest?'<div class="best-tag">✓ Optimal</div>':''}</div>
      <div class="ccard-title">${escHtml(r.label)}</div>
      <div class="ccard-big">${r.total_benefit.toFixed(2)}</div>
      <div class="ccard-sub">total benefit score</div>
      <div class="bar-t"><div class="bar-f" style="width:${pct}%;background:${bc}"></div></div>
      <div class="ccard-div"></div>
      <div class="ccard-row"><span class="lbl">Budget used</span><span class="val ${isBest?'hl-green':'hl'}">${fmtB(tc)}</span></div>
      <div class="ccard-row"><span class="lbl">Projects</span><span class="val">${r.selected.length}</span></div>
      <div class="ccard-row"><span class="lbl">Runtime</span><span class="val hl">${r.runtime_ms!=null ? r.runtime_ms.toFixed(1)+' ms' : 'N/A'}</span></div>
      <div class="ccard-row"><span class="lbl">Execution time</span><span class="val">${r.exec_ms!=null ? r.exec_ms.toFixed(1)+' ms' : 'N/A'}</span></div>
      <div class="ccard-row ${hasNodes?'node-row':''} ${ntOpen?'open':''}" id="nt-btn-${ri}" ${hasNodes?`onclick="toggleNodes(${ri})"`:''}><span class="lbl">Pruning rate${hasNodes?'<span class="nt-caret">▸</span>':''}</span><span class="val ${r.pruning_rate!=null?'hl-green':''}">${r.pruning_rate!=null ? r.pruning_rate.toFixed(2)+'%' : 'N/A'}</span></div>
      <div class="node-detail" id="nt-${ri}" style="display:${ntOpen?'block':'none'}">
        <div class="ccard-row"><span class="lbl">Nodes explored</span><span class="val">${r.nodes_generated!=null ? r.nodes_generated.toLocaleString() : 'N/A'}</span></div>
        <div class="ccard-row"><span class="lbl">Nodes pruned</span><span class="val ${r.nodes_pruned!=null?'hl-green':''}">${r.nodes_pruned!=null ? r.nodes_pruned.toLocaleString() : 'N/A'}</span></div>
      </div>
      <div class="ccard-row"><span class="lbl">Time</span><span class="val">${escHtml(r.time_complexity)}</span></div>
      <div class="ccard-row"><span class="lbl">Space</span><span class="val">${escHtml(r.space_complexity)}</span></div>
    </div>`;
  }).join('');


  const cr   = results[currentTab] || results[results.length-1];
  const cset = new Set(cr.selected);
  const ctc  = cr.selected.reduce((s,i)=>s+sel_items[i].cost,0);

  const tabs = results.map((r,i)=>
    `<div class="algo-tab ${currentTab===i?'on':''}" onclick="switchTab(${i})">${escHtml(r.label)}</div>`
  ).join('');

  const chips = sel_items.map((p,i)=>`
    <div class="res-chip ${cset.has(i)?'sel':'rej'}">
      <span class="s-badge s-${p.sector.replace(/ /g,'-')}">${p.sector}</span>
      <span class="res-name">${escHtml(p.name)}</span>
      <span class="res-cost">${fmt(p.cost)}</span>
      <span class="res-score">${p.benefit.toFixed(1)}</span>
    </div>`).join('');

  document.getElementById('results').innerHTML = `
    <div class="card fade-in">
      <div class="card-hdr"><div class="card-title">Algorithm comparison — ${data.ds==='pasig'?'Pasig City':'Quezon City'}</div></div>
      ${banner}
      <div class="deflist">
        <div><b>Runtime</b> — time the algorithm spends actively executing, excluding setup.</div>
        <div><b>Execution time</b> — total time to process the data and produce the allocation.</div>
        <div><b>Pruning rate</b> — share of search-tree branches discarded without exploring.</div>
      </div>
      <div class="compare-grid">${ccards}</div>
      ${convergenceBlock(data)}
    </div>
    <div class="card fade-in" style="animation-delay:.1s">
      <div class="card-title" style="margin-bottom:14px">Selected projects</div>
      <div class="algo-tabs" id="resTabs">${tabs}</div>
      <div class="stats-bar">
        <div class="stat"><div class="stat-l">Total benefit</div><div class="stat-v acc">${cr.total_benefit.toFixed(2)}</div><div class="stat-s">utility score</div></div>
        <div class="stat"><div class="stat-l">Budget used</div><div class="stat-v">${fmtB(ctc)}</div><div class="stat-s">${Math.round((ctc/budget_used)*100)}% of cap</div></div>
        <div class="stat"><div class="stat-l">Projects funded</div><div class="stat-v">${cr.selected.length}</div><div class="stat-s">of ${sel_items.length} candidates</div></div>
        <div class="stat"><div class="stat-l">Runtime</div><div class="stat-v">${cr.runtime_ms!=null ? cr.runtime_ms.toFixed(1)+' ms' : 'N/A'}</div><div class="stat-s">active execution only</div></div>
        <div class="stat"><div class="stat-l">Execution time</div><div class="stat-v">${cr.exec_ms!=null ? cr.exec_ms.toFixed(1)+' ms' : 'N/A'}</div><div class="stat-s">${escHtml(cr.time_complexity)}</div></div>
        <div class="stat"><div class="stat-l">Nodes explored</div><div class="stat-v">${cr.nodes_generated!=null ? cr.nodes_generated.toLocaleString() : 'N/A'}</div><div class="stat-s">${cr.nodes_generated!=null ? 'search tree size' : 'no B&B tree'}</div></div>
        <div class="stat"><div class="stat-l">Pruning rate</div><div class="stat-v ${cr.pruning_rate!=null?'acc':''}">${cr.pruning_rate!=null ? cr.pruning_rate.toFixed(2)+'%' : 'N/A'}</div><div class="stat-s">${cr.pruning_rate!=null ? 'branches pruned' : 'no B&B tree'}</div></div>
      </div>
      <div class="res-list">${chips}</div>
    </div>`;

  // Store for tab switching
  window._lastData = data;
}

function switchTab(i) {
  currentTab = i;
  renderResults(window._lastData);
}

function toggleNodes(i) {
  const box = document.getElementById('nt-' + i);
  const btn = document.getElementById('nt-btn-' + i);
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  if (btn) btn.classList.toggle('open', open);
  if (open) _expandedNodes.add(i); else _expandedNodes.delete(i);
}

/* ── Inline messaging ────────────────────────────────────────────────
   Errors are shown in place rather than through alert(), so the user can
   read the problem and the offending control at the same time. */
function showMsg(kind, text) {
  const el = document.getElementById('globalMsg');
  if (!el) return;
  const icon = kind === 'err' ? '!' : kind === 'warn' ? '!' : 'i';
  el.innerHTML = `<div class="msg ${kind}"><span class="msg-icon" aria-hidden="true">${icon}</span><span>${escHtml(text)}</span></div>`;
}

function clearMsg() {
  const el = document.getElementById('globalMsg');
  if (el) el.innerHTML = '';
}

/* ── Persistent status bar ───────────────────────────────────────────
   Keeps the run configuration visible at all times and blocks the action
   before it can fail, stating the reason instead of reporting it after. */
function updateActionBar() {
  const selCount = CHECKED.size;
  const algos    = Object.keys(activeAlgos).filter(k => activeAlgos[k]);
  const trials   = Math.max(1, Math.min(30, parseInt(document.getElementById('trialsInput').value, 10) || 1));

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set('abDs',     DS === 'pasig' ? 'Pasig City' : 'Quezon City');
  set('abBudget', fmtB(BUDGET));
  set('abSel',    selCount.toLocaleString());
  set('abAlgos',  algos.length);
  set('abTrials', trials);

  const selEl = document.getElementById('abSel');
  if (selEl) selEl.classList.toggle('warn', selCount === 0);
  const algEl = document.getElementById('abAlgos');
  if (algEl) algEl.classList.toggle('warn', algos.length === 0);

  // Error prevention: say what is missing before the button can be pressed.
  let reason = '';
  if (!selCount && !algos.length) reason = 'Select at least one project and one algorithm to run.';
  else if (!selCount)             reason = 'Select at least one project in step 3.';
  else if (!algos.length)         reason = 'Select at least one algorithm in step 4.';

  const btn = document.getElementById('runBtn');
  if (btn) {
    btn.disabled = !!reason;
    btn.textContent = ACTIVE_JOB
      ? (trials > 1 ? `Add to queue (${trials} runs each)` : 'Add to queue')
      : (trials > 1 ? `Run ${trials} times each` : 'Run algorithms');
  }
  // While a run is in progress, say when a new one would start.
  let hint = '';
  if (!reason && ACTIVE_JOB) {
    const ahead = RUN_QUEUE.length;
    hint = `${CITY_NAME[ACTIVE_JOB.ds]} is running. A new run starts automatically after it`
         + (ahead ? ` and ${ahead} queued run${ahead === 1 ? '' : 's'}.` : '.');
  }
  const rEl = document.getElementById('abReason');
  if (rEl) { rEl.textContent = reason || hint; rEl.classList.toggle('info', !reason && !!hint); }

  // Reflect progress on the numbered rail.
  const mark = (id, done) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('done', done);
  };
  mark('stepProjects', selCount > 0);
  mark('setup',        algos.length > 0);

  updatePhaseNav();
}

/* ── Trials control ──────────────────────────────────────────────────── */
function getTrials() {
  const el = document.getElementById('trialsInput');
  let v = parseInt(el.value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > 30) v = 30;
  el.value = v;
  return v;
}

function setTrials(n) {
  document.getElementById('trialsInput').value = n;
  updateActionBar();
}

/* ── Run history / experiment log ────────────────────────────────────── */
let HIST_DATA   = [];     // full combo list incl. per-trial rows
let HIST_OPEN   = null;   // "ds|algo" of the currently expanded combo

async function loadHistory() {
  try {
    const resp = await fetch('/api/history');
    const data = await resp.json();
    renderHistory(data.combos);
  } catch(err) {
    // Non-fatal: the history panel simply stays empty.
  }
}

function histKey(c) { return c.ds + '|' + c.algo; }

function toggleHist(key) {
  HIST_OPEN = (HIST_OPEN === key) ? null : key;
  renderHistory(HIST_DATA);
}

function num(v, dp) {
  return (v === null || v === undefined) ? '—' : Number(v).toFixed(dp);
}

/* Mean of a numeric field across a combo's stored runs. */
function histMean(trials, field) {
  const vals = trials.map(t => t[field]).filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  return vals.reduce((a,b) => a+b, 0) / vals.length;
}

function renderHistory(combos) {
  const panel = document.getElementById('historyPanel');
  if (!panel) return;

  HIST_DATA = combos || [];
  const total = HIST_DATA.reduce((s,c) => s + c.count, 0);

  if (!HIST_DATA.length) {
    panel.innerHTML = `
      <div class="card fade-in">
        <div class="card-hdr">
          <div class="card-title">Run history</div>
        </div>
        <div class="hist-empty">
          No runs recorded yet.<br>
          Run an algorithm above — each run's runtime, execution time and
          pruning rate will be logged here
          (last 30 runs kept per dataset + algorithm).
        </div>
      </div>`;
    return;
  }

  // Keep the expanded combo valid; otherwise open the first one by default.
  if (!HIST_DATA.some(c => histKey(c) === HIST_OPEN)) {
    HIST_OPEN = histKey(HIST_DATA[0]);
  }

  const cards = HIST_DATA.map(c => {
    const key  = histKey(c);
    const pct  = Math.min(100, Math.round((c.count / 30) * 100));
    const done = c.complete;
    const on   = HIST_OPEN === key;
    return `
      <div class="hist-card ${done?'done':''} ${on?'on':''}" onclick="toggleHist('${key}')">
        <div class="hist-algo">${escHtml(c.algo_name)}</div>
        <div class="hist-ds">${escHtml(c.ds_name)}</div>
        <span class="hist-count ${done?'done':''}">${c.count}</span>
        <span class="hist-of"> / 30 runs</span>
        <div class="hist-bar"><div class="hist-bar-fill ${done?'done':''}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  // ── Per-run detail table for the expanded combination ────────────────
  const combo  = HIST_DATA.find(c => histKey(c) === HIST_OPEN);
  let detail = '';

  if (combo) {
    const t = combo.trials;
    const rows = t.map((r, i) => `
      <tr>
        <td class="hr-idx">Run ${i + 1}</td>
        <td>${num(r.runtime_ms, 2)}</td>
        <td>${num(r.exec_ms, 2)}</td>
        <td>${r.pruning_rate === null ? '—' : num(r.pruning_rate, 2)}</td>
        <td class="hr-dim">${r.nodes_generated === null ? '—' : r.nodes_generated.toLocaleString()}</td>
        <td class="hr-dim">${r.nodes_pruned === null ? '—' : r.nodes_pruned.toLocaleString()}</td>
        <td class="hr-dim">${num(r.total_benefit, 2)}</td>
        <td class="hr-time">${escHtml(r.timestamp.split(' ')[1] || '')}</td>
      </tr>`).join('');

    const mRun  = histMean(t, 'runtime_ms');
    const mExec = histMean(t, 'exec_ms');
    const mPrun = histMean(t, 'pruning_rate');
    const mBen  = histMean(t, 'total_benefit');

    detail = `
      <div class="hist-detail">
        <div class="hist-detail-hdr">
          <span class="hd-title">${escHtml(combo.algo_name)} · ${escHtml(combo.ds_name)}</span>
          <span class="hd-sub">${combo.count} run${combo.count===1?'':'s'} stored</span>
        </div>
        <div class="hist-table-wrap">
          <table class="hist-table">
            <thead>
              <tr>
                <th>Trial</th>
                <th>Runtime (ms)</th>
                <th>Execution time (ms)</th>
                <th>Pruning rate (%)</th>
                <th>Nodes explored</th>
                <th>Nodes pruned</th>
                <th>Total benefit</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr>
                <td class="hr-idx">Mean</td>
                <td>${num(mRun, 4)}</td>
                <td>${num(mExec, 4)}</td>
                <td>${mPrun === null ? '—' : num(mPrun, 4)}</td>
                <td class="hr-dim">—</td>
                <td class="hr-dim">—</td>
                <td class="hr-dim">${num(mBen, 4)}</td>
                <td class="hr-time"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>`;
  }

  panel.innerHTML = `
    <div class="card fade-in">
      <div class="card-hdr">
        <div class="card-title">Run history — ${total} run${total===1?'':'s'} recorded</div>
        <div class="hist-actions">
          <label class="xl-opt" title="Repeats every funded row with a Dataset column so both cities can be pivoted together. Roughly doubles the file size.">
            <input type="checkbox" id="xlCombined" checked> combined sheet
          </label>
          <button class="hist-btn export" onclick="exportExcel()">⬇ Export to Excel</button>
          <button class="hist-btn danger" onclick="clearHistory()">Clear history</button>
        </div>
      </div>
      <div class="hist-grid">${cards}</div>
      ${detail}
    </div>`;
}

function exportExcel() {
  // The combined cross-city sheet repeats every funded row, which roughly
  // doubles the file size and build time, so it is switchable.
  const cb = document.getElementById('xlCombined');
  const combined = cb ? (cb.checked ? '1' : '0') : '1';
  window.location.href = '/api/export?combined=' + combined;
}

function clearHistory() {
  const modal = document.getElementById('clearHistoryModal');
  modal.style.display = 'flex';
  // Small delay to allow display:flex to apply before adding opacity class for transition
  setTimeout(() => {
    modal.classList.add('show');
  }, 10);
}

function closeClearHistoryModal() {
  const modal = document.getElementById('clearHistoryModal');
  modal.classList.remove('show');
  // Wait for transition to finish before hiding
  setTimeout(() => {
    modal.style.display = 'none';
  }, 300);
}

async function confirmClearHistory() {
  closeClearHistoryModal();
  try {
    const resp = await fetch('/api/history/clear', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({}),
    });
    const data = await resp.json();
    renderHistory(data.combos);
    loadStats();
    FUNDED_STATE.ds = null; FUNDED_STATE.algo = null;
    loadFunded(true);
  } catch(err) {
    showMsg('err', 'Could not clear the history: ' + err.message);
  }
}

/* ── Statistical report ──────────────────────────────────────────────
   Implements Figure 6's "Analysis and Logging Module" output: the paired
   t-test (KB vs KBG) and the independent t-test / efficiency ratio across
   dataset sizes. Computed server-side from the recorded runs. */
async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    renderStats(await resp.json());
  } catch(err) { /* non-fatal */ }
}

function fx(v, dp) {
  return (v === null || v === undefined) ? '—' : Number(v).toFixed(dp);
}

/* p-values here span many orders of magnitude, so very small ones are shown
   in scientific notation rather than rounding to a misleading 0.0000. */
function fp(v) {
  if (v === null || v === undefined) return null;
  if (v < 0.0001) return v.toExponential(2);
  return v.toFixed(4);
}

/* Result label for one t-test row. Hovering over it (or tabbing to it) shows
   what the result means, worded for the comparison the table makes. */
function verdict(row, ctx) {
  let cls, label, title, tip;
  if (row.p === null || row.p === undefined) {
    cls = 'none'; label = 'constant'; title = 'Constant';
    tip = 'The metric did not change across runs, so its standard deviation is zero and no '
        + 't-test can be computed. This is expected for the pruning rate of branch-and-bound, '
        + 'which is deterministic.';
  } else if (row.significant) {
    cls = 'sig'; label = 'significant'; title = `Significant (p = ${fp(row.p)}, below 0.05)`;
    tip = `The difference between ${ctx.a} and ${ctx.b} on this metric is too large to be `
        + `explained by run-to-run variation, so it is very unlikely to be due to chance. It does `
        + `not say how large the difference is; read the ${ctx.size} for that.`;
  } else {
    cls = 'ns'; label = 'not significant'; title = `Not significant (p = ${fp(row.p)}, 0.05 or above)`;
    tip = `The difference between ${ctx.a} and ${ctx.b} on this metric is within what `
        + `run-to-run variation could produce, so these runs do not show a real difference.`;
  }
  return `<span class="vd ${cls}" tabindex="0" data-tip-title="${escHtml(title)}" data-tip="${escHtml(tip)}">${label}</span>`;
}

/* One shared tooltip, placed on the screen rather than inside the table, so the
   table's scroll area never clips it. Works with the mouse, the keyboard (Tab)
   and touch (tap); Esc closes it. */
function tipBox() {
  let el = document.getElementById('tipBox');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tipBox'; el.className = 'tipbox'; el.setAttribute('role', 'tooltip'); el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}
let TIP_TARGET = null;
function showTip(target) {
  TIP_TARGET = target;
  const box = tipBox();
  box.textContent = '';
  if (target.dataset.tipTitle) {
    const t = document.createElement('b'); t.textContent = target.dataset.tipTitle; box.appendChild(t);
  }
  const d = document.createElement('div'); d.textContent = target.dataset.tip; box.appendChild(d);
  box.hidden = false;
  target.setAttribute('aria-describedby', 'tipBox');
  const r = target.getBoundingClientRect(), b = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - b.width, window.innerWidth - b.width - 8));
  let top = r.top - b.height - 8;
  if (top < 90) top = r.bottom + 8;            // not enough room above (fixed nav): open below
  box.style.left = left + 'px'; box.style.top = top + 'px';
}
function hideTip(target) {
  TIP_TARGET = null;
  const box = document.getElementById('tipBox');
  if (box) box.hidden = true;
  if (target && target.removeAttribute) target.removeAttribute('aria-describedby');
}
const tipTarget = e => (e.target && e.target.closest) ? e.target.closest('[data-tip]') : null;
document.addEventListener('mouseover', e => { const t = tipTarget(e); if (t) showTip(t); });
document.addEventListener('mouseout',  e => { const t = tipTarget(e); if (t && !t.contains(e.relatedTarget)) hideTip(t); });
// Backup for when the page scrolls under a still mouse pointer, which can
// skip the 'mouse entered' event: any movement over a label shows its text.
document.addEventListener('mousemove', e => { const t = tipTarget(e); if (t && t !== TIP_TARGET) showTip(t); }, { passive: true });
document.addEventListener('focusin',   e => { const t = tipTarget(e); if (t) showTip(t); });
document.addEventListener('focusout',  e => { const t = tipTarget(e); if (t) hideTip(t); });
document.addEventListener('keydown',   e => { if (e.key === 'Escape') hideTip(document.activeElement); });
// While scrolling, keep the explanation next to its label; close it once the
// label has scrolled out of view.
window.addEventListener('scroll', () => {
  if (!TIP_TARGET) return;
  if (!TIP_TARGET.isConnected) { hideTip(TIP_TARGET); return; }
  const r = TIP_TARGET.getBoundingClientRect();
  const box = document.getElementById('tipBox');
  // Off screen: hide for now but remember the label (e.g. the page is still
  // scrolling toward a label reached with Tab); back on screen: show again.
  if (r.bottom < 0 || r.top > window.innerHeight) { if (box) box.hidden = true; }
  else showTip(TIP_TARGET);
}, { passive: true });


function renderStats(rep) {
  const panel = document.getElementById('statsPanel');
  if (!panel) return;

  const hasEff  = rep.efficiency && rep.efficiency.length;
  const hasComp = rep.comparison && rep.comparison.length;

  if (!hasEff && !hasComp) {
    panel.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <p>No statistics yet.</p>
          <p class="es-sub">The efficiency ratio needs runs on <b>both</b> datasets, and the
          paired t-test needs runs of <b>both</b> B&amp;B and B&amp;B+GA. Record at least two runs
          of each, then the report appears here.</p>
        </div>
      </div>`;
    return;
  }

  let html = '';

  if (hasComp) {
    const blocks = rep.comparison.map(g => `
      <div class="stat-block">
        <div class="sb-title">${escHtml(g.ds_name)}</div>
        <div class="stat-table-wrap">
        <table class="hist-table">
          <thead><tr>
            <th>Metric</th><th>Mean (KB)</th><th>Mean (KBG)</th>
            <th>Mean diff.</th><th>SD of diff.</th><th>t</th><th>p</th><th>Result</th>
          </tr></thead>
          <tbody>
            ${g.rows.map(r => `
              <tr>
                <td class="hr-idx">${escHtml(r.metric)}</td>
                <td>${fx(r.mean_a,4)}</td>
                <td>${fx(r.mean_b,4)}</td>
                <td>${fx(r.mean_diff,4)}</td>
                <td>${fx(r.sd_diff,4)}</td>
                <td>${r.t===null||r.t===undefined?'—':fx(r.t,4)}</td>
                <td>${fp(r.p) ?? '—'}</td>
                <td>${verdict(r, {a: 'KB', b: 'KBG', size: 'mean difference'})}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`).join('');

    html += `
      <div class="card">
        <div class="card-hdr"><div class="card-title">Paired t-test — B&amp;B vs. B&amp;B + GA</div></div>
        <p class="stat-lede">Tests whether the hybrid differs significantly from branch-and-bound alone.
        Runs are paired by problem instance: both solve the identical project set under the identical budget.
        Null hypothesis rejected when p &lt; 0.05.</p>
        ${blocks}
      </div>`;
  }

  if (hasEff) {
    const blocks = rep.efficiency.map(g => `
      <div class="stat-block">
        <div class="sb-title">${escHtml(g.algo_name)}</div>
        <div class="stat-table-wrap">
        <table class="hist-table">
          <thead><tr>
            <th>Metric</th><th>Mean (Pasig)</th><th>Mean (QC)</th>
            <th>Ratio</th><th>t</th><th>df</th><th>p</th><th>Result</th>
          </tr></thead>
          <tbody>
            ${g.rows.map(r => `
              <tr>
                <td class="hr-idx">${escHtml(r.metric)}</td>
                <td>${fx(r.mean_1,4)}</td>
                <td>${fx(r.mean_2,4)}</td>
                <td>${fx(r.ratio,4)}</td>
                <td>${r.t===null||r.t===undefined?'—':fx(r.t,4)}</td>
                <td>${fx(r.df,2)}</td>
                <td>${fp(r.p) ?? '—'}</td>
                <td>${verdict(r, {a: 'Pasig City', b: 'Quezon City', size: 'ratio'})}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`).join('');

    html += `
      <div class="card">
        <div class="card-hdr"><div class="card-title">Independent t-test — efficiency across dataset sizes</div></div>
        <p class="stat-lede">Efficiency is the ratio of each optimality parameter on the small dataset
        relative to the large one. A result that is <i>not</i> significant indicates performance is stable
        across input sizes.</p>
        ${blocks}
      </div>`;
  }

  html += `
    <div class="msg info" style="margin-top:14px">
      <span class="msg-icon" aria-hidden="true">i</span>
      <span>Two-tailed tests at the 0.05 level; hover over a result to see what it means.
      "Significant" means p &lt; 0.05: the difference is too large to be explained by run-to-run
      variation. It says the difference is real, not how large it is — read the mean difference
      or ratio for that. "Not significant" means p ≥ 0.05. "Constant" means the metric did not
      change across runs, so its standard deviation is zero and no t-test can be computed —
      expected for the pruning rate of branch-and-bound, which is deterministic, and not a data error.</span>
    </div>`;

  panel.innerHTML = html;
}

init();
loadHistory();
loadStats();
/* ── Post-allocation verification and comparative review ──────────────────
   Step 7 of the Data Generation/Gathering Procedure. The manuscript specifies
   a MANUAL verification phase, so this does not replace the reviewer's
   judgement - it supplies the material. Automated checks establish the
   mechanical facts over every funded project; the reviewer records the
   judgement on a purposive sample. */
let REVIEW = null;
let REVIEW_SEQ = 0;
// The city shown in Post-allocation verification. It changes only when you
// pick the other city, or when the view had nothing to show (no city picked
// yet, or the picked city is running) and a city finishes. It never jumps
// away from finished results you are reading.
let VERIFY_PICK = null;
const REVIEW_CACHE = {};   // ds -> { t, data } for that city's latest finished run
const VERIFY_SEEN = {};    // ds -> run time last displayed, for the "new" marker

// The most recently finished allocation of a city that is not running now.
function latestFinishedRun() {
  return Object.values(RUNS_BY_DS)
    .filter(r => !isRunning(r.ds))
    .sort((a, b) => b.t - a.t)[0] || null;
}

function selectVerifyCity(ds) {
  VERIFY_PICK = ds;
  loadReview();
}

// Pasig / Quezon City selector shown above the checks.
function verifyTabs() {
  return `<div class="vf-tabs" role="tablist" aria-label="Choose the city to verify">${
    ['pasig', 'qc'].map(ds => {
      const run = RUNS_BY_DS[ds];
      const pending = isRunning(ds);
      const queued = pending && !(ACTIVE_JOB && ACTIVE_JOB.ds === ds);
      const status = pending ? (queued ? 'queued' : 'running…')
        : run ? `✓ ${run.funded.length.toLocaleString()} funded`
        : 'not run yet';
      const fresh = run && !pending && VERIFY_SEEN[ds] !== run.t && ds !== VERIFY_PICK;
      const on = ds === VERIFY_PICK;
      return `
        <button class="vf-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}"
                ${!run && !pending ? 'disabled' : ''} onclick="selectVerifyCity('${ds}')">
          <span>${CITY_NAME[ds]}${fresh ? '<span class="vf-new" title="New results"></span>' : ''}</span>
          <span class="vf-st">${status}</span>
        </button>`;
    }).join('')}</div>`;
}

async function loadReview() {
  const vp = document.getElementById('verifyPanel');
  const seq = ++REVIEW_SEQ;

  // Nothing picked yet: start with the most recently finished city.
  if (!VERIFY_PICK) {
    const latest = latestFinishedRun();
    VERIFY_PICK = latest ? latest.ds : (runningCities()[0] || null);
  }

  if (!VERIFY_PICK) {
    vp.innerHTML = `<div class="card"><div class="empty-state">
      <p>No allocation to verify yet.</p>
      <p class="es-sub">Run the algorithms first. The verification works from the
      project list the algorithm produced.</p></div></div>`;
    renderCompare(); loadFunded(true);
    return;
  }

  const ds = VERIFY_PICK;
  const city = CITY_NAME[ds];
  if (isRunning(ds)) {
    const queued = !(ACTIVE_JOB && ACTIVE_JOB.ds === ds);
    vp.innerHTML = verifyTabs() + `<div class="card"><div class="empty-state">
      <p>${city} is ${queued ? 'queued' : 'still running'}.</p>
      <p class="es-sub">Its checks appear here once every algorithm has finished.</p></div></div>`;
    renderCompare(); loadFunded(true);
    return;
  }

  const run = RUNS_BY_DS[ds];
  if (!run) {
    vp.innerHTML = verifyTabs() + `<div class="card"><div class="empty-state">
      <p>${city} has not been run yet.</p>
      <p class="es-sub">Run the algorithms on ${city} to verify its allocation.</p></div></div>`;
    renderCompare(); loadFunded(true);
    return;
  }

  // Reuse the checks already fetched for this exact run.
  const cached = REVIEW_CACHE[ds];
  if (cached && cached.t === run.t) {
    REVIEW = cached.data;
    renderVerify(); renderCompare(); loadFunded(true);
    return;
  }

  vp.innerHTML = verifyTabs() + `<div class="card"><div class="empty-state"><p>Checking…</p></div></div>`;
  try {
    const resp = await fetch('/api/review', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        ds: run.ds, budget: run.budget,
        selected: run.selected, funded: run.funded,
      }),
    });
    const rev = await resp.json();
    if (seq !== REVIEW_SEQ) return;          // a newer refresh has taken over
    if (rev.error) throw new Error(rev.error);
    REVIEW_CACHE[ds] = { t: run.t, data: rev };
    REVIEW = rev;
    renderVerify(); renderCompare(); loadFunded(true);
  } catch (err) {
    if (seq !== REVIEW_SEQ) return;
    vp.innerHTML = verifyTabs() + `<div class="banner warn"><span>⚠</span> ${escHtml(err.message)}</div>`;
    loadFunded(true);
  }
}

function renderVerify() {
  const r = REVIEW;
  if (!r) return;
  // This city was started again while its checks were loading: redraw.
  if (isRunning(r.ds)) { loadReview(); return; }
  const city = CITY_NAME[r.ds] || r.ds;
  if (RUNS_BY_DS[r.ds]) VERIFY_SEEN[r.ds] = RUNS_BY_DS[r.ds].t;
  const rows = r.checks.map(c => `
    <tr>
      <td class="hr-idx">${escHtml(c.check)}</td>
      <td>${escHtml(c.result)}</td>
      <td>${c.pass ? '<span class="vd sig">pass</span>' : '<span class="vd none">review</span>'}</td>
    </tr>`).join('');

  const sect = r.sectors.map(s => `
    <tr>
      <td class="hr-idx">${escHtml(s.sector)}</td>
      <td>${s.in_plan.toLocaleString()}</td>
      <td>${s.funded.toLocaleString()}</td>
      <td>${s.funded_pct.toFixed(1)}%</td>
      <td>${s.share_plan.toFixed(1)}%</td>
      <td>${s.share_funded.toFixed(1)}%</td>
      <td>${(s.share_funded - s.share_plan >= 0 ? '+' : '') + (s.share_funded - s.share_plan).toFixed(1)} pts</td>
    </tr>`).join('');

  document.getElementById('verifyPanel').innerHTML = `
    ${verifyTabs()}
    <div class="card">
      <div class="card-hdr"><div class="card-title">Automated integrity checks · ${city}</div>
        <div class="card-meta">${r.funded.toLocaleString()} funded of ${r.candidates.toLocaleString()} candidates</div></div>
      <p class="stat-lede">These checks cover <b>every</b> funded project. They establish mechanical
      facts — traceability to the source plan, budget compliance, arithmetic consistency — and do not
      substitute for the reviewer's judgement below.</p>
      <div class="stat-table-wrap"><table class="hist-table">
        <thead><tr><th>Check</th><th>Result</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-hdr"><div class="card-title">Budget utilization by sector</div>
        <div class="card-meta">₱${r.total_cost.toLocaleString(undefined,{maximumFractionDigits:0})} of
          ₱${r.budget.toLocaleString(undefined,{maximumFractionDigits:0})}
          (${(r.total_cost / r.budget * 100).toFixed(1)}% of the ceiling)</div></div>
      <p class="stat-lede">Where the funded budget actually went. Read alongside the sector shares
      below: a sector can hold many projects yet little spend, or few projects yet a large share.</p>
      ${svgSectorSpend(spendRows(r), 720, 0)}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-hdr"><div class="card-title">Sector alignment with the published plan</div></div>
      <p class="stat-lede">Compares each sector's share of the candidate plan with its share of the
      funded set. A small difference indicates the allocation broadly reflects the local government's
      own distribution of projects.</p>
      <div class="stat-table-wrap"><table class="hist-table">
        <thead><tr><th>Sector</th><th>In plan</th><th>Funded</th><th>% of sector</th>
        <th>Share of plan</th><th>Share of funded</th><th>Difference</th></tr></thead>
        <tbody>${sect}</tbody></table></div>
    </div>`;
}

/* Keeps a visible count of saved entries, so it is obvious whether anything
   will reach the export. */
/* Comparative review across the two datasets, built from the allocations
   recorded so far in this session. */
let ALLOC_SUMMARY = {};

function renderCompare() {
  const keys = Object.keys(ALLOC_SUMMARY).filter(k => !isRunning(k));
  const el = document.getElementById('comparePanel');
  const both = new Set([...Object.keys(ALLOC_SUMMARY), ...runningCities()]).size >= 2;
  if (keys.length < 2 && both && runningCities().length) {
    el.innerHTML = runningNotice('The comparative review appears here'); return;
  }
  if (keys.length < 2) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <p>Both datasets needed.</p>
      <p class="es-sub">Run an allocation on Pasig and on Quezon City at the same budget,
      then the scaling comparison appears here.</p></div></div>`;
    return;
  }
  const row = (k) => {
    const a = ALLOC_SUMMARY[k];
    return `<tr>
      <td class="hr-idx">${escHtml(a.name)}</td>
      <td>${a.candidates.toLocaleString()}</td>
      <td>${a.funded.toLocaleString()}</td>
      <td>${(a.funded/a.candidates*100).toFixed(1)}%</td>
      <td>₱${a.budget.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td>₱${a.cost.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td>${a.benefit.toLocaleString(undefined,{maximumFractionDigits:2})}</td>
      <td>${a.perM.toFixed(2)}</td></tr>`;
  };
  el.innerHTML = `
    <div class="card">
      <div class="card-hdr"><div class="card-title">Small vs. large dataset</div></div>
      <p class="stat-lede">How the allocation behaves as the candidate pool grows. Compare at the
      same budget, or at the same proportion of each city's plan — and state which in your write-up.</p>
      <div class="stat-table-wrap"><table class="hist-table">
        <thead><tr><th>Dataset</th><th>Candidates</th><th>Funded</th><th>% funded</th>
        <th>Budget</th><th>Spent</th><th>Total benefit</th><th>Benefit per ₱1M</th></tr></thead>
        <tbody>${keys.map(row).join('')}</tbody></table></div>
    </div>`;
}


/* Records the most recent allocation so the verification phase has something
   to check, and keeps one summary per dataset for the scaling comparison. */
let LAST_RUN = null;

function captureAllocation(data, candidateIdx) {
  // Prefer the hybrid's allocation when present; both are exact, so the
  // selections agree, but the hybrid is the proposed model.
  const r = data.results.find(x => x.algo === 'ga') || data.results[0];
  if (!r) return;

  // Move the funded list to this city only if it had nothing to show;
  // otherwise stay on the city being reviewed.
  const cur = FUNDED_STATE.ds;
  if (!cur || cur === data.ds || isRunning(cur)) FUNDED_STATE.ds = data.ds;
  LAST_RUN = {
    ds: data.ds, budget: data.budget,
    selected: candidateIdx, funded: r.selected, algo: r.label,
    t: Date.now(),
  };
  RUNS_BY_DS[data.ds] = LAST_RUN;

  const items = data.selected_items || [];
  const cost = r.selected.reduce((t, i) => t + (items[i] ? Number(items[i].cost) : 0), 0);
  ALLOC_SUMMARY[data.ds] = {
    name: data.ds === 'pasig' ? 'Pasig City (small)' : 'Quezon City (large)',
    candidates: candidateIdx.length, funded: r.selected.length,
    budget: data.budget, cost, benefit: r.total_benefit,
    perM: cost ? r.total_benefit / (cost / 1e6) : 0,
  };
}

/* ── Funded project browser ───────────────────────────────────────────────
   The complete allocation for each city, paged on the server because a
   Quezon City run can exceed 25,000 projects. This is the same list the
   export contains; the manual review itself is done in Excel, where the
   funded sheets carry Reviewer verdict and note columns. */
let FUNDED_STATE = { ds: null, algo: null, page: 1, q: '', sector: 'All', sort: 'benefit' };
let FUNDED_DATA = null;
let FUNDED_SEQ = 0;   // ignores replies to requests that were superseded

// Shown in place of a panel when the only results it could show belong to a
// city that is still running.
function runningNotice(what) {
  return `<div class="card"><div class="empty-state">
    <p>${pendingSentence()}.</p>
    <p class="es-sub">${what} once every algorithm has finished.</p>
  </div></div>`;
}

// A one-line note above finished results while another city is running.
function runningBanner(text) {
  if (!runningCities().length) return '';
  return `<div class="banner run">${pendingSentence()}. ${text}</div>`;
}

// Re-draws Verification & Review if it is open; otherwise it is drawn
// fresh when the page is opened.
function refreshReview() {
  const page = document.getElementById('page-review');
  if (page && page.style.display === 'block') loadReview();
}

async function fetchFunded() {
  const qs = new URLSearchParams({
    ds: FUNDED_STATE.ds || 'pasig', algo: FUNDED_STATE.algo || 'ga',
    page: FUNDED_STATE.page, q: FUNDED_STATE.q,
    sector: FUNDED_STATE.sector, sort: FUNDED_STATE.sort,
    session: SESSION_ID,
  });
  const resp = await fetch('/api/funded?' + qs.toString());
  return resp.json();
}

async function loadFunded(reset) {
  if (reset) FUNDED_STATE.page = 1;
  const seq = ++FUNDED_SEQ;
  // A city that is still running is left out entirely.
  const shown = d => d.available.filter(a => !isRunning(a.ds));
  try {
    let data = await fetchFunded();
    if (seq !== FUNDED_SEQ) return;
    data.available = shown(data);

    // Only cities/algorithms that were actually run in this session are
    // offered. If the current pick is not one of them (nothing picked yet, or
    // the history was cleared), move to one that is, preferring the same city.
    const has = data.available.some(a => a.ds === FUNDED_STATE.ds && a.algo === FUNDED_STATE.algo);
    if (!has && data.available.length) {
      const pick = data.available.find(a => a.ds === FUNDED_STATE.ds) || data.available[0];
      FUNDED_STATE.ds = pick.ds; FUNDED_STATE.algo = pick.algo;
      FUNDED_STATE.page = 1; FUNDED_STATE.sector = 'All'; FUNDED_STATE.q = '';
      data = await fetchFunded();
      if (seq !== FUNDED_SEQ) return;
      data.available = shown(data);
    }
    if (!data.available.length) { FUNDED_STATE.ds = null; FUNDED_STATE.algo = null; }

    FUNDED_DATA = data;
    renderFunded();
  } catch (err) { /* non-fatal */ }
}

function fundedPick(ds, algo) {
  FUNDED_STATE.ds = ds; FUNDED_STATE.algo = algo; loadFunded(true);
}
function fundedPage(p) { FUNDED_STATE.page = p; loadFunded(false); }
function fundedSort(v) { FUNDED_STATE.sort = v; loadFunded(true); }
function fundedSector(v) { FUNDED_STATE.sector = v; loadFunded(true); }
function fundedSearch(v) { FUNDED_STATE.q = v; loadFunded(true); }

function renderFunded() {
  const el = document.getElementById('fundedPanel');
  if (!el) return;

  const d = FUNDED_DATA;

  if ((!d || !d.available.length) && runningCities().length) {
    el.innerHTML = runningNotice('The funded projects appear here'); return;
  }
  if (!d || !d.available.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <p>No allocation yet.</p>
      <p class="es-sub">Run the algorithms on a dataset and the funded projects appear here.</p>
    </div></div>`;
    return;
  }

  // One row per city, one column per algorithm (KB left, KBG right), so the
  // choices line up and fill the width instead of wrapping unevenly.
  const ALGO_ORDER = ['bnb', 'ga'];
  const picks = ['pasig', 'qc']
    .filter(ds => d.available.some(a => a.ds === ds))
    .map(ds => {
      const first = d.available.find(a => a.ds === ds);
      const m = /^(.*?)\s*\((.*)\)$/.exec(first.ds_name) || [null, first.ds_name, ''];
      const cells = ALGO_ORDER.map(algo => {
        const a = d.available.find(x => x.ds === ds && x.algo === algo);
        if (!a) return '<span class="fd-cell-empty"></span>';
        const on = a.ds === d.ds && a.algo === d.algo;
        return `
          <button class="fd-pick ${on ? 'on' : ''}" aria-pressed="${on}"
                  onclick="fundedPick('${a.ds}','${a.algo}')">
            <span>${escHtml(a.algo_name)}</span>
            <span class="fd-n">${a.count.toLocaleString()}</span>
          </button>`;
      }).join('');
      return `
        <div class="fd-row">
          <div class="fd-city">${escHtml(m[1])}${m[2] ? `<span class="fd-size">${escHtml(m[2])}</span>` : ''}</div>
          ${cells}
        </div>`;
    }).join('');

  const opts = ['All', ...d.sectors].map(s =>
    `<option value="${escHtml(s)}" ${s === FUNDED_STATE.sector ? 'selected' : ''}>${escHtml(s)}</option>`).join('');

  const rows = d.rows.map(r => `
    <tr>
      <td class="hr-idx">${escHtml(r.code)}</td>
      <td style="text-align:left;white-space:normal;max-width:380px">${escHtml(r.name.slice(0,150))}</td>
      <td style="text-align:left">${escHtml(r.pmo)}</td>
      <td>${escHtml(r.sector)}</td>
      <td>₱${r.cost.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td>${r.benefit.toFixed(3)}</td>
      <td>${r.ratio === null ? '—' : r.ratio.toLocaleString(undefined,{maximumFractionDigits:2})}</td>
    </tr>`).join('');

  // Compact pager: first, a window around the current page, last.
  const P = d.pages, cur = d.page;
  const want = new Set([1, P, cur, cur-1, cur+1, cur-2, cur+2]);
  const nums = [...want].filter(n => n >= 1 && n <= P).sort((a,b)=>a-b);
  let pager = '', prev = 0;
  for (const n of nums) {
    if (prev && n - prev > 1) pager += `<span class="pg-gap">…</span>`;
    pager += `<button class="pg-btn ${n===cur?'on':''}" onclick="fundedPage(${n})">${n}</button>`;
    prev = n;
  }

  el.innerHTML = `
    ${runningBanner('Its funded projects appear here when it finishes.')}
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">Funded projects</div>
        <div class="card-meta">budget ₱${d.budget.toLocaleString(undefined,{maximumFractionDigits:0})}</div>
      </div>
      <div class="fd-matrix" role="group" aria-label="Choose a city and algorithm">${picks}</div>

      <div class="fd-controls">
        <input class="fd-search" placeholder="Search project, office or code…"
               value="${escHtml(FUNDED_STATE.q)}"
               oninput="clearTimeout(window._fdT);window._fdT=setTimeout(()=>fundedSearch(this.value),300)">
        <select class="fd-sel" onchange="fundedSector(this.value)">${opts}</select>
        <select class="fd-sel" onchange="fundedSort(this.value)">
          <option value="benefit" ${FUNDED_STATE.sort==='benefit'?'selected':''}>Highest benefit</option>
          <option value="cost"    ${FUNDED_STATE.sort==='cost'?'selected':''}>Highest cost</option>
          <option value="ratio"   ${FUNDED_STATE.sort==='ratio'?'selected':''}>Best benefit per ₱1M</option>
          <option value="name"    ${FUNDED_STATE.sort==='name'?'selected':''}>Project name</option>
        </select>
        <span class="fd-count">${d.total.toLocaleString()} project${d.total===1?'':'s'}
          · ₱${d.sum_cost.toLocaleString(undefined,{maximumFractionDigits:0})}
          · benefit ${d.sum_benefit.toLocaleString(undefined,{maximumFractionDigits:2})}</span>
      </div>

      <div class="stat-table-wrap" style="max-height:520px">
        <table class="hist-table">
          <thead><tr>
            <th>Code</th><th style="text-align:left">Project / program</th>
            <th style="text-align:left">Implementing office</th><th>Sector</th>
            <th>Cost</th><th>Benefit</th><th>per ₱1M</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:18px">No projects match.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="fd-pager">
        <span class="fd-pageinfo">Page ${cur} of ${P}</span>
        <div class="fd-pagebtns">
          <button class="pg-btn" ${cur<=1?'disabled':''} onclick="fundedPage(${cur-1})">←</button>
          ${pager}
          <button class="pg-btn" ${cur>=P?'disabled':''} onclick="fundedPage(${cur+1})">→</button>
        </div>
      </div>
    </div>`;
}

/* ── Charts ───────────────────────────────────────────────────────────────
   Drawn as inline SVG so the tool keeps no charting dependency. Both use the
   same palette as the rest of the interface. */

function svgConvergence(series, w, h) {
  if (!series || series.length < 2) return '';
  const pad = { l: 58, r: 14, t: 14, b: 30 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const lo = Math.min(...series), hi = Math.max(...series);
  const span = (hi - lo) || Math.max(hi * 0.001, 1);
  const y0 = lo - span * 0.15, y1 = hi + span * 0.15;
  const X = i => pad.l + (series.length === 1 ? 0 : (i / (series.length - 1)) * iw);
  const Y = v => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = y0 + (y1 - y0) * f, y = Y(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}"
             stroke="rgba(4,41,46,.10)" stroke-width="1"/>
            <text x="${pad.l - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
             font-family="'Space Mono',monospace" font-size="9" fill="#5A7478">${v.toFixed(1)}</text>`;
  }).join('');

  const pts = series.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${pad.l},${pad.t + ih} ${pts} ${X(series.length - 1).toFixed(1)},${pad.t + ih}`;
  const dots = series.map((v, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.6" fill="#0B6B4F"/>`).join('');

  const ticks = series.map((_, i) => i)
    .filter(i => i === 0 || i === series.length - 1 || i % Math.ceil(series.length / 6) === 0)
    .map(i => `<text x="${X(i).toFixed(1)}" y="${h - 9}" text-anchor="middle"
        font-family="'Space Mono',monospace" font-size="9" fill="#5A7478">${i}</text>`).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
            aria-label="Best fitness by generation">
    ${grid}
    <polygon points="${area}" fill="rgba(11,107,79,.10)"/>
    <polyline points="${pts}" fill="none" stroke="#0B6B4F" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${ticks}
    <text x="${pad.l + iw / 2}" y="${h - 0.5}" text-anchor="middle"
      font-family="'Work Sans',sans-serif" font-size="9.5" fill="#5A7478">generation</text>
  </svg>`;
}

function svgSectorSpend(rows, w, h) {
  if (!rows || !rows.length) return '';
  const pad = { l: 132, r: 62, t: 8, b: 8 };
  const barH = 20, gap = 9;
  const H = pad.t + rows.length * (barH + gap) + pad.b;
  const iw = w - pad.l - pad.r;
  const max = Math.max(...rows.map(r => r.cost)) || 1;

  const bars = rows.map((r, i) => {
    const y = pad.t + i * (barH + gap);
    const bw = Math.max(1, (r.cost / max) * iw);
    return `
      <text x="${pad.l - 9}" y="${y + barH * 0.72}" text-anchor="end"
        font-family="'Work Sans',sans-serif" font-size="10.5" fill="#2A4045">${escHtml(r.sector)}</text>
      <rect x="${pad.l}" y="${y}" width="${iw}" height="${barH}" rx="4" fill="rgba(4,41,46,.06)"/>
      <rect x="${pad.l}" y="${y}" width="${bw.toFixed(1)}" height="${barH}" rx="4" fill="#0B6B4F" opacity="0.85"/>
      <text x="${pad.l + iw + 7}" y="${y + barH * 0.72}"
        font-family="'Space Mono',monospace" font-size="9.5" fill="#2A4045">${r.label}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${H}" width="100%" height="${H}" role="img"
            aria-label="Budget spent by sector">${bars}</svg>`;
}


/* Convergence of the genetic phase: best fitness after each generation. */
function convergenceBlock(data) {
  const ga = (data.results || []).find(r => r.convergence && r.convergence.length > 1);
  if (!ga) return '';
  const c = ga.convergence;
  const start = c[0], end = c[c.length - 1];
  const gain = end - start;
  const plateau = c.findIndex(v => v >= end - 1e-9);

  return `
    <div class="chart-block">
      <div class="chart-hdr">
        <span class="chart-title">Convergence of the genetic phase</span>
        <span class="chart-meta">${c.length - 1} generations run</span>
      </div>
      <p class="chart-lede">Best fitness held by the GA after each generation. Generation 0 is the
      seeded population, so the curve shows whether evolution improved on what the GA started with.</p>
      ${svgConvergence(c, 720, 210)}
      <div class="chart-facts">
        <div><span class="cf-l">starting fitness</span><span class="cf-v">${start.toFixed(3)}</span></div>
        <div><span class="cf-l">final fitness</span><span class="cf-v">${end.toFixed(3)}</span></div>
        <div><span class="cf-l">improvement</span><span class="cf-v ${gain > 0 ? 'up' : ''}">${gain > 0 ? '+' : ''}${gain.toFixed(3)}</span></div>
        <div><span class="cf-l">reached best at</span><span class="cf-v">generation ${plateau < 0 ? '—' : plateau}</span></div>
      </div>
      ${gain <= 1e-9 ? `<div class="msg warn" style="margin-top:12px"><span class="msg-icon">!</span>
        <span>The GA did not improve on its seeded population. Its solution equals the greedy
        solution, which branch-and-bound can obtain on its own.</span></div>` : ''}
    </div>`;
}


/* Spend per sector for the funded allocation, largest first. */
function spendRows(r) {
  const rows = (r.sectors || [])
    .filter(s => s.funded_cost > 0)
    .map(s => ({
      sector: s.sector, cost: s.funded_cost,
      label: '₱' + (s.funded_cost >= 1e9
        ? (s.funded_cost / 1e9).toFixed(2) + 'B'
        : (s.funded_cost / 1e6).toFixed(1) + 'M'),
    }));
  rows.sort((a, b) => b.cost - a.cost);
  return rows;
}
