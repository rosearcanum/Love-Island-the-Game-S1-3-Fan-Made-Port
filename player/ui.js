/* Love Island PC player — window, menus, rendering, input, audio and saves. */
(() => {
  "use strict";
  const E = window.LIEngine;
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");

  /* ------------------------------------------------------------ settings */
  const settings = Object.assign({ speed: 60, music: 60, sfx: 70, muted: false, season: null, fx: true },
    JSON.parse(localStorage.getItem("li-settings") || "{}"));
  const saveSettings = () => localStorage.setItem("li-settings", JSON.stringify(settings));

  /* ------------------------------------------------------------ storage: PC server or Android app */
  const bridge = window.LIBridge || null;   // present inside the Android app
  const api = {
    async json(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); },
    async seasons() { return bridge ? JSON.parse(bridge.seasons()) : this.json("/api/seasons"); },
    async load(season, name) {
      if (bridge) return JSON.parse(bridge.load(season, name) || "null");
      const r = await fetch(`/api/save?season=${season}&name=${encodeURIComponent(name)}`);
      return r.ok ? r.json() : null;
    },
    async save(season, name, data) {
      if (bridge) { bridge.save(season, name, JSON.stringify(data)); return; }
      await fetch(`/api/save?season=${season}&name=${encodeURIComponent(name)}`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    },
  };

  /* ------------------------------------------------------------ state */
  let seasons = [], seasonId = null, S = null, save = null, run = null, step = null, base = "";
  let typing = null, history = [], busy = false;

  /* ------------------------------------------------------------ overlays */
  const overlays = ["title", "pause", "episodes", "rel", "settings", "logview", "ask", "confirm", "epend", "custom"];
  const show = (id) => $(id).classList.remove("hidden");
  const hide = (id) => $(id).classList.add("hidden");
  const anyOverlay = () => overlays.some((o) => !$(o).classList.contains("hidden"));
  document.querySelectorAll(".overlay .close").forEach((b) => b.addEventListener("click", () => hide(b.closest(".overlay").id)));

  function confirmBox(text) {
    return new Promise((res) => {
      $("confirmText").textContent = text; show("confirm");
      const done = (v) => { hide("confirm"); $("confirmYes").onclick = $("confirmNo").onclick = null; res(v); };
      $("confirmYes").onclick = () => done(true); $("confirmNo").onclick = () => done(false);
    });
  }
  function askBox(title, def, max) {
    return new Promise((res) => {
      $("askTitle").textContent = title; const inp = $("askInput");
      inp.value = def || ""; inp.maxLength = max || 64; show("ask"); setTimeout(() => inp.focus(), 50);
      const done = () => { hide("ask"); $("askOk").onclick = null; inp.onkeydown = null; res(inp.value.trim()); };
      $("askOk").onclick = done; inp.onkeydown = (e) => { if (e.key === "Enter") done(); e.stopPropagation(); };
    });
  }

  /* ------------------------------------------------------------ boot */
  async function boot() {
    try { seasons = await api.seasons(); }
    catch (e) { $("titleInfo").textContent = "Couldn't reach the game server. Start the game with play.py."; return; }
    const tabs = $("seasonTabs"); tabs.innerHTML = "";
    if (!seasons.length) {
      $("titleInfo").textContent = bridge
        ? "No seasons found. Copy your converted data folder to: " + bridge.dataPath()
        : "No seasons found. Run extract_season.py first.";
      disableTitle(true); return;
    }
    for (const s of seasons) {
      const b = document.createElement("button");
      b.textContent = "Season " + Number(s.id.replace(/\D/g, ""));
      b.onclick = () => selectSeason(s.id);
      b.dataset.id = s.id; tabs.appendChild(b);
    }
    const pick = seasons.find((s) => s.id === settings.season) || seasons[0];
    await selectSeason(pick.id);
  }
  function disableTitle(v) { ["btnContinue", "btnNew", "btnEpisodes"].forEach((id) => ($(id).disabled = v)); }

  async function selectSeason(id) {
    if (busy) return;
    busy = true; disableTitle(true); show("loading"); $("titleInfo").textContent = "";
    document.querySelectorAll("#seasonTabs button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    try {
      seasonId = id; settings.season = id; saveSettings();
      base = `/data/${id}`;
      S = new E.Season((u) => api.json(u), base);
      await S.init();
      // Fill-in wording for lines the season files only store as keys (Season 3's AJ dates); see fill_in_lines.json.
      try { const f = await api.json("fill_in_lines.json"); if (f && f[id]) S.addTextKeys(f[id]); } catch (e) { /* none */ }
      save = (await api.load(id, "autosave")) || null;
      // Later seasons sometimes check what you did in earlier ones: load those seasons' progress too.
      S.crossSaves = [];
      for (const other of seasons) {
        if (other.id === id) continue;
        try { const sv = await api.load(other.id, "autosave"); if (sv && (sv.states || sv.deltas || sv.snapshots)) S.crossSaves.push(sv); } catch (e) { /* not played */ }
      }
      if (save) { E.repairLook(S, save); E.migrateSave(S, save); }   // repairs for saves from older versions
      updateTitleInfo();
    } catch (e) {
      console.error(e); $("titleInfo").textContent = "Couldn't load this season: " + e.message;
    } finally { hide("loading"); busy = false; }
  }
  const playable = () => S.episodes.filter((e) => !e.abAlt);
  const epLabel = (ep) => `Day ${ep.day} · Episode ${ep.ep}`;
  function nextEpisode() {
    const eps = playable();
    if (!save) return eps[0];
    if (save.current) return eps.find((e) => e.key === save.current.ep) || eps[0];
    return eps.find((e) => !save.completed.includes(e.key)) || null;
  }
  function updateTitleInfo() {
    disableTitle(false);
    const eps = playable(), nx = nextEpisode();
    $("btnContinue").disabled = !save;
    if (!save) $("titleInfo").textContent = `${eps.length} episodes · no save yet`;
    else if (!nx) $("titleInfo").textContent = `Season complete! (${save.completed.length}/${eps.length})`;
    else $("titleInfo").textContent = `${save.playerName || "You"} · up next: ${epLabel(nx)} · ${save.completed.length}/${eps.length} done`;
  }

  /* ------------------------------------------------------------ game flow */
  async function newGame() {
    if (save && !(await confirmBox("Start a new game? Your current progress in this season will be replaced."))) return;
    const name = await askBox("What's your name?", "", 20);
    save = E.newSave(seasonId); save.playerName = name || "You"; save.seen = [];
    history = [];
    await startEpisode(playable()[0], null);
  }
  async function continueGame() {
    if (!save) return newGame();
    const ep = nextEpisode();
    if (!ep) { openEpisodes(); return; }
    await startEpisode(ep, save.current && save.current.ep === ep.key ? save.current : null);
  }
  async function startEpisode(ep, snap) {
    hide("title"); hide("epend"); hide("episodes"); hide("pause");
    show("loading");
    await S.prepare(ep.controller);
    hide("loading");
    if (!snap) {
      save.current = null;
      await api.save(seasonId, "before_" + ep.key, save);   // checkpoint for replays
    }
    run = new E.Run(S, save, ep, snap);
    $("epbadge").textContent = epLabel(ep); show("epbadge"); show("hud");
    if (!snap) history.push({ kind: "ep", text: epLabel(ep) });
    next();
  }
  function next() {
    step = run.step();
    if (step.type === "end") return episodeEnd();
    render(step);
    autosave();
  }
  let saveTimer = null;
  function autosave(now) {
    clearTimeout(saveTimer);
    const doit = () => { if (!save) return; if (run && !run.done) save.current = run.snapshot(); return api.save(seasonId, "autosave", save); };
    if (now) return doit();
    saveTimer = setTimeout(doit, 700);
  }
  async function episodeEnd() {
    clearTimeout(saveTimer);
    save.current = null;
    await api.save(seasonId, "autosave", save);
    const eps = playable(), i = eps.findIndex((e) => e.key === run.ep.key), nx = eps[i + 1];
    $("ependText").textContent = nx ? `${epLabel(run.ep)} finished. Next up: ${epLabel(nx)}.` : "That's the end of the season!";
    $("eNext").classList.toggle("hidden", !nx);
    $("eNext").onclick = () => startEpisode(nx, null);
    hide("textbox"); hide("choices");
    show("epend");
  }
  async function toTitle() {
    if (run && !run.done) await autosave(true);
    run = null; step = null; stopTyping();
    hide("hud"); hide("epbadge"); hide("textbox"); hide("choices"); hide("pause");
    $("chars").innerHTML = ""; $("overflow").innerHTML = ""; charEls.clear();
    playMusic(null);
    updateTitleInfo(); show("title");
  }

  /* ------------------------------------------------------------ episodes */
  function openEpisodes() {
    const grid = $("epGrid"); grid.innerHTML = "";
    const eps = playable(), nx = nextEpisode();
    for (const ep of eps) {
      const done = save && save.completed.includes(ep.key);
      const avail = done || (nx && nx.key === ep.key) || (!save && ep === eps[0]);
      const b = document.createElement("button");
      b.className = "ep" + (done ? " done" : "") + (avail ? "" : " locked") + (nx && nx.key === ep.key ? " current" : "");
      if (ep.thumbFile) { const im = document.createElement("img"); im.loading = "lazy"; im.src = `${base}/thumbs/${ep.thumbFile}`; b.appendChild(im); }
      const l = document.createElement("div"); l.className = "lbl"; l.textContent = epLabel(ep); b.appendChild(l);
      b.onclick = async () => {
        if (!avail) return;
        if (!save) { await newGame(); return; }
        if (done) {
          if (!(await confirmBox(`Replay ${epLabel(ep)}? Your story rewinds to the start of this episode.`))) return;
          const cp = await api.load(seasonId, "before_" + ep.key);
          if (!cp) { await confirmBox("No checkpoint was saved for this episode, so it can't be replayed."); return; }
          save = cp; save.current = null;
          E.migrateSave(S, save); E.repairLook(S, save);
          history = [];
        }
        await startEpisode(ep, done ? null : (save.current && save.current.ep === ep.key ? save.current : null));
      };
      grid.appendChild(b);
    }
    show("episodes");
  }

  /* ------------------------------------------------------------ rendering */
  function render(st) {
    const v = st.view || {};
    setBg(v.bg);
    layoutChars(v, st.speaker);
    renderOverflow(v);
    if (v.toast) showToast(v.toast);
    playMusic(v.music);
    if (v.sfx) playSfx(v.sfx.file);
    if (v.effect && settings.fx !== false) playEffect(v.effect);
    trackSeen(v, st.speaker);
    hide("choices");
    if (st.type !== "openworld" && !$("mapWrap").classList.contains("hidden")) leaveMap();
    if (st.type === "line") {
      showText(st);
      history.push({ kind: st.narrator ? "narr" : "line", name: st.narrator ? "" : st.name, text: st.text });
    } else if (st.type === "choice") {
      if (st.prompt) { showText({ text: st.prompt, name: run.charName(st.speaker), narrator: !st.speaker, speaker: st.speaker }, true); history.push({ kind: st.speaker ? "line" : "narr", name: st.speaker ? run.charName(st.speaker) : "", text: st.prompt }); }
      else hide("textbox");
      showChoices(st.options.map((o) => ({ label: o.text, premium: o.premium, image: o.image, pick: () => { history.push({ kind: "pick", text: o.text }); run.choose(o); next(); } })), !st.prompt);
    } else if (st.type === "openworld") {
      showMap(st);
    } else if (st.type === "customize") {
      hide("textbox");
      openWardrobe(st);
    } else if (st.type === "name" || st.type === "text") {
      hide("textbox");
      askBox(st.title || "Enter a name:", st.type === "name" ? (save.playerName || "") : st.def, st.max).then((val) => { run.submitText(val); next(); });
    }
  }

  function setBg(file) {
    const url = file ? `${base}/backgrounds/${file}` : null;
    const layers = document.querySelectorAll(".bgl");
    const cur = [...layers].find((l) => l.classList.contains("on"));
    if (cur && cur.dataset.url === (url || "")) return;
    const nxt = cur === layers[0] ? layers[1] : layers[0];
    nxt.dataset.url = url || "";
    nxt.style.backgroundImage = url ? `url("${url}")` : "none";
    nxt.classList.add("on"); if (cur) cur.classList.remove("on");
  }

  const charEls = new Map();
  /** Height of a standing character in this season's art (Season 1 is drawn smaller). */
  function figureUnit() {
    if (S._unit) return S._unit;
    let y0 = 1e9, y1 = -1e9;
    for (const l of E.avatarLayers(S, E.newSave(seasonId), S.playerKey, null)) {
      const ty = -(1 - l.py) * l.h; y0 = Math.min(y0, ty); y1 = Math.max(y1, ty + l.h);
    }
    return (S._unit = y1 > y0 ? y1 - y0 : 980);
  }
  const classic = () => settings.layout !== "side";

  function layoutChars(v, speaker) {
    const list = [];
    for (const k of v.stage || []) if (k && !list.includes(k)) list.push(k);
    const focus = speaker || v.focus || null;
    if (focus && !list.includes(focus)) {
      if (focus === S.playerKey) list.unshift(focus); else list.push(focus);
    }
    const r = stage.getBoundingClientRect(), W = r.width, H = r.height, unit = figureUnit();
    const place = new Map();   // key -> {x, y, scale, z}
    if (H > W) {
      // Phone held upright, like the app: you up close at the bottom left, Islanders standing behind you.
      const npcs = list.filter((k) => k !== S.playerKey);
      while (npcs.length > 2) npcs.splice(npcs.findIndex((k) => k !== focus), 1);
      const xs = { 1: [0.62], 2: [0.36, 0.74] }[npcs.length] || [];
      const sN = (H * 0.72) / unit;
      npcs.forEach((k, i) => place.set(k, { x: xs[i] * W, y: H * 0.5, scale: sN, z: k === speaker ? 3 : 2 }));
      if (list.includes(S.playerKey)) place.set(S.playerKey, { x: W * 0.3, y: H * 0.98, scale: (H * 0.95) / unit, z: 5 });
    } else if (classic()) {
      // Like the app: you in the bottom-left corner up close, Islanders standing further back.
      const npcs = list.filter((k) => k !== S.playerKey);
      while (npcs.length > 3) npcs.splice(npcs.findIndex((k) => k !== focus), 1);
      const xs = { 1: [0.6], 2: [0.46, 0.76], 3: [0.37, 0.6, 0.83] }[npcs.length] || [];
      const sN = (H * 1.0) / unit;
      npcs.forEach((k, i) => place.set(k, { x: xs[i] * W, y: H * 0.5, scale: sN, z: k === speaker ? 3 : 2 }));
      if (list.includes(S.playerKey)) {
        const sP = (H * 1.55) / unit;
        place.set(S.playerKey, { x: Math.min(W * 0.15, H * 0.36), y: H * 1.12, scale: sP, z: 5 });
      }
    } else {
      while (list.length > 3) list.splice(list.findIndex((k) => k !== focus && k !== S.playerKey), 1);
      const xs = { 1: [0.5], 2: [0.3, 0.7], 3: [0.2, 0.5, 0.8] }[list.length] || [];
      list.forEach((k, i) => place.set(k, { x: xs[i] * W, y: H * 0.57, scale: (H * 1.06) / unit, z: k === speaker ? 3 : 1 }));
    }
    const box = $("chars");
    // fade out characters that left
    for (const [k, el] of charEls) {
      if (place.has(k)) continue;
      charEls.delete(k);
      el.classList.add("gone");
      setTimeout(() => el.remove(), 400);
    }
    for (const [k, p] of place) {
      let el = charEls.get(k);
      const at = `translate(${p.x}px, ${p.y}px)`;
      if (!el) {
        el = document.createElement("div"); el.className = "char gone";
        el.innerHTML = '<div class="rig"></div>'; el.style.transform = at;
        box.appendChild(el); charEls.set(k, el);
        requestAnimationFrame(() => { if (charEls.get(k) === el) el.classList.remove("gone"); });
      }
      const rig = el.firstChild;
      fillRig(rig, E.avatarLayers(S, save, k, run.view.expr[k]));
      rig.style.transform = `scale(${p.scale})`;
      el.style.transform = at;
      el.dataset.x = p.x;
      el.dataset.hy = p.y - unit * 0.42 * p.scale;          // where the face is
      el.dataset.top = p.y - unit * 0.5 * p.scale;          // top of the head
      el.dataset.player = k === S.playerKey ? "1" : "";
      const lit = speaker || (v.named ? v.focus : null);
      el.classList.toggle("dim", !!lit && k !== lit && !(classic() && k === S.playerKey));
      el.style.zIndex = p.z;
    }
  }
  const tintCache = new Map();
  /** A white sprite recoloured (used for Season 3 eyebrows, which the app tinted to match your hair). */
  function tinted(file, color) {
    const key = file + color;
    if (tintCache.has(key)) return tintCache.get(key);
    const p = new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(im, 0, 0);
        g.globalCompositeOperation = "multiply"; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = "destination-in"; g.drawImage(im, 0, 0);
        res(c.toDataURL());
      };
      im.onerror = () => res(`${base}/sprites/${file}`);
      im.src = `${base}/sprites/${file}`;
    });
    tintCache.set(key, p);
    return p;
  }
  function fillRig(rig, layers) {
    const sig = layers.map((l) => l.file + (l.tint || "")).join("|");
    if (rig.dataset.sig === sig) return;
    rig.dataset.sig = sig;
    const imgs = [], waits = [];
    for (const l of layers) {
      const im = document.createElement("img"); im.draggable = false;
      if (l.tint) waits.push(tinted(l.file, l.tint).then((u) => { im.src = u; }));
      else im.src = `${base}/sprites/${l.file}`;
      im.style.left = `${-l.px * l.w}px`; im.style.top = `${-(1 - l.py) * l.h}px`; im.width = l.w; im.height = l.h;
      imgs.push(im);
    }
    const token = (rig._tok = (rig._tok || 0) + 1);
    const swap = () => { if (rig._tok === token) rig.replaceChildren(...imgs); };
    const ready = Promise.all(waits).then(() => Promise.all(imgs.map((i) => i.decode().catch(() => {}))));
    if (!rig.firstChild) { Promise.all(waits).then(swap); return; }
    // Changing expression or outfit: keep the old picture up until the new pieces are ready (no blank faces).
    Promise.race([ready, new Promise((r) => setTimeout(r, 700))]).then(swap);
  }



  /* ------------------------------------------------------------ wardrobe: look and outfits, any time */
  const ICON = {
    clothes: '<svg viewBox="0 0 48 48"><path d="M18 5l2 7-6 10 4 4-6 17h24l-6-17 4-4-6-10 2-7M18 5c2 3 10 3 12 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
    shoes: '<svg viewBox="0 0 48 48"><path d="M6 34c8 0 14-4 20-14 2-3 5-4 7-1l4 6c1 2 4 3 6 3v6c-6 1-10 0-14-3L19 40H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M33 31l-1 10" stroke="currentColor" stroke-width="2.2"/></svg>',
    jewellery: '<svg viewBox="0 0 48 48"><path d="M8 10c2 12 8 20 16 20s14-8 16-20" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M24 30l-4 5 4 6 4-6z" fill="currentColor"/></svg>',
    outfit: '<svg viewBox="0 0 48 32"><path d="M24 9a4 4 0 1 1 4-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M24 9v3L4 27h40L24 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
    look: '<svg viewBox="0 0 48 48"><circle cx="24" cy="22" r="12" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="19.5" cy="20" r="1.6" fill="currentColor"/><circle cx="28.5" cy="20" r="1.6" fill="currentColor"/><path d="M19 27c3 3 7 3 10 0" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  };
  let wd = null;

  /** Draw sprite layers scaled to fit inside a box (used for item thumbnails). */
  function fitLayers(box, layers, pad) {
    box.innerHTML = "";
    if (!layers.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const l of layers) {
      const lx = -l.px * l.w, ty = -(1 - l.py) * l.h;
      x0 = Math.min(x0, lx); y0 = Math.min(y0, ty); x1 = Math.max(x1, lx + l.w); y1 = Math.max(y1, ty + l.h);
    }
    const W = box.clientWidth || 100, H = box.clientHeight || 130;
    const sc = Math.min(W / (x1 - x0), H / (y1 - y0)) * (pad || 0.86);
    const rig = document.createElement("div"); rig.className = "thumb";
    rig.style.transform = `translate(${(W - (x1 - x0) * sc) / 2 - x0 * sc}px, ${(H - (y1 - y0) * sc) / 2 - y0 * sc}px) scale(${sc})`;
    for (const l of layers) {
      const im = document.createElement("img"); im.src = `${base}/sprites/${l.file}`; im.loading = "lazy"; im.draggable = false;
      im.style.left = `${-l.px * l.w}px`; im.style.top = `${-(1 - l.py) * l.h}px`; im.width = l.w; im.height = l.h;
      rig.appendChild(im);
    }
    box.appendChild(rig);
  }

  function pickBackgrounds() {
    const seen = new Set(), out = [];
    const cur = run && run.view && run.view.bg;
    if (cur) { out.push(cur); seen.add(cur); }
    const want = /pool|lawn|terrace|fire|daybed|bedroom|kitchen|beach|entrance|villa|roof|garden|lounge/i;
    for (const b of Object.values(S.backgrounds)) {
      const f = b.files && b.files[0];
      if (!f || seen.has(f) || !want.test(b.name || f) || /night|powercut|flash|cmm|mud/i.test(b.name || f)) continue;
      seen.add(f); out.push(f);
      if (out.length >= 8) break;
    }
    return out;
  }

  /** Open the wardrobe. With a story step (the game asking you to pick), it shows just that choice. */
  function openWardrobe(st) {
    if (!S || !save) return;
    let occs = E.wardrobeModel(S);
    const who = (st && st.char) || S.playerKey;
    if (st) {
      // The story's own "choose your look" screen always shows everything (skin, eyes, hair...).
      let o = occs.find((x) => !x.only && (x.tree === st.tree || (x.trees && x.trees.includes(st.tree))));
      if (!o) {
        const t = S.get(st.tree), sk = (t && t.SkinToModify) || "Default";
        o = sk === "Default" ? { type: "look", label: "Look", tree: st.tree, skin: "Default" }
          : { type: "outfit", label: E.occasionLabel(sk), skin: sk, trees: [st.tree] };
      }
      occs = [o];
    }
    if (!occs.length) { showToast({ headline: "This season has no wardrobe", name: "" }); return; }
    const bgs = pickBackgrounds();
    wd = { st, who, occs, occ: 0, cat: 0, bgs, bg: bgs[0] || null, cache: {} };
    $("custDone").textContent = st ? "Done" : "Close";
    $("wdX").classList.toggle("hidden", !!st);
    show("custom");
    drawWardrobe();
  }
  function closeWardrobe() {
    if (!wd) return;
    const st = wd.st;
    wd = null; hide("custom");
    if (st) { run.finishCustomize(); next(); return; }
    if (step && step.view) layoutChars(step.view, step.speaker);
    autosave();
  }
  $("custDone").onclick = closeWardrobe;
  $("wdX").onclick = closeWardrobe;

  function wardrobePreviewSkin(o) {
    if (o.type === "outfit") return o.skin;
    if (o.type === "skins") return currentS1Pick(o) || o.skins[0];
    return save.skins[wd.who] || undefined;
  }
  function currentS1Pick(o) {
    return (run && run.params[o.param]) || (o.re.test(save.skins[S.playerKey] || "") ? save.skins[S.playerKey] : null);
  }

  function drawWardrobe() {
    const o = wd.occs[wd.occ];
    $("wdTitle").textContent = o.label;
    $("wd").style.backgroundImage = wd.bg ? `url("${base}/backgrounds/${wd.bg}")` : "none";
    // occasions
    const occ = $("wdOcc"); occ.innerHTML = "";
    if (wd.occs.length > 1) wd.occs.forEach((x, i) => {
      const b = document.createElement("button"); b.textContent = x.label; b.classList.toggle("on", i === wd.occ);
      b.onclick = () => { wd.occ = i; wd.cat = 0; drawWardrobe(); }; occ.appendChild(b);
    });
    // background strip
    const bgs = $("wdBgs"); bgs.innerHTML = "";
    for (const f of wd.bgs) {
      const b = document.createElement("button"); b.style.backgroundImage = `url("${base}/backgrounds/${f}")`;
      b.classList.toggle("on", f === wd.bg); b.onclick = () => { wd.bg = f; drawWardrobe(); }; bgs.appendChild(b);
    }
    if (o.type === "look") drawLook(o); else if (o.type === "hair1") drawHair1(o); else drawOutfit(o);
    drawPreview();
  }
  function drawPreview() {
    const o = wd.occs[wd.occ];
    const pv = $("custPreview"); pv.innerHTML = "";
    const r = pv.getBoundingClientRect();
    const el = document.createElement("div"); el.className = "char"; el.innerHTML = '<div class="rig"></div>';
    el.style.transform = `translate(${r.width / 2}px, ${r.height * 0.5}px)`;
    fillRig(el.firstChild, E.avatarLayers(S, save, wd.who, "Happy", wardrobePreviewSkin(o)));
    el.firstChild.style.transform = `scale(${Math.min(r.height * 0.98, r.width * 2.1) / figureUnit()})`;
    pv.appendChild(el);
  }
  function railButton(label, icon, on, click) {
    const b = document.createElement("button");
    b.innerHTML = (ICON[icon] || ICON.look) + "<span></span>";
    b.lastChild.textContent = label; b.classList.toggle("on", on); b.onclick = click;
    return b;
  }

  /* outfits: Clothes / Shoes / Jewellery, mix and match */
  function drawOutfit(o) {
    const key = o.label;
    let cats = wd.cache[key];
    if (!cats) {
      cats = wd.cache[key] = o.type === "outfit" ? E.outfitCategories(S, o)
        : [{ id: "outfit", label: "Outfits", options: o.skins.map((sk) => ({ skin: sk, layers: E.clothingLayers(S, save, wd.who, sk) })) }];
    }
    if (wd.cat >= cats.length) wd.cat = 0;
    const rail = $("wdRail"); rail.innerHTML = "";
    cats.forEach((c, i) => rail.appendChild(railButton(c.label, c.id, i === wd.cat, () => { wd.cat = i; drawWardrobe(); })));
    $("custVariants").innerHTML = "";
    const cat = cats[wd.cat];
    const items = $("custItems"); items.innerHTML = "";
    const current = o.type === "outfit" ? E.outfitSig(S, save, wd.who, o.skin, cat) : currentS1Pick(o);
    cat.options.forEach((opt) => {
      const b = document.createElement("button");
      if (opt.none) b.classList.add("none");
      const on = o.type === "outfit" ? opt.sig === current : opt.skin === current;
      b.classList.toggle("on", on);
      b.onclick = () => {
        if (o.type === "outfit") E.applyOutfitOption(S, save, wd.who, o.skin, cat, opt);
        else pickS1Outfit(o, opt.skin);
        items.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
        drawPreview(); autosave();
      };
      items.appendChild(b);
      requestAnimationFrame(() => fitLayers(b, opt.layers));
    });
  }
  function pickS1Outfit(o, skin) {
    if (run) run.params[o.param] = skin;
    if (o.re.test(save.skins[S.playerKey] || "")) save.skins[S.playerKey] = skin;
  }

  /* look: skin, eyes, hair... with colour variants */
  function lookState(o) {
    save.custState = save.custState || {};
    const state = save.custState[o.tree] || (save.custState[o.tree] = {});
    const model = E.customizationModel(S, save, o.tree);
    for (const g of model.groups) {
      if (state[g.name]) continue;
      const v = g.variants[g.active] || g.variants[0];
      state[g.name] = { variant: g.active, item: v.items.findIndex((it) => E.selectedItem(save, wd.who, model.skin, it.key, S)) };
    }
    return state;
  }
  function applyLook(o, state) {
    let model = E.customizationModel(S, save, o.tree);
    for (const name of model.groups.map((x) => x.name)) {
      model = E.customizationModel(S, save, o.tree);          // fresh each time: nose shapes follow the skin tone just picked
      const g = model.groups.find((x) => x.name === name);
      const s0 = g && state[g.name]; if (!s0) continue;
      // remember chosen colours (hair, eyes...) so anything matched to them follows along
      if (!g.auto && g.req && g.variants[s0.variant]) (save.custParams = save.custParams || {})[g.req] = g.variants[s0.variant].value;
      if (s0.item < 0 && !(g.auto && g.req)) continue;
      const v = g.variants[g.auto ? g.active : s0.variant] || g.variants[0];
      const it = v.items[Math.min(Math.max(0, s0.item), v.items.length - 1)];
      if (it) E.applyCustomization(S, save, wd.who, o.tree, it.key);
    }
    E.repairLook(S, save);
    return E.customizationModel(S, save, o.tree);
  }

  function drawHair1(o) {
    const rail = $("wdRail"); rail.innerHTML = "";
    rail.appendChild(railButton("Hair", "look", true, () => {}));
    if (wd.v1 === undefined) wd.v1 = 0;
    const chips = $("custVariants"); chips.innerHTML = "";
    o.variants.forEach((v, i) => {
      const b = document.createElement("button"); b.textContent = v.label; b.classList.toggle("on", i === wd.v1);
      b.onclick = () => { wd.v1 = i; drawWardrobe(); }; chips.appendChild(b);
    });
    const cur = ((save.custom || {})[wd.who] || {})["Default|Hair"];
    const items = $("custItems"); items.innerHTML = "";
    o.variants[wd.v1].items.forEach((it) => {
      const b = document.createElement("button"); b.title = it.name; b.classList.toggle("on", it.front === cur);
      b.onclick = () => {
        E.applySeason1Hair(S, save, wd.who, it);
        items.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
        drawPreview(); autosave();
      };
      items.appendChild(b);
      requestAnimationFrame(() => fitLayers(b, E.hairLayers(S, it), 0.8));
    });
  }
  function lookGroups(o, model) {
    const re = o.only ? new RegExp(o.only, "i") : null;
    return model.groups.filter((g) => !re || re.test(g.name));
  }
  function drawLook(o) {
    const state = lookState(o);
    const model = E.customizationModel(S, save, o.tree);
    model.groups = lookGroups(o, model);
    if (wd.cat >= model.groups.length) wd.cat = 0;
    const rail = $("wdRail"); rail.innerHTML = "";
    model.groups.forEach((g, i) => rail.appendChild(railButton(/^init?al$/i.test(g.name) ? "Outfits" : g.name, "look", i === wd.cat,
      () => { wd.cat = i; drawWardrobe(); })));
    const g = model.groups[wd.cat];
    const s0 = state[g.name];
    const vi = g.auto ? g.active : s0.variant;
    const chips = $("custVariants"); chips.innerHTML = "";
    if (!g.auto && g.variants.length > 1) g.variants.forEach((v, i) => {
      const b = document.createElement("button"); b.textContent = v.label; b.classList.toggle("on", i === vi);
      b.onclick = () => { s0.variant = i; if (s0.item < 0) s0.item = 0; applyLook(o, state); drawWardrobe(); autosave(); };
      chips.appendChild(b);
    });
    const items = $("custItems"); items.innerHTML = "";
    const v = g.variants[vi] || g.variants[0];
    v.items.forEach((it, j) => {
      const b = document.createElement("button"); b.title = it.name; b.classList.toggle("on", j === s0.item);
      const lay = E.itemLayers(S, it.key);
      if (lay.length || it.icon) requestAnimationFrame(() => fitLayers(b, lay.length ? lay : [it.icon], 0.8));
      b.onclick = () => {
        s0.item = j; s0.variant = vi; applyLook(o, state);
        items.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
        drawPreview(); autosave();
      };
      items.appendChild(b);
    });
  }

  /* ------------------------------------------------------------ emoji bursts ("explojis") */
  function playEffect(fx) {
    const box = $("fx"), r = stage.getBoundingClientRect(), H = r.height, W = r.width;
    const el = fx.char ? charEls.get(fx.char) : null;
    let x = W * 0.5, y = H * 0.3;
    if (el) { x = Number(el.dataset.x); y = Number(el.dataset.hy) || H * 0.27; }
    else if (fx.char && fx.char === S.playerKey) x = W * 0.22;
    else if (fx.left) x = W * 0.25;
    const size = H * (fx.size || 50) / 560, parts = [];
    for (let i = 0; i < fx.count; i++) {
      const im = document.createElement("img"); im.src = `${base}/effects/${fx.tex}`; im.width = im.height = size;
      box.appendChild(im);
      const ang = (-90 + (Math.random() * 2 - 1) * 65) * Math.PI / 180, sp = H * (0.5 + Math.random() * 0.4);
      parts.push({ im, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, rot: (Math.random() * 2 - 1) * 25,
        vr: (Math.random() * 2 - 1) * 60, life: 1.7 + Math.random() * 0.7, delay: Math.random() * 0.18 });
    }
    const g = H * 1.5, t0 = performance.now();
    const tick = (now) => {
      const t = (now - t0) / 1000;
      let alive = 0;
      for (const p of parts) {
        const tt = t - p.delay;
        if (tt < 0) { p.im.style.opacity = 0; alive++; continue; }
        if (tt > p.life) { if (p.im.parentNode) p.im.remove(); continue; }
        alive++;
        const px = p.x + p.vx * tt, py = p.y + p.vy * tt + 0.5 * g * tt * tt;
        const pop = Math.min(1, tt / 0.15), fade = Math.min(1, (p.life - tt) / (p.life * 0.35));
        p.im.style.opacity = fade;
        p.im.style.transform = `translate(${px - size / 2}px, ${py - size / 2}px) rotate(${p.rot + p.vr * tt}deg) scale(${0.35 + 0.65 * pop})`;
      }
      if (alive) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Little round face portrait of a character. */
  function makeHead(k, into) {
    const n = run.charName(k);
    const d = document.createElement("div"); d.className = "head"; d.title = n || "";
    into.appendChild(d);
    const layers = E.avatarLayers(S, save, k, run.view.expr[k]);
    const head = layers.find((l) => /^(Head|Face)$/i.test(l.slot));
    if (!head) { d.textContent = (n || "?").slice(0, 1); return d; }
    const size = d.clientWidth || 40;
    const hx = -head.px * head.w, hy = -(1 - head.py) * head.h;
    const sc = (size * 1.05) / Math.max(head.w, head.h * 0.82);
    const rig = document.createElement("div"); rig.className = "thumb";
    rig.style.transform = `translate(${size / 2 - (hx + head.w / 2) * sc}px, ${size * 0.56 - (hy + head.h * 0.45) * sc}px) scale(${sc})`;
    for (const l of layers) {
      const im = document.createElement("img"); im.src = `${base}/sprites/${l.file}`; im.draggable = false;
      im.style.left = `${-l.px * l.w}px`; im.style.top = `${-(1 - l.py) * l.h}px`; im.width = l.w; im.height = l.h;
      rig.appendChild(im);
    }
    d.appendChild(rig);
    return d;
  }
  function renderOverflow(v) {
    const box = $("overflow"); box.innerHTML = "";
    for (const k of v.overflow || []) {
      if (!run.charName(k) || k === v.focus || k === v.speaker) continue;   // focus/speaker are on stage right now
      makeHead(k, box);
    }
  }

  /* ------------------------------------------------------------ villa map ("who do you want to talk to?") */
  // Where each spot is on the map pictures (fraction of the picture's width and height).
  const MAP_SPOTS = [
    { re: /open_villa/i, spots: {
      "sun loungers": [0.30, 0.80], "daybeds": [0.31, 0.62], "kitchen": [0.42, 0.36], "rooftop terrace": [0.62, 0.13],
      "bedroom": [0.60, 0.31], "bathroom": [0.78, 0.23], "dressing room": [0.70, 0.28], "fire pit": [0.82, 0.52],
      "lawn": [0.64, 0.74], "bean bags": [0.73, 0.86], "gym": [0.88, 0.75], "poolside": [0.52, 0.92],
      "picnic table": [0.57, 0.58], "beach hut": [0.10, 0.28], "hideaway": [0.23, 0.42] } },
    { re: /openmansion/i, spots: {
      "murder garden": [0.32, 0.30], "murder cellar": [0.13, 0.55], "murder kitchen": [0.23, 0.47], "murder dining room": [0.21, 0.74],
      "murder drawing room": [0.47, 0.62], "murder hallway": [0.32, 0.60], "murder bedroom 1": [0.63, 0.22], "murder bedroom 2": [0.87, 0.22],
      "murder bedroom 3": [0.63, 0.46], "murder bedroom 4": [0.87, 0.46] } },
    { re: /yacht/i, spots: { "boat bow": [0.22, 0.60], "boat pool": [0.36, 0.55], "boat kitchen": [0.68, 0.44] } },
  ];
  function showMap(st) {
    hide("textbox"); hide("choices");
    $("chars").style.visibility = "hidden"; $("overflow").style.visibility = "hidden";
    const wrap = $("mapWrap"), sc = $("mapScroll"), img = $("mapImg");
    show("mapWrap");
    const r = stage.getBoundingClientRect(), W = r.width, H = r.height;
    const mw = Math.max(W, H * 2);
    img.style.width = mw + "px";
    img.style.backgroundImage = st.map ? `url("${base}/backgrounds/${st.map}")` : "none";
    img.innerHTML = "";
    let map = st.map;
    if (!MAP_SPOTS.some((m) => map && m.re.test(map))) {
      // Season 1 doesn't name a map picture: use the villa overview (the night one after dark).
      const files = Object.values(S.backgrounds).map((b) => b.files && b.files[0]).filter((f) => f && /open_villa/i.test(f));
      const night = /night/i.test(st.map || "");
      map = files.find((f) => /night/i.test(f) === night) || files[0] || map;
      img.style.backgroundImage = map ? `url("${base}/backgrounds/${map}")` : "none";
    }
    const table = (MAP_SPOTS.find((m) => map && m.re.test(map)) || { spots: {} }).spots;
    const unknown = st.options.filter((o) => !table[o.slot.toLowerCase()]);
    st.options.forEach((o, i) => {
      let [x, y] = table[o.slot.toLowerCase()] || [0, 0];
      if (!table[o.slot.toLowerCase()]) { const j = unknown.indexOf(o); x = (j + 1) / (unknown.length + 1); y = 0.5; }
      const b = document.createElement("button");
      b.className = "pin" + (o.required ? " req" : "");
      b.style.left = x * mw + "px"; b.style.top = y * H + "px";
      const faces = document.createElement("div"); faces.className = "faces" + (o.chars.length ? "" : " empty");
      b.appendChild(faces);
      const tag = document.createElement("div"); tag.className = "tag"; tag.textContent = o.text; b.appendChild(tag);
      b.title = `${i + 1}. ${o.text}`;
      b.onclick = (e) => { e.stopPropagation(); if (sc._dragged) return; leaveMap(); history.push({ kind: "pick", text: "→ " + o.text }); run.choose(o); next(); };
      img.appendChild(b);
      o.chars.slice(0, 4).forEach((k) => makeHead(k, faces));
    });
    sc.scrollLeft = (mw - W) / 2;
    // On narrow screens the map is wider than the screen: show how many spots are off to each side.
    const edges = () => {
      const pins = [...img.querySelectorAll(".pin")].map((p) => parseFloat(p.style.left));
      const l = pins.filter((x) => x < sc.scrollLeft + W * 0.04).length, rr = pins.filter((x) => x > sc.scrollLeft + W * 0.96).length;
      $("mapL").classList.toggle("hidden", !l); $("mapL").lastChild.textContent = l;
      $("mapR").classList.toggle("hidden", !rr); $("mapR").firstChild.textContent = rr;
    };
    sc.onscroll = edges; requestAnimationFrame(edges);
    $("mapL").onclick = (e) => { e.stopPropagation(); sc.scrollBy({ left: -W * 0.8, behavior: "smooth" }); };
    $("mapR").onclick = (e) => { e.stopPropagation(); sc.scrollBy({ left: W * 0.8, behavior: "smooth" }); };
    $("mapDone").classList.toggle("hidden", !st.canExit);
    $("mapDone").onclick = (e) => { e.stopPropagation(); leaveMap(); run.choose("Exit"); next(); };
  }
  function leaveMap() {
    hide("mapWrap");
    $("chars").style.visibility = ""; $("overflow").style.visibility = "";
  }
  // drag the map sideways with the mouse (touch screens scroll it natively)
  (() => {
    const sc = $("mapScroll"); let down = null;
    sc.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") return; down = { x: e.clientX, left: sc.scrollLeft }; sc._dragged = false; });
    window.addEventListener("pointermove", (e) => { if (!down) return; const dx = e.clientX - down.x; if (Math.abs(dx) > 5) sc._dragged = true; sc.scrollLeft = down.left - dx; });
    window.addEventListener("pointerup", () => { down = null; setTimeout(() => (sc._dragged = false), 0); });
  })();

  function trackSeen(v, sp) {
    save.seen = save.seen || [];
    for (const k of (v.stage || []).concat(sp ? [sp] : [])) if (k && k !== S.playerKey && !save.seen.includes(k)) save.seen.push(k);
  }
  let toastTimer = null;
  function showToast(t) {
    const el = $("toast"); el.innerHTML = ""; el.append(t.headline || "");
    if (t.name) { const b = document.createElement("b"); b.textContent = t.name; el.appendChild(b); }
    show("toast"); clearTimeout(toastTimer); toastTimer = setTimeout(() => hide("toast"), 2600);
  }

  /* ------------------------------------------------------------ text */
  function richTokens(text) {
    // escape everything, then allow a small set of Unity rich-text tags
    const out = []; const re = /<(\/?)(i|b|u|color|size)(=[^>]*)?>/gi; let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index) });
      const tag = m[2].toLowerCase(), close = !!m[1];
      if (tag === "size") out.push({ h: "" });
      else if (tag === "color") out.push({ h: close ? "</span>" : `<span style="color:${(m[3] || "=").slice(1).replace(/[^#a-zA-Z0-9]/g, "")}">` });
      else out.push({ h: close ? `</${tag}>` : `<${tag}>` });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function partialHTML(tokens, n) {
    let html = "", left = n;
    for (const tk of tokens) {
      if (tk.h !== undefined) { html += tk.h; continue; }
      if (left <= 0) continue;
      const chars = [...tk.t]; html += esc(chars.slice(0, left).join("")); left -= chars.length;
    }
    return html;
  }
  function placeTextboxPortrait(st, prompt) {
    const box = $("textbox");
    const r = stage.getBoundingClientRect(), W = r.width, H = r.height;
    const el = st.speaker ? charEls.get(st.speaker) : null;
    box.classList.remove("center", "tail", "tail-left", "tail-down", "prompt");
    const w = box.offsetWidth, h = box.offsetHeight, left = (W - w) / 2;
    box.style.left = left + "px";
    let top = H * 0.3;
    if (el && st.speaker === S.playerKey && !st.narrator) {
      top = Math.max(H * 0.14, Number(el.dataset.top) - h - H * 0.035);   // above your head, pointing down at you
      box.classList.add("tail-down");
    } else if (el && !st.narrator) {
      top = Math.min(H * 0.42, Number(el.dataset.hy) + H * 0.1);          // under their face, pointing up
      box.classList.add("tail");
    } else if (prompt) top = H * 0.26;
    box.style.top = top + "px";
    if (el) box.style.setProperty("--px", Math.max(28, Math.min(w - 28, Number(el.dataset.x) - left)) + "px");
  }
  function placeTextbox(st, prompt) {
    const box = $("textbox");
    const r = stage.getBoundingClientRect(), W = r.width;
    box.style.top = "";
    if (r.height > W) return placeTextboxPortrait(st, prompt);
    const el = st.speaker ? charEls.get(st.speaker) : null;
    const playerShown = charEls.has(S.playerKey);
    const w = box.offsetWidth, m = W * 0.02;
    // In the classic layout keep the box clear of your face in the bottom-left corner.
    const minLeft = classic() && playerShown ? Math.min(W * 0.27, W - w - m) : m;
    box.classList.toggle("prompt", !!prompt);
    box.classList.remove("center", "tail", "tail-left", "tail-down");
    box.style.left = "";
    if (st.speaker && st.speaker === S.playerKey && classic() && el) {
      box.classList.add("tail-left");                 // you're talking: pointer back to you
      box.style.left = minLeft + "px";
      return;
    }
    if (!el || st.narrator) {
      if (classic() && playerShown) box.style.left = Math.max(minLeft, (W - w) / 2 + W * 0.08) + "px";
      else box.classList.add("center");
      return;
    }
    const x = Number(el.dataset.x || W / 2);
    const left = Math.max(minLeft, Math.min(W - w - m, x - w * 0.3));
    box.classList.add("tail");
    box.style.left = left + "px";
    box.style.setProperty("--px", Math.max(28, Math.min(w - 28, x - left)) + "px");
  }
  function showText(st, noMore) {
    const box = $("textbox"), tag = $("nametag");
    box.className = st.narrator ? "narrator" : st.thinking ? "thinking" : st.textMessage ? "message" : "";
    if (!st.narrator && st.name) { tag.textContent = st.name; tag.classList.remove("hidden"); tag.classList.toggle("player", st.speaker === S.playerKey); }
    else tag.classList.add("hidden");
    show("textbox"); $("more").classList.toggle("hidden", !!noMore);
    placeTextbox(st, noMore);
    const tokens = richTokens(st.text), total = tokens.reduce((a, t) => a + (t.t ? [...t.t].length : 0), 0);
    stopTyping();
    const cps = settings.speed >= 100 ? 0 : 20 + settings.speed * 1.8;
    if (!cps) { $("text").innerHTML = partialHTML(tokens, total); return; }
    let shown = 0; const t0 = performance.now();
    typing = { finish: () => { $("text").innerHTML = partialHTML(tokens, total); stopTyping(); } };
    const tick = (now) => {
      if (!typing) return;
      shown = Math.min(total, Math.floor(((now - t0) / 1000) * cps));
      $("text").innerHTML = partialHTML(tokens, shown);
      if (shown >= total) { stopTyping(); return; }
      typing.raf = requestAnimationFrame(tick);
    };
    typing.raf = requestAnimationFrame(tick);
  }
  function stopTyping() { if (typing && typing.raf) cancelAnimationFrame(typing.raf); typing = null; }

  function rich(text) {
    const sp = document.createElement("span");
    sp.innerHTML = partialHTML(richTokens(String(text)), Infinity);
    return sp;
  }
  function showChoices(opts, noprompt) {
    const box = $("choices"); box.innerHTML = ""; box.classList.toggle("noprompt", !!noprompt); box.classList.remove("pics");
    const sr = stage.getBoundingClientRect();
    box.classList.toggle("shift", classic() && sr.width > sr.height && charEls.has(S.playerKey));
    opts.forEach((o, i) => {
      const b = document.createElement("button");
      if (o.premium) b.classList.add("premium"); if (o.exit) b.classList.add("exit");
      const k = document.createElement("span"); k.className = "key"; k.textContent = i + 1;
      if (o.image) {
        b.classList.add("pic"); box.classList.add("pics");
        const im = document.createElement("img"); im.src = `${base}/sprites/${o.image.file}`; im.alt = o.label;
        b.append(im, k);
        // Season 1 option names like "H1" or "Eth2" are internal codes, so show the picture and number only
        if (!/^[A-Za-z]{1,4}\d+$/.test(o.label)) b.append(rich(o.label));
      } else b.append(k, rich(o.label)); b.onclick = (e) => { e.stopPropagation(); hide("choices"); o.pick(); };
      box.appendChild(b);
    });
    show("choices");
  }

  function advance() {
    if (!run || !step || anyOverlay()) return;
    if (typing) { typing.finish(); return; }
    if (step.type === "line") { run.advance(); next(); }
  }

  /* ------------------------------------------------------------ audio */
  const m1 = $("music1"), m2 = $("music2"), sfx = $("sfx");
  let warnedAudio = false;
  for (const a of [m1, m2, sfx]) a.addEventListener("error", () => {
    if (warnedAudio || !a.getAttribute("src")) return;
    warnedAudio = true;
    showToast({ headline: "Music couldn't play.", name: "Run 1 - Convert seasons.bat again" });
  });
  let curMusic = null, curEl = m1, fader = null;
  function musicVol() { return settings.muted ? 0 : settings.music / 100; }
  function playMusic(file) {
    const url = file ? `${base}/audio/${file}` : null;
    if (url === curMusic) return;
    curMusic = url;
    const from = curEl, to = curEl === m1 ? m2 : m1;
    clearInterval(fader);
    if (url) { to.src = url; to.volume = 0; to.play().catch(() => {}); }
    let t = 0;
    fader = setInterval(() => {
      t = Math.min(1, t + 0.05);
      from.volume = Math.max(0, (1 - t) * musicVol());
      if (url) to.volume = t * musicVol();
      if (t >= 1) { clearInterval(fader); from.pause(); if (url) curEl = to; }
    }, 50);
  }
  function playSfx(file) {
    if (!file || settings.muted) return;
    sfx.src = `${base}/audio/${file}`; sfx.volume = settings.sfx / 100; sfx.play().catch(() => {});
  }
  function applyVolume() { curEl.volume = musicVol(); $("btnMute").textContent = settings.muted ? "♪̸" : "♪"; }

  /* ------------------------------------------------------------ panels */
  function openRel() {
    const list = $("relList"); list.innerHTML = "";
    const nameOf = (k) => (run ? run.charName(k) : (S.characters[S.canon(k)] || {}).name) || "";
    // Who fills your couple roles right now (so you can see the story remembers who you picked).
    const roles = Object.entries((save && save.refs) || {}).filter(([k, v]) => /partner|couple/i.test(k) && nameOf(v));
    for (const [k, v] of roles) {
      const label = roles.length === 1 ? "Your partner" : k.replace(/^R:/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const d = document.createElement("div"); d.className = "rel role";
      const s = document.createElement("span"); s.textContent = label;
      const b = document.createElement("b"); b.textContent = nameOf(v);
      d.append(s, b); list.appendChild(d);
    }
    const seen = [...new Set(((save && save.seen) || []).map((k) => S.canon(k)))];
    const rows = seen.map((k) => ({ k, n: nameOf(k), a: ((save.traits || {})[k] || {}).affinity }))
      .filter((r) => r.n && (typeof r.a === "number" || typeof r.a === "boolean"))
      .sort((a, b) => (typeof b.a === "number" ? b.a : b.a ? 70 : 50) - (typeof a.a === "number" ? a.a : a.a ? 70 : 50));
    if (!rows.length && !roles.length) list.textContent = "Nobody yet. Get to know the Islanders!";
    for (const r of rows) {
      const d = document.createElement("div"); d.className = "rel";
      const s = document.createElement("span"); s.textContent = r.n;
      if (typeof r.a === "boolean") {
        // Season 3's own cast: a spark or not, rather than a score
        const b = document.createElement("b"); b.textContent = r.a ? "♥ Feels a spark" : "No spark yet"; b.className = r.a ? "spark" : "nospark";
        d.append(s, b); list.appendChild(d); continue;
      }
      const bar = document.createElement("div"); bar.className = "bar"; const i = document.createElement("i"); i.style.width = Math.max(0, Math.min(100, r.a)) + "%"; bar.appendChild(i);
      d.append(s, bar); list.appendChild(d);
    }
    show("rel");
  }
  function openLog() {
    const list = $("logList"); list.innerHTML = "";
    for (const h of history.slice(-300)) {
      const d = document.createElement("div"); d.className = "l " + (h.kind === "narr" ? "narr" : h.kind === "pick" ? "pick" : "");
      if (h.kind === "ep") { d.innerHTML = "<hr>"; d.append(h.text); }
      else { if (h.name) { const b = document.createElement("b"); b.textContent = h.name; d.appendChild(b); } d.append(h.text.replace(/<[^>]+>/g, "")); }
      list.appendChild(d);
    }
    show("logview"); list.parentElement.scrollTop = list.parentElement.scrollHeight;
  }
  /** Problem report: where the story is, the last steps, roles, scores and notes. Saved and copied for pasting. */
  async function problemReport() {
    if (!S || !save) { showToast({ headline: "Start or continue a game first", name: "" }); return; }
    const rep = E.debugReport(S, save, run);
    rep.onScreen = step ? { type: step.type, speaker: step.speaker && run ? run.charName(step.speaker) : "",
      text: step.text || step.prompt || "", options: (step.options || []).map((o) => o.text || o.slot) } : null;
    rep.recentLines = history.slice(-30);
    const json = JSON.stringify(rep, null, 1);
    let saved = false, copied = false;
    try { await api.save(seasonId, "problem_report", rep); saved = true; } catch (e) { /* ignore */ }
    try { await navigator.clipboard.writeText(json); copied = true; } catch (e) {
      try {
        const ta = document.createElement("textarea"); ta.value = json; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); copied = document.execCommand("copy"); ta.remove();
      } catch (e2) { /* ignore */ }
    }
    const where = saved && !bridge ? `%APPDATA%\\LoveIsland\\saves\\${seasonId}\\problem_report.json` : "";
    showToast({ headline: copied ? "Problem report copied - paste it to Claude." : saved ? "Problem report saved." : "Couldn't save the report.",
      name: where });
  }

  function openSettings() {
    $("sSpeed").value = settings.speed; $("sMusic").value = settings.music; $("sSfx").value = settings.sfx;
    $("sFull").checked = !!document.fullscreenElement; $("sFx").checked = settings.fx !== false;
    $("sLayout").value = settings.layout === "side" ? "side" : "classic"; $("ver").textContent = "Version " + E.VERSION; show("settings");
  }
  $("sSpeed").oninput = (e) => { settings.speed = +e.target.value; saveSettings(); };
  $("sMusic").oninput = (e) => { settings.music = +e.target.value; saveSettings(); applyVolume(); };
  $("sSfx").oninput = (e) => { settings.sfx = +e.target.value; saveSettings(); };
  $("sFull").onchange = (e) => toggleFull(e.target.checked);
  $("sFx").onchange = (e) => { settings.fx = e.target.checked; saveSettings(); };
  $("sLayout").onchange = (e) => {
    settings.layout = e.target.value; saveSettings();
    window.dispatchEvent(new Event("resize"));   // re-place characters and the speech box
  };
  function toggleFull(on) {
    if (on === undefined) on = !document.fullscreenElement;
    if (on) document.documentElement.requestFullscreen().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen();
  }

  /* ------------------------------------------------------------ wiring */
  $("btnContinue").onclick = continueGame;
  $("btnNew").onclick = newGame;
  $("btnEpisodes").onclick = openEpisodes;
  $("btnSettings").onclick = openSettings;
  $("btnMenu").onclick = (e) => { e.stopPropagation(); show("pause"); };
  $("btnLog").onclick = (e) => { e.stopPropagation(); openLog(); };
  $("btnWardrobe").onclick = (e) => { e.stopPropagation(); if (run && !anyOverlay()) openWardrobe(null); };
  $("pWardrobe").onclick = () => { hide("pause"); openWardrobe(null); };
  $("btnMute").onclick = (e) => { e.stopPropagation(); settings.muted = !settings.muted; saveSettings(); applyVolume(); };
  $("pResume").onclick = () => hide("pause");
  $("pRel").onclick = openRel;
  $("pReport").onclick = () => { hide("pause"); problemReport(); };
  $("pEpisodes").onclick = () => { hide("pause"); openEpisodes(); };
  $("pSettings").onclick = openSettings;
  $("pTitle").onclick = toTitle;
  $("eTitle").onclick = () => { hide("epend"); toTitle(); };
  $("textbox").addEventListener("click", (e) => { e.stopPropagation(); advance(); });
  stage.addEventListener("click", (e) => { if (e.target.closest("button, .overlay, #choices, #mapWrap")) return; advance(); });
  stage.addEventListener("wheel", (e) => { if (e.deltaY < 0 && run && !anyOverlay()) openLog(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "F11") { e.preventDefault(); toggleFull(); return; }
    if (e.key === "F9") { e.preventDefault(); problemReport(); return; }
    if (!$("ask").classList.contains("hidden")) return;
    if (e.key === "Escape" && wd && !wd.st) { closeWardrobe(); return; }
    if (e.key === "Escape") {
      const open = overlays.filter((o) => o !== "title" && o !== "epend" && o !== "custom" && !$(o).classList.contains("hidden"));
      if (open.length) open.forEach(hide); else if (run) show("pause");
      return;
    }
    if (anyOverlay()) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); advance(); }
    else if (/^[1-9]$/.test(e.key)) {
      const onMap = !$("mapWrap").classList.contains("hidden");
      const b = onMap ? $("mapImg").querySelectorAll(".pin")[+e.key - 1] : $("choices").querySelectorAll("button")[+e.key - 1];
      if (b && (onMap || !$("choices").classList.contains("hidden"))) b.click();
    }
    else if (e.key.toLowerCase() === "h") openLog();
    else if (e.key.toLowerCase() === "w" && run) openWardrobe(null);
    else if (e.key.toLowerCase() === "m") $("btnMute").click();
  });
  window.addEventListener("resize", () => {
    if (run && step && step.view) layoutChars(step.view, step.speaker);
    if (step && (step.type === "line" || (step.type === "choice" && step.prompt))) placeTextbox(step.type === "line" ? step : { speaker: step.speaker, narrator: !step.speaker }, step.type === "choice");
    if (wd) drawWardrobe();
    if (step && step.type === "openworld" && !$("mapWrap").classList.contains("hidden")) showMap(step);
  });
  window.addEventListener("beforeunload", () => {
    if (bridge || !run || run.done || !save) return;
    save.current = run.snapshot();
    fetch(`/api/save?season=${seasonId}&name=autosave`, { method: "PUT", body: JSON.stringify(save), keepalive: true });
  });
  // Pause music and save when the app goes to the background (phone home button, minimising).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (run && !run.done) autosave(true); curEl.pause(); }
    else if (curMusic && !settings.muted) curEl.play().catch(() => {});
  });
  // Hooks for the Android app: save now, and the phone's Back button.
  window.__liSaveNow = () => { if (run && !run.done) autosave(true); };
  window.__liBack = () => {
    if (wd && !wd.st) { closeWardrobe(); return; }
    if (!$("ask").classList.contains("hidden") || !$("custom").classList.contains("hidden")) return;
    const open = overlays.filter((o) => o !== "title" && o !== "epend" && !$(o).classList.contains("hidden"));
    if (open.length) open.forEach(hide);
    else if (run && $("title").classList.contains("hidden")) show("pause");
    else if (bridge && bridge.exitApp) bridge.exitApp();
  };

  applyVolume();
  boot();
  window.__li = { get run() { return run; }, get save() { return save; }, get S() { return S; } };   // for debugging
})();
