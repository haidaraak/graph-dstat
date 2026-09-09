/* Harness: loads the REAL l7-firewall-graph.html in jsdom and drives it with
   the real captured stub_status bodies. Nothing here re-implements app logic. */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const FILE = process.argv[2] || "/home/user/graph-dstat/l7-firewall-graph.html";
const html = fs.readFileSync(FILE, "utf8");

/* ---- real bodies captured from graph.vshield.pro ---- */
const BODY_A = "Active connections: 141 \nserver accepts handled requests\n 464546603 464546603 3173921738 \nReading: 0 Writing: 1 Waiting: 140 \n";
const BODY_B = "Active connections: 140 \nserver accepts handled requests\n 464546834 464546834 3173924588 \nReading: 0 Writing: 3 Waiting: 137 \n";

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });
}

/* ---------------- recording canvas 2D context ---------------- */
function makeCtx(canvas) {
  const calls = { total: 0, kinds: {} };
  const grad = { addColorStop() {} };
  const impl = {
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: (t) => ({ width: String(t).length * 6 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setTransform() {}, resetTransform() {},
  };
  const ctx = new Proxy(impl, {
    get(t, k) {
      if (k === "__calls") return calls;
      if (k === "canvas") return canvas;
      if (k in t) return t[k];
      calls.total++;
      calls.kinds[k] = (calls.kinds[k] || 0) + 1;
      return () => {};
    },
    set() { return true; },
  });
  return ctx;
}

const vc = new VirtualConsole();
const jsdomErrors = [];
vc.on("jsdomError", (e) => jsdomErrors.push(e.message));
vc.on("error", (...a) => jsdomErrors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,          // gives us requestAnimationFrame
  url: "https://example.test/",
  virtualConsole: vc,
  beforeParse(window) {
    /* jsdom has no layout engine: clientWidth/Height are always 0, which makes
       every chart bail out on its `pw < 40` guard. Give them real geometry. */
    const WW = { cvMain: 1200, cvHeat: 1200, cvSpark: 180, cvRps: 380, cvCps: 380, cvDrop: 380, cvGauge: 132 };
    const HH = { cvMain: 340, cvHeat: 34, cvSpark: 30, cvRps: 78, cvCps: 78, cvDrop: 78, cvGauge: 132 };
    const sizeFor = (el, map, dflt) => {
      let id = el.id;
      if (!id && el.querySelector) { const c = el.querySelector("canvas"); if (c) id = c.id; }
      return map[id] || dflt;
    };
    Object.defineProperty(window.Element.prototype, "clientWidth",
      { configurable: true, get() { return sizeFor(this, WW, 800); } });
    Object.defineProperty(window.Element.prototype, "clientHeight",
      { configurable: true, get() { return sizeFor(this, HH, 300); } });

    /* polyfills jsdom lacks */
    window.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([], this); }
      unobserve() {} disconnect() {}
    };
    window.HTMLCanvasElement.prototype.getContext = function () {
      if (!this.__ctx) this.__ctx = makeCtx(this);
      return this.__ctx;
    };
    window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob(["png"])); };

    /* jsdom's Blob gained .text() only in v30, and older builds do not expose the
       payload at all. Record the parts ourselves: this still exercises the real
       string-building inside exportCsv. Version-independent. */
    window.Blob = class {
      constructor(parts, opts) { this.parts = parts || []; this.type = (opts && opts.type) || ""; }
      get size() { return this.parts.join("").length; }
      text() { return Promise.resolve(this.parts.join("")); }
    };

    let lastBlob = null;
    window.__lastBlob = () => lastBlob;
    window.URL.createObjectURL = (b) => { lastBlob = b; return "blob:stub"; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};

    /* ---- fetch stub: counts calls, serves real bodies ---- */
    window.__reqs = [];
    window.__failNext = 0;
    window.fetch = async (url, opts) => {
      window.__reqs.push({ url: String(url), t: Date.now() });
      if (window.__failNext > 0) { window.__failNext--; throw new TypeError("CORS blocked"); }
      const n = window.__reqs.length;
      return {
        ok: true, status: 200,
        text: async () => (n % 2 ? BODY_A : BODY_B),
      };
    };

    /* seed settings so the poll cadence is testable */
    window.localStorage.setItem("vshield.l7.cfg.v1", JSON.stringify({
      endpoint: "https://graph.vshield.pro/7VTnnXWvhdVeUC6q",
      interval: 200, window: 60, transport: "direct",
      capacity: 512, alert: 0, reduceMotion: true, sound: false,
    }));
  },
});

const win = dom.window;
const ev = (sel) => win.eval(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(400);
  const doc = win.document;
  /* speed the cadence up through the app's own state object */
  win.eval("CFG.interval = 25; nextAt = performance.now() + 25; schedule();");

  await sleep(2500); // ~90 samples at 25ms

  /* ---------------- 1. parser ---------------- */
  const pA = win.eval("JSON.stringify(parseStubStatus(" + JSON.stringify(BODY_A) + "))");
  const parsedA = JSON.parse(pA);
  check("parser: active", parsedA.active === 141, "got " + parsedA.active);
  check("parser: accepts/handled/requests", parsedA.accepts === 464546603 && parsedA.handled === 464546603 && parsedA.requests === 3173921738,
    [parsedA.accepts, parsedA.handled, parsedA.requests].join("/"));
  check("parser: reading/writing/waiting", parsedA.reading === 0 && parsedA.writing === 1 && parsedA.waiting === 140,
    [parsedA.reading, parsedA.writing, parsedA.waiting].join("/"));
  check("parser: active === r+w+w invariant", parsedA.reading + parsedA.writing + parsedA.waiting === parsedA.active,
    parsedA.reading + parsedA.writing + parsedA.waiting + " vs " + parsedA.active);

  let threw = false;
  try { win.eval("parseStubStatus('<html>502 bad gateway</html>')"); } catch (e) { threw = true; }
  check("parser: rejects non-stub_status body", threw);

  /* ---------------- 2. live polling + cache buster ---------------- */
  const reqs = win.__reqs;
  check("polling: multiple requests issued", reqs.length >= 20, reqs.length + " requests");
  const urls = reqs.map((r) => r.url);
  const busts = urls.map((u) => (/[_=](\d+)$/.exec(u) || [])[1]).filter(Boolean);
  check("polling: every URL carries a ?_= cache-buster", busts.length === urls.length, busts.length + "/" + urls.length);
  const uniq = new Set(busts);
  check("polling: cache-busters are unique (no stale reads)", uniq.size === busts.length, uniq.size + " unique of " + busts.length);
  check("polling: hits the right endpoint", urls.every((u) => u.startsWith("https://graph.vshield.pro/7VTnnXWvhdVeUC6q?_=")), urls[0]);

  /* ---------------- 3. rolling window ---------------- */
  const bufLen = win.eval("S.samples.length");
  const winLen = win.eval("windowSamples().length");
  const cap = win.eval("BUFFER_SEC");
  check("buffer: samples accumulated", bufLen > 20, bufLen + " samples");
  check("buffer: capped at BUFFER_SEC (" + cap + ")", bufLen <= cap, bufLen + " <= " + cap);

  /* prove the oldest really is dropped: inject 1000 samples via the app's own ingest() */
  win.eval("S.samples.length = 0; S.last=null; S.lastT=0;");
  win.eval(`(function(){
    let t = Date.now() - 200000;
    for (let i=0;i<1000;i++){
      t += 1000;
      ingest({active:1000+i, reading:1, writing:2, waiting:997+i,
              accepts:1000+i*3, handled:1000+i*3, requests:50000+i*40}, t);
    }
  })()`);
  const after = win.eval("S.samples.length");
  check("rolling window: oldest dropped when over capacity", after === cap, after + " (expected " + cap + ")");
  const headIdx = win.eval("S.samples[0].active - 1000");
  const tailIdx = win.eval("S.samples[S.samples.length-1].active - 1000");
  check("rolling window: retained samples are exactly the newest " + cap,
    headIdx === 1000 - cap && tailIdx === 999, "kept i=" + headIdx + ".." + tailIdx + " of 0..999");
  const span = win.eval("(S.samples[S.samples.length-1].t - S.samples[0].t)/1000");
  check("rolling window: retained span is " + (cap - 1) + "s at 1s cadence", Math.abs(span - (cap - 1)) < 0.001, span + "s");

  /* restore a 60s worth of realistic samples for the render assertions */
  win.eval("S.samples.length = 0; S.last=null; S.lastT=0;");
  win.eval(`(function(){
    let t = Date.now() - 61000, a=464546603, r=3173921738;
    for (let i=0;i<62;i++){
      t += 1000; a += 3; r += 80;
      ingest({active:141+(i%9)-4, reading:i%3===0?1:0, writing:1+(i%4), waiting:141+(i%9)-4-1-(i%4)-(i%3===0?1:0),
              accepts:a, handled:a, requests:r}, t);
    }
  })()`);
  const inWindow = win.eval("windowSamples().length");
  check("rolling window: 60s view holds ~60 samples", inWindow >= 59 && inWindow <= 62, inWindow + " in view");

  /* ---------------- 4. derived rates ---------------- */
  const lastS = JSON.parse(win.eval("JSON.stringify(S.samples[S.samples.length-1])"));
  check("rates: d_requests === 80 per second", lastS.dReq === 80, "dReq=" + lastS.dReq);
  check("rates: rps === 80", Math.abs(lastS.rps - 80) < 0.01, "rps=" + lastS.rps);
  check("rates: cps === 3", Math.abs(lastS.cps - 3) < 0.01, "cps=" + lastS.cps);
  check("rates: dropped === 0 when accepts===handled", lastS.drop === 0, "drop=" + lastS.drop);

  /* drop accounting: accepts outruns handled */
  win.eval(`(function(){
    const p=S.last;
    ingest({active:150,reading:0,writing:5,waiting:145,
            accepts:p.accepts+10, handled:p.handled+7, requests:p.requests+100}, Date.now());
  })()`);
  const d1 = win.eval("S.samples[S.samples.length-1].drop");
  check("rates: dropped = accepts-handled = 3", d1 === 3, "drop=" + d1);
  check("session: drops accumulated", win.eval("S.drops") >= 3, win.eval("S.drops"));

  check("dom: total requests SI-formatted (3.17B)", /^3\.17B$/.test(doc.getElementById("kTotal").textContent), "'" + doc.getElementById("kTotal").textContent + "'");
  check("dom: accepts SI-formatted (464.55M)", /^464\.5[0-9]M$/.test(doc.getElementById("kAccepts").textContent.replace("accepts ","")), "'" + doc.getElementById("kAccepts").textContent + "'");
  check("dom: requests/s KPI populated", doc.getElementById("kRps").textContent !== "0", "'" + doc.getElementById("kRps").textContent + "'");
  check("dom: req/conn ratio ~6.83 like the live feed", /^6\.8[0-9] req\/conn$/.test(doc.getElementById("kRatio").textContent), doc.getElementById("kRatio").textContent);

  /* counter reset must not produce a negative/absurd rate */
  win.eval(`(function(){
    ingest({active:140,reading:0,writing:2,waiting:138, accepts:10, handled:10, requests:10}, Date.now());
  })()`);
  const afterReset = JSON.parse(win.eval("JSON.stringify(S.samples[S.samples.length-1])"));
  check("resilience: counter reset yields 0 delta, not negative", afterReset.dReq === 0 && afterReset.dAccepts === 0,
    "dReq=" + afterReset.dReq + " dAccepts=" + afterReset.dAccepts);
  check("resilience: reset logged", /counter reset/i.test(win.document.getElementById("log").textContent));

  /* monotonic timestamps despite a late reply */
  win.eval(`(function(){ const p=S.last;
    ingest({active:140,reading:0,writing:2,waiting:138, accepts:p.accepts,handled:p.handled,requests:p.requests}, Date.now()-5000);
  })()`);
  const mono = win.eval("S.samples[S.samples.length-1].t > S.samples[S.samples.length-2].t");
  check("resilience: late reply does not rewind the timeline", mono);

  /* ---------------- 5. rendering actually executed ---------------- */
  const mainCalls = win.document.getElementById("cvMain").__ctx.__calls;
  const heatCalls = win.document.getElementById("cvHeat").__ctx.__calls;
  const gaugeCalls = win.document.getElementById("cvGauge").__ctx.__calls;
  check("render: drawMain issued canvas ops", mainCalls.total > 200, mainCalls.total + " ops");
  check("render: main chart drew filled areas", (mainCalls.kinds.fill || 0) > 3, (mainCalls.kinds.fill || 0) + " fills");
  check("render: main chart stroked the series edges", (mainCalls.kinds.stroke || 0) > 3, (mainCalls.kinds.stroke || 0) + " strokes");
  check("render: heat strip drew cells", heatCalls.total > 40, heatCalls.total + " ops");
  check("render: gauge drew its arc", (gaugeCalls.kinds.arc || 0) >= 3, (gaugeCalls.kinds.arc || 0) + " arcs");
  const sparkCalls = win.document.getElementById("cvSpark").__ctx.__calls;
  check("render: KPI sparkline drew", sparkCalls.total > 5, sparkCalls.total + " ops");
  for (const id of ["cvRps", "cvCps", "cvDrop"]) {
    const c = win.document.getElementById(id).__ctx.__calls;
    check("render: " + id + " drew", c.total > 20, c.total + " ops");
  }

  /* ---------------- 6. DOM reflects data ---------------- */
  check("dom: ACTIVE KPI populated", doc.getElementById("kActive").textContent !== "0", "'" + doc.getElementById("kActive").textContent + "'");
  check("dom: sample counter > 0", parseInt(doc.getElementById("mSamples").textContent.replace(/,/g, ""), 10) > 0, doc.getElementById("mSamples").textContent);
  check("dom: event log has entries", doc.getElementById("log").childElementCount > 0, doc.getElementById("log").childElementCount + " entries");
  check("dom: status pill set", ["LIVE", "DEMO", "PAUSED", "RETRYING"].includes(doc.getElementById("statusTxt").textContent), doc.getElementById("statusTxt").textContent);

  /* ---------------- 6b. hover / tooltip ---------------- */
  win.eval("CFG.transport='direct'; setWindow(60,true);");
  win.eval(`(function(){
    S.running=false; clearTimeout(pollTimer);
    S.samples.length=0; S.last=null; S.lastT=0;
    let t=Date.now()-61000, a=464546603, r=3173921738;
    for(let i=0;i<62;i++){ t+=1000; a+=3; r+=80;
      ingest({active:141+(i%9)-4,reading:0,writing:2,waiting:139+(i%9)-4,accepts:a,handled:a,requests:r},t); }
  })()`);
  const tipEl = doc.getElementById("tip");
  win.eval(`(function(){
    const r = cvMain.getBoundingClientRect();
    onMove({ clientX: r.left + 52 + (cvMain._w - 68) * 0.5, clientY: r.top + 100 });
  })()`);
  check("tooltip: shown on hover", tipEl.classList.contains("on"), "class=" + tipEl.className);
  check("tooltip: reports the hovered second's active count", /active/.test(tipEl.textContent) && /\d/.test(tipEl.textContent),
    tipEl.textContent.replace(/\s+/g, " ").slice(0, 70));
  check("tooltip: shows req/s and conn/s series", /req\/s/.test(tipEl.textContent) && /conn\/s/.test(tipEl.textContent));
  win.eval("clearHover()");
  check("tooltip: hides on mouseleave", !tipEl.classList.contains("on"));
  win.eval("S.running = true; nextAt = performance.now() + 25; schedule();");

  /* ---------------- 7. gap detection ---------------- */
  win.eval(`(function(){ const p=S.last;
    ingest({active:140,reading:0,writing:2,waiting:138, accepts:p.accepts,handled:p.handled,requests:p.requests}, Date.now()+9000);
  })()`);
  check("gaps: detected and flagged", win.eval("S.samples[S.samples.length-1].gap") === true);
  check("gaps: counter incremented", win.eval("S.gaps") >= 1, win.eval("S.gaps"));

  /* ---------------- 8. CSV export ---------------- */
  win.eval("S.running = false; clearTimeout(pollTimer); exportCsv();");
  const csvExpect = win.eval("S.samples.length");
  await sleep(60);
  const blob = win.__lastBlob();
  check("export: CSV blob produced", !!blob, blob ? blob.type : "none");
  if (blob) {
    const txt = await blob.text();
    const lines = txt.trim().split("\n");
    check("export: CSV header present", lines[0].startsWith("unix_ms,utc,active,reading,writing,waiting,accepts,handled,requests"),
      lines[0].slice(0, 60));
    check("export: CSV row count matches buffer", lines.length - 1 === csvExpect,
      (lines.length - 1) + " rows vs " + csvExpect + " samples");
    const cols = lines[1].split(",");
    check("export: CSV column count matches header", cols.length === lines[0].split(",").length,
      cols.length + " vs " + lines[0].split(",").length);
  }

  /* ---------------- 9. PNG export ---------------- */
  win.eval("exportPng(); S.running = true; nextAt = performance.now() + 25; schedule();");
  await sleep(60);
  check("export: PNG path executed", !!win.__lastBlob());

  /* ---------------- 10. error / backoff path ---------------- */
  win.eval("S.errors = 0;");
  win.__failNext = 40;
  await sleep(700);
  check("errors: failures counted", win.eval("S.errors") > 0, win.eval("S.errors"));
  const st = doc.getElementById("statusTxt").textContent;
  check("errors: status reflects outage", ["RETRYING", "NO SIGNAL"].includes(st), st);
  check("errors: failure logged", /poll failed/.test(doc.getElementById("log").textContent));
  win.__failNext = 0;
  await sleep(900);
  check("errors: recovery detected", win.eval("S.errors") === 0, win.eval("S.errors"));
  check("errors: recovery logged", /feed recovered/.test(doc.getElementById("log").textContent));

  /* ---------------- 11. demo transport ---------------- */
  const before = win.eval("S.total");
  win.eval("CFG.transport='demo'; S.last=null; S.lastT=0; nextAt=performance.now()+25; schedule();");
  await sleep(600);
  const after2 = win.eval("S.total");
  check("demo: generates samples without network", after2 > before, before + " → " + after2);
  const dSamp = JSON.parse(win.eval("JSON.stringify(S.samples[S.samples.length-1])"));
  check("demo: active stays in a plausible band", dSamp.active > 20 && dSamp.active < 400, "active=" + dSamp.active);
  check("demo: r+w+w === active", dSamp.reading + dSamp.writing + dSamp.waiting === dSamp.active,
    dSamp.reading + "+" + dSamp.writing + "+" + dSamp.waiting + " vs " + dSamp.active);

  /* ---------------- 12. window switching ---------------- */
  win.eval("setWindow(30, true)");
  check("window: switches to 30s", win.eval("CFG.window") === 30, win.eval("CFG.window"));
  check("window: label updated", doc.getElementById("winLbl").textContent === "30", doc.getElementById("winLbl").textContent);
  check("window: segmented control reflects it",
    [...doc.getElementById("winSeg").children].find((b) => b.classList.contains("on")).dataset.w === "30");
  const len30 = win.eval("windowSamples().length");
  win.eval("setWindow(300, true)");
  const len300 = win.eval("windowSamples().length");
  check("window: 5m view holds more samples than 30s", len300 >= len30, len30 + " → " + len300);

  /* ---------------- 13. pause ---------------- */
  win.eval("CFG.transport='direct'; togglePause()");
  const pBefore = win.eval("S.total");
  await sleep(400);
  check("pause: stops ingesting", win.eval("S.total") === pBefore, pBefore + " → " + win.eval("S.total"));
  check("pause: status shows PAUSED", doc.getElementById("statusTxt").textContent === "PAUSED", doc.getElementById("statusTxt").textContent);
  win.eval("togglePause()");
  await sleep(400);
  check("pause: resumes ingesting", win.eval("S.total") > pBefore, pBefore + " → " + win.eval("S.total"));

  /* ---------------- 14. no uncaught errors ---------------- */
  const real = jsdomErrors.filter((m) => !/Not implemented|Could not parse CSS/i.test(m));
  check("stability: no uncaught page errors", real.length === 0, real.slice(0, 3).join(" | "));

  /* ---------------- report ---------------- */
  let pass = 0;
  console.log("");
  for (const r of results) {
    if (r.pass) pass++;
    console.log((r.pass ? "  PASS  " : "* FAIL  ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
  }
  console.log("\n  " + pass + "/" + results.length + " passed\n");
  dom.window.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
