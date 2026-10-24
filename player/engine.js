/* Love Island (original app) story engine.
 * Interprets the story graphs written by extract_season.py.
 * Works in the browser (window.LIEngine) and in Node (module.exports) for testing.
 */
(function (root) {
  "use strict";

  const VERSION = "1.1.5";
  const CMP = {
    0: (a, b) => a == b, 1: (a, b) => a != b, 2: (a, b) => a < b,
    3: (a, b) => a > b, 4: (a, b) => a >= b, 5: (a, b) => a <= b,
  };
  const LINE_NODES = new Set(["NarratorNode", "CharacterNode", "PlayerNode", "ReferenceCharacterNode", "ParticleEffectNode"]);
  const CHOICE_NODES = new Set(["ChoiceNode", "TimedChoiceNode"]);
  const MAX_STEPS = 20000;
  // Actions that may safely run when attached directly to a choice option.
  const CHOICE_ACTIONS = new Set(["SetBool", "SetString", "SetInt", "SetFloat", "ModifyInt", "SetObject", "SetAffinity",
    "SetReferenceCharacter", "ModifyReferenceCharacter", "ReferenceCharacterTraitCalculation", "AddItemToStoryInventory",
    "SetSkin", "MassSetSkin", "SetCustomization", "ModifyCharacter", "SetExpression", "MassSetExpression", "PlayAudio"]);

  const norm = (s) => String(s ?? "").trim().toLowerCase();
  /** Text comparison as the app did it: equal / not equal ignore case and surrounding spaces ("Aj" = "AJ"). */
  const textCmp = (mode, a, b) => (mode === 0 || mode === 1 || mode == null)
    ? ((norm(a) === norm(b)) === (mode !== 1)) : (CMP[mode] || CMP[0])(String(a ?? ""), String(b ?? ""));
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /* ------------------------------------------------------------------ text keys */
  /** A line that is really an internal key, e.g. "AJ.2.I.was.wondering.li" (speaker . number . first words). */
  function isKeyLike(s) { return typeof s === "string" && !/\s/.test(s) && /^[A-Za-z][\w'’&-]*\.\d+\.\S+$/.test(s); }
  function humanizeKey(s) {
    const body = String(s).replace(/^[^.]+\.\d+\./, "").replace(/[._]+/g, " ").trim();
    return body ? body + "…" : String(s);
  }
  const looseText = (s) => String(s || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "");
  const isRealText = (s) => typeof s === "string" && /[A-Za-z]/.test(s) && !s.startsWith("cab-") && !isKeyLike(s)
    && (/\s/.test(s) || /[!?.…]$/.test(s));

  /** Collect key -> wording pairs anywhere in an object (node name + text, localisation term + translations...). */
  function harvestPairs(d, map, depth) {
    if (!d || typeof d !== "object" || depth > 3) return;
    if (Array.isArray(d)) { for (const x of d) if (x && typeof x === "object") harvestPairs(x, map, depth + 1); return; }
    let keys = null, real = null, arrs = null;
    for (const [f, v] of Object.entries(d)) {
      if (f === "_k" || f === "_c" || f === "parent") continue;
      if (typeof v === "string") {
        if (isKeyLike(v)) (keys = keys || []).push(v);
        else if (real === null && f !== "m_Name" && isRealText(v)) real = v;
      } else if (Array.isArray(v)) {
        if (v.length && v.every((x) => typeof x === "string")) (arrs = arrs || []).push(v);
        else harvestPairs(v, map, depth + 1);
      } else if (v && typeof v === "object") harvestPairs(v, map, depth + 1);
    }
    if (keys && real === null && arrs) for (const a of arrs) { const r = a.find(isRealText); if (r) { real = r; break; } }
    if (keys && real !== null) for (const k of keys) if (!map.has(k)) map.set(k, real);
    // parallel lists: ["AJ.1.Hi", "AJ.2.I.was..."] next to ["Hi!", "I was wondering..."]
    if (arrs && arrs.length > 1) for (const a of arrs) if (a.some(isKeyLike)) for (const b of arrs)
      if (b !== a && b.length === a.length && b.some(isRealText))
        a.forEach((k, i) => { if (isKeyLike(k) && isRealText(b[i]) && !map.has(k)) map.set(k, b[i]); });
  }
  /** Find "key <separator> wording" in a text file (CSV, TSV, JSON or key=value). */
  function valueAfterKey(text, key) {
    let at = text.indexOf(key);
    while (at >= 0) {
      const before = at > 0 ? text[at - 1] : "\n";
      const rest = text.slice(at + key.length);
      if (/[\s"',;=:|{[]/.test(before)) {
        const m = /^["']?\s*[,;\t=:|]\s*/.exec(rest);
        if (m) {
          let s = rest.slice(m[0].length), v = "";
          if (s[0] === '"') {
            for (let i = 1; i < s.length; i++) {
              if (s[i] === "\\" && s[i + 1]) { v += s[i + 1] === "n" ? "\n" : s[i + 1]; i++; continue; }
              if (s[i] === '"') { if (s[i + 1] === '"') { v += '"'; i++; continue; } break; }
              v += s[i];
            }
          } else v = s.split(/\r?\n/)[0].split("\t")[0];
          v = v.trim();
          if (isRealText(v)) return v;
        }
      }
      at = text.indexOf(key, at + 1);
    }
    return null;
  }

  /* ------------------------------------------------------------------ outfits (premium is free in this port) */
  const OUTFIT_WORD = /(outfit|dress|swim|bikini|wardrobe|cloth|attire|gown|costume|evening|sleepwear|pyjama|(?<![a-z])look(?!ing)|(?<![a-z])wear)/i;
  const BOUGHT_WORD = /(premium|purchas|bought|(?<![a-z])buy|(?<![a-z])paid(?![a-z])|(?<![a-z])gems?(?![a-z])|splurge|(?<![a-z])vip(?![a-z]))/i;
  const BASIC_WORD = /((?<![a-z])default|(?<![a-z])free(?![a-z])|basic|starter|(?<![a-z])plain(?![a-z])|cheap)/i;
  /** +1 if a name/value means "she bought it", -1 if it means "default / didn't buy", 0 if neither. */
  function boughtScore(s) {
    s = String(s ?? "");
    if (/(?:^|[^a-z])(not|no|non|didnt|without)[\s_-]?(premium|purchas|bought|buy|paid|gem)/i.test(s) || /un(purchas|bought|paid)/i.test(s)) return -1;
    if (BOUGHT_WORD.test(s) || /(?:^|[^a-z])(yes|true|success)(?:$|[^a-z])/i.test(s)) return 1;
    if (BASIC_WORD.test(s) || /(?:^|[^a-z])(no|false|fail|failed|cancel|skip)(?:$|[^a-z])/i.test(s)) return -1;
    return 0;
  }
  /** For a story flag about outfits: true = "wearing something bought", false = "wearing the default", null = not one. */
  function outfitFlag(name) {
    if (!name || !OUTFIT_WORD.test(name)) return null;
    const s = boughtScore(name);
    return s > 0 ? true : s < 0 ? false : null;
  }
  function itemIsPremium(it) {
    if (!it) return false;
    for (const [k, v] of Object.entries(it)) {
      if (typeof v === "number" && v > 0 && /cost|price|gem/i.test(k)) return true;
      if (v && (v === true || v === 1) && /premium|paid|purchas/i.test(k)) return true;
    }
    return BOUGHT_WORD.test(it.m_Name || "");
  }

  /* ------------------------------------------------------------------ parameters */
  function paramDefault(p) {
    switch (p.type) {
      case 0: return p.defaultFloatValue || 0;
      case 1: return p.defaultIntValue || 0;
      case 2: case 3: return !!p.defaultBoolValue;
      case 4: return p.defaultStringValue || "";
      default: return null;
    }
  }
  /** Built-in value of one check ("Logic Node Target Parameter (4)"...): never a story variable, whatever its name. */
  const isNodeConst = (name) => /target parameter/i.test(String(name || ""));
  const isParamObj = (o) => !!o && typeof o.type === "number" && ("defaultIntValue" in o || "defaultBoolValue" in o ||
    "defaultStringValue" in o || "defaultFloatValue" in o);

  /** How much a stat modifier ("+", "++", "----", "Affinity +"...) changes a score, with its sign. */
  function statStep(sm) {
    const name = String(sm.m_Name || "");
    const raw = Number(sm.modifier) || 0;
    let sign = 0, run = 0;
    const sym = /(?:^|[^A-Za-z0-9])(\++|-+)(?=$|[^A-Za-z0-9])/g;
    let m, last = null;
    while ((m = sym.exec(name))) last = m[1];
    if (raw < 0) sign = -1;
    else if (last) { sign = last[0] === "+" ? 1 : -1; run = last.length; }
    else if (/(?:^|\s)-\s*\d/.test(name)) sign = -1;
    else if (/(minus|down|decrease|lower|reduce|lose|negative|drop)/i.test(name)) sign = -1;
    else sign = 1;
    const size = Math.abs(raw) || { 1: 5, 2: 10, 3: 15, 4: 30 }[run] || 5;
    return sign * size;
  }

  /* ------------------------------------------------------------------ story memory */
  /** Apply one finished episode's end state on top of a running state. */
  function layerEpisode(st, save, id, defs) {
    const d = (save.states && save.states[id]) || (save.deltas && save.deltas[id]);
    if (d) { Object.assign(st, d); return true; }
    const s = save.snapshots && save.snapshots[id];
    if (!s) return false;
    for (const [k, v] of Object.entries(s)) {
      // Saves from before 1.1.4: an episode that started without its earlier history (Season 3 Day 7 Episode 3 imports
      // Season 2's Day 7 by mistake) saved the file's defaults, e.g. your Day 1 partner as "Bill". A value that is just
      // the file's default must not wipe out something you chose in an earlier episode.
      if (defs && k in defs && defs[k] === v) continue;
      st[k] = v;
    }
    return true;
  }
  /** Everything you've done this season before episode `ep` (the most recent choice wins). */
  function memoryBefore(S, save, ep) {
    const st = {}, defs = S.paramDefaults();
    for (const e of S.episodes) {
      if (e.key === ep.key || e.controllerId === ep.controllerId) break;
      layerEpisode(st, save, e.controllerId, defs);
    }
    return st;
  }
  /** The story state at the end of one episode of this season (null if it hasn't been played). */
  function stateAt(S, save, id) {
    const st = {}, defs = S.paramDefaults();
    for (const e of S.episodes) {
      const had = layerEpisode(st, save, e.controllerId, defs);
      if (e.controllerId === id) return had ? st : null;
    }
    return null;
  }
  /** Same, for another season's save (used when Season 3 looks back at Seasons 1 and 2). */
  function stateInSave(sv, id) {
    if (!sv) return null;
    const order = sv.order || [...new Set(Object.keys(sv.snapshots || {}).concat(Object.keys(sv.deltas || {}), Object.keys(sv.states || {})))];
    if (!order.includes(id)) return null;
    const st = {};
    for (const x of order) { layerEpisode(st, sv, x, null); if (x === id) break; }
    return st;
  }

  class Season {
    constructor(loadJSON, base) {
      this.loadJSON = loadJSON;       // (path) => Promise<any>
      this.base = base.replace(/\/$/, "");
      this.objects = new Map();
      this.loaded = new Set();
      this.warnings = new Map();
      this.notes = [];                // recent decisions, for the problem report
      this.textKeys = new Map();      // internal text key -> real wording
      this.keyMisses = new Set();
    }
    async init() {
      const L = (n) => this.loadJSON(`${this.base}/${n}`);
      [this.episodes, this.controllers, this.sprites, this.backgrounds, this.audio, this.cabs, this.effects] =
        await Promise.all([L("episodes.json"), L("controllers.json"), L("sprites.json"),
          L("backgrounds.json"), L("audio.json"), L("cabs.json"), L("effects.json").catch(() => ({}))]);
      this.effects = this.effects || {};
      this.bundleOfCab = this.cabs;
      this.ctrlById = {};
      for (const c of this.controllers) this.ctrlById[c.id] = c;
      const always = Object.values(this.cabs).filter((b) => /_(avatars|ip_metadata|stories)$/.test(b));
      for (const b of always) await this.loadBundle(b);
      this.indexCharacters();
    }
    async loadBundle(bundle) {
      if (!bundle || this.loaded.has(bundle)) return;
      this.loaded.add(bundle);
      const d = await this.loadJSON(`${this.base}/objects/${bundle}.json`);
      for (const [pid, o] of Object.entries(d.objects)) {
        o._k = `${d.cab}:${pid}`;
        this.objects.set(o._k, o);
        if (o._c === "CharacterSettings") this._charsDirty = true;
      }
    }
    async loadCab(cab) { await this.loadBundle(this.bundleOfCab[cab]); }
    tokensNamed(tok) {
      if (!this._tokens || this._tokensAt !== this.objects.size) {
        this._tokens = new Map();
        for (const o of this.objects.values())
          if (o._c === "StringToken" && o.token) {
            if (!this._tokens.has(o.token)) this._tokens.set(o.token, []);
            this._tokens.get(o.token).push(o);
          }
        this._tokensAt = this.objects.size;
      }
      return this._tokens.get(tok) || [];
    }
    /** One pass over the loaded files: story variables, their file defaults, stats, trait names. */
    _scan() {
      if (this._scanAt === this.objects.size) return;
      this._storyParams = new Set(); this._pdefs = {};
      const stats = new Set(["affinity"]), traits = new Set();
      let neutral = null;
      for (const o of this.objects.values()) {
        const c = o._c;
        if (c === "StoryController" || c === "ReferenceStoryController") {
          for (const r of o.parameterList || []) {
            this._storyParams.add(r);
            const p = this.objects.get(r);
            if (p && p.m_Name && !(p.m_Name in this._pdefs)) this._pdefs[p.m_Name] = paramDefault(p);
          }
        } else if ((c === "StatModification" || c === "StatSetterModification" || c === "StatLogicalCase") && o.parameterName) {
          stats.add(norm(o.parameterName));
        } else if (c === "CharacterTraitsBehaviour") {
          for (const r of o.traitParameters || []) { const p = this.objects.get(r); if (p && p.m_Name) traits.add(norm(p.m_Name)); }
        }
        if (o.valueRange && neutral === null && /neutral/i.test(o.m_Name || ""))
          neutral = Math.round((Number(o.valueRange.x) + Number(o.valueRange.y)) / 2);
      }
      this._stats = stats; this._traitNames = traits;
      this._statStart = Number.isFinite(neutral) ? neutral : 50;
      this._scanAt = this.objects.size;
    }
    isStoryParam(p) { this._scan(); return this._storyParams.has(p._k) || /^GLOBAL_/i.test(p.m_Name); }
    paramDefaults() { this._scan(); return this._pdefs; }
    /** Relationship scores (affinity...) are 0-100 stats that start at neutral. */
    isStat(name) { this._scan(); return !!name && this._stats.has(norm(name)); }
    statStart() { this._scan(); return this._statStart; }
    isTraitName(name) { this._scan(); return !!name && this._traitNames.has(norm(name)); }
    get(k) { return k ? this.objects.get(k) : undefined; }
    warn(what) { this.warnings.set(what, (this.warnings.get(what) || 0) + 1); }
    note(kind, info) {
      this.notes.push(Object.assign({ kind }, info || {}));
      if (this.notes.length > 200) this.notes.splice(0, this.notes.length - 200);
    }
    /** Declared type of each of an Islander's traits (0 float, 1 int, 2/3 on/off, 4 text). */
    traitTypes(k) {
      this._ttypes = this._ttypes || new Map();
      if (this._ttypes.has(k)) return this._ttypes.get(k);
      const out = {}, c = this.characters && this.characters[k];
      if (c && c.traits) for (const r of c.traits.traitParameters || []) { const p = this.get(r); if (p && p.m_Name) out[p.m_Name] = p.type; }
      this._ttypes.set(k, out);
      return out;
    }
    /** Copies of the same Islander in different packs count as one person (their art and scores stay together). */
    canon(k) { return (k && this.canonMap && this.canonMap[k]) || k; }
    /**
     * Roles like "your partner" are matched by name, not by which pack the story file sits in: each pack can carry
     * its own copy of the role, and a copy must never fall back to its default Islander.
     */
    refId(refKey) {
      const o = this.get(refKey);
      const n = o && (o.m_Name || o.referenceName);
      return n ? "R:" + norm(n) : refKey;
    }

    /** Load every bundle an episode's story graph can reach. */
    async prepare(controllerKey) {
      const seen = new Set();
      const stack = [controllerKey];
      while (stack.length) {
        const k = stack.pop();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        let o = this.get(k);
        if (!o) {
          const cab = k.split(":")[0];
          if (this.bundleOfCab[cab] && !this.loaded.has(this.bundleOfCab[cab])) {
            await this.loadCab(cab);
            o = this.get(k);
          }
        }
        if (!o) continue;
        if (k !== controllerKey && (o._c === "StoryController" || o._c === "EpisodeInformation")) continue;
        collectRefs(o, stack);
      }
      if (this._charsDirty) this.indexCharacters();
      // Lines stored as internal keys (e.g. "AJ.2.I.was.wondering.li"): find their real wording before playing.
      const keys = new Set();
      for (const k of seen) {
        const o = this.get(k);
        if (!o) continue;
        if (isKeyLike(o.text) && !isRealText(o.femaleText) && !isRealText(o.maleText)) keys.add(o.text);
        else if (!o.text && isKeyLike(o.femaleText)) keys.add(o.femaleText);
        else if (!o.text && /Choice$/.test(o._c || "") && isKeyLike(o.m_Name)) keys.add(o.m_Name);
      }
      if (keys.size) {
        try { await this.resolveTextKeys(keys); } catch (e) { this.warn("text lookup failed"); }
      }
    }

    textForKey(key) { return this.textKeys.get(key) || null; }
    /** Wording supplied from outside the season files (fan-written fill-ins in player/fill_in_lines.json). */
    addTextKeys(map) {
      this.fanKeys = this.fanKeys || new Set();
      for (const [k, v] of Object.entries(map || {}))
        if (typeof v === "string" && v && !this.textKeys.has(k)) { this.textKeys.set(k, v); this.fanKeys.add(k); }
    }
    async resolveTextKeys(keys) {
      const want = () => [...keys].filter((k) => !this.textKeys.has(k));
      if (!want().length) return;
      this.harvestText(this.objects.values(), want());
      if (!want().length) return;
      if (this.texts === undefined) this.texts = await this.loadJSON(`${this.base}/texts.json`).catch(() => null);
      if (this.texts) {
        for (const k of want()) for (const t of Object.values(this.texts)) {
          const v = valueAfterKey(typeof t === "string" ? t : (t && t.text) || "", k);
          if (v) { this.textKeys.set(k, v); break; }
        }
      }
      // Still missing: look through the story packs this episode doesn't use (once per pack, without keeping them).
      this._textScanned = this._textScanned || new Set();
      for (const b of Object.values(this.cabs)) {
        if (!want().length) break;
        if (this.loaded.has(b) || this._textScanned.has(b) || !/_stories/.test(b)) continue;
        this._textScanned.add(b);
        const d = await this.loadJSON(`${this.base}/objects/${b}.json`).catch(() => null);
        if (d) this.harvestText(Object.values(d.objects), want());
      }
    }
    harvestText(objs, want) {
      const fuzzy = want.map((k) => ({ k, who: norm(k.split(".")[0]), p: looseText(humanizeKey(k)) })).filter((f) => f.p.length >= 8);
      for (const o of objs) {
        harvestPairs(o, this.textKeys, 0);
        if (!fuzzy.length || !LINE_NODES.has(o._c) || !isRealText(o.text)) continue;
        // Last resort: the key spells out the start of the line, so find that line by the same speaker.
        const lt = looseText(o.text);
        const who = norm((this.characters && this.characters[o.character] || {}).name);
        const tag = norm(String(o.m_Name || "").split(".")[0]);
        for (const f of fuzzy) {
          if (this.textKeys.has(f.k) || !lt.startsWith(f.p)) continue;
          if (f.who && who !== f.who && tag !== f.who) continue;
          this.textKeys.set(f.k, o.text);
          this.note("text-matched", { key: f.k });
        }
      }
    }

    indexCharacters() {
      this._charsDirty = false;
      this.characters = {};
      this.playerKey = null;
      this.behaviourOwner = {};
      this.canonMap = {};
      for (const o of this.objects.values()) {
        if (o._c !== "CharacterSettings") continue;
        const info = { key: o._k, name: o.characterName || o.m_Name, gender: o.gender, avatar: null, traits: null, isPlayer: false,
          prop: !o.characterName };   // no display name: a prop such as Season 1's paintings, not an Islander
        for (const b of o.behaviours || []) {
          this.behaviourOwner[b] = o._k;
          const bo = this.get(b);
          if (!bo) continue;
          if (bo._c === "AvatarBehaviour") info.avatar = bo.avatar || firstRefOfClass(this, bo, "Avatar");
          if (bo._c === "CharacterTraitsBehaviour") info.traits = bo;
          if (bo._c === "PlayerBehaviour") { info.isPlayer = true; info.avatar = bo.avatar || (bo.avatars || [])[0] || null; }
        }
        this.characters[o._k] = info;
      }
      // Which character is you: the player defined in this season's avatar pack (Seasons 1-2), otherwise the avatar
      // pack's own "Player (...)" character - in Season 3 that's "Rica" (art "Player (2020)"). Season 3's story packs
      // also carry leftover Season 2-style players ("You", art "Player (2019)"); they are not you in Season 3.
      const inAv = (k) => /_avatars$/.test(this.bundleOfCab[k.split(":")[0]] || "");
      const avName = (c) => (this.get(c.avatar) || {}).m_Name || "";
      const all = Object.values(this.characters);
      const me = all.filter((c) => c.isPlayer && inAv(c.key)).pop()
        || all.find((c) => inAv(c.key) && /^Player\b/.test(avName(c)))
        || all.find((c) => c.isPlayer)
        || all.find((c) => /^Player/.test(avName(c)));
      if (me) { this.playerKey = me.key; me.isPlayer = true; }
      // A leftover copy of an Islander inside a story pack (same name, same art) is the avatar pack's Islander.
      // Characters in the avatar pack itself are never merged: Season 1 deliberately has several that share a name and
      // art (Levi, Player_Partner, Lie_Detector_Partner... are all "Levi" until the story assigns the shared roles).
      const main = new Map();
      for (const c of Object.values(this.characters))
        if (!c.isPlayer && c.name && inAv(c.key)) {
          const id = norm(c.name) + "|" + (c.avatar || "");
          main.set(id, main.has(id) ? null : c.key);          // null: more than one, so no safe match
        }
      for (const c of Object.values(this.characters)) {
        if (c.isPlayer) { if (c.key !== this.playerKey) this.canonMap[c.key] = this.playerKey; continue; }   // other players: you
        if (!c.name || inAv(c.key)) continue;
        const m = main.get(norm(c.name) + "|" + (c.avatar || ""));
        if (m && m !== c.key) this.canonMap[c.key] = m;
      }
      this._ttypes = new Map();
      this.islanders = Object.values(this.characters).filter((c) => !c.isPlayer && !this.canonMap[c.key]).map((c) => c.key);
      this._avFix = new Map();
    }

    /**
     * Data quirk fix: an Islander drawn with another Islander's art (Season 1's "Miles" uses Jasper's avatar in
     * episodes 10-12). When the art is clearly named after someone else and the Islander's own art exists, use theirs.
     */
    avatarForName(name, ak) {
      if (!name || !ak) return ak;
      const ck = norm(name) + "|" + ak;
      if (this._avFix && this._avFix.has(ck)) return this._avFix.get(ck);
      const out = this._avatarForName(name, ak);
      (this._avFix = this._avFix || new Map()).set(ck, out);
      return out;
    }
    _avatarForName(name, ak) {
      const av = this.get(ak);
      if (!av || !av.m_Name) return ak;
      const words = new Set(norm(av.m_Name).split(/[^a-z]+/).filter(Boolean));
      const me = norm(name).split(/[^a-z]+/).filter((w) => w.length > 1);
      if (!me.length || me.some((w) => words.has(w))) return ak;          // the art is theirs
      const others = Object.values(this.characters).filter((c) => !c.isPlayer && c.name && norm(c.name) !== norm(name))
        .map((c) => norm(c.name));
      if (!others.some((n) => words.has(n))) return ak;                   // generic art: leave it
      const cands = [];
      for (const o of this.objects.values())
        if (o._c === "Avatar" && o._k !== ak && o.m_Name && norm(o.m_Name).split(/[^a-z]+/).includes(me[0])) cands.push(o);
      if (!cands.length) return ak;
      cands.sort((a, b) => a.m_Name.length - b.m_Name.length);
      this.note("art-fixed", { who: name, from: av.m_Name, to: cands[0].m_Name });
      return cands[0]._k;
    }
  }

  function firstRefOfClass(season, obj, cls) {
    const refs = [];
    collectRefs(obj, refs);
    for (const r of refs) { const o = season.get(r); if (o && o._c === cls) return r; }
    return null;
  }

  function collectRefs(v, out) {
    if (typeof v === "string") { if (v.startsWith("cab-")) out.push(v); }
    else if (Array.isArray(v)) for (const x of v) collectRefs(x, out);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "_k" && k !== "parent") collectRefs(x, out);
  }

  /* ------------------------------------------------------------------ save state */
  function newSave(seasonName) {
    return {
      season: seasonName, version: 2, playerName: "", completed: [], fixes: { aff50: 1, stat0: 1, onoff: 1 },
      states: {},               // controllerId -> every story variable at the end of that episode
      order: [],                // controllerIds in the order they were finished
      snapshots: {},            // (saves from before 1.1.4) the same, but may hold defaults an episode started with by mistake
      globals: {},              // GLOBAL_* params carried forward
      traits: {},               // characterKey -> {trait: value}
      refs: {},                 // "R:<role name>" -> characterKey  (who plays "your partner" etc.)
      refLog: [],               // recent role changes, for the problem report
      skins: {}, custom: {},    // characterKey -> skin name / {skin|slot: customizationKey}
      inventory: {}, current: null,
    };
  }

  /* ------------------------------------------------------------------ episode run */
  class Run {
    constructor(season, save, episode, resume) {
      this.S = season; this.save = save; this.ep = episode;
      this.ctrl = season.get(episode.controller);
      this.frames = [];       // {root, ctrl, ret}
      this.node = null; this.pending = null; this.done = false;
      this.view = { bg: bgFile(season, episode.loadingBackground), stage: [], overflow: [], expr: {}, music: null, sfx: null, toast: null, met: [] };
      this.visited = {};      // open world node -> [location names]
      this.log = [];
      this.trace = [];        // last nodes visited (problem report)
      save.refs = save.refs || {};
      this._store({}, [], []);
      if (resume) this.restore(resume);
      else this.start();
    }

    /* ---------- params ---------- */
    /**
     * Story variables. Every episode starts from the end state of the episodes before it (see recall), even when its
     * own import points somewhere else, so it can never start over from the file's defaults. Writes made during the
     * episode are tracked as "touched" (used to tell a real value from a never-set default).
     */
    _store(obj, touched, remembered) {
      this.raw = obj;
      this.touched = new Set(touched || []);
      this.remembered = new Set(remembered || []);
      const self = this;
      this.params = new Proxy(obj, {
        set(t, k, v) { t[k] = v; if (typeof k === "string") self.touched.add(k); return true; },
      });
    }
    /** True if a variable holds a real value (set in this episode or remembered from an earlier one). */
    known(name) { return !!name && (this.touched.has(name) || this.remembered.has(name)); }
    paramValue(name) { name = this.vname(name); return name ? this.raw[name] : undefined; }
    /** Season 2's murder mystery names some variables with a stray brace ("{CMM_E00_partner"): use the real one. */
    vname(name) {
      if (!name || typeof name !== "string" || !/[{}]/.test(name) || name in this.raw) return name;
      const n = name.replace(/[{}]/g, "").trim();
      return n in this.raw || n in this.S.paramDefaults() ? n : name;
    }
    paramName(ref) { const p = this.S.get(ref); return p ? p.m_Name : null; }
    paramDefault(p) { return paramDefault(p); }
    /** Starting value of a variable: its file default, except that relationship stats start at neutral. */
    startValue(p) {
      const d = paramDefault(p);
      // A 0-100 score whose file default is 0 starts at neutral. On/off values (Season 3's own cast has an on/off
      // "affinity": a spark or not) stay on/off.
      if (this.S.isStat(p.m_Name) && (p.type === 0 || p.type === 1) && d === 0) return this.S.statStart();
      return d;
    }
    initParams(ctrl) {
      for (const r of ctrl.parameterList || []) {
        const p = this.S.get(r);
        if (p && p.m_Name && !isNodeConst(p.m_Name) && !(p.m_Name in this.raw)) this.raw[p.m_Name] = this.startValue(p);
      }
    }
    getParamByRef(ref) {
      const p = this.S.get(ref);
      if (!p) return undefined;
      // A check's own built-in value ("Logic Node Target Parameter"...) is always its own value. Fusebox gave hundreds
      // of them the same few names, and a story variable elsewhere with the same name must never stand in for it
      // (it made Season 1 checks compare your choice against "true" or "conciliatory" instead of "levi").
      if (p.hidden || isNodeConst(p.m_Name) || (!this.S.isStoryParam(p) && !(p.m_Name in this.raw))) return paramDefault(p);
      if (p.m_Name in this.raw) return this.raw[p.m_Name];
      return (this.raw[p.m_Name] = this.startValue(p));
    }
    isParamRef(k) { return typeof k === "string" && k.startsWith("cab-") && isParamObj(this.S.get(k)); }
    /** Value of a {parameter, constant, value} field (or of a bare link to a variable). */
    val(f) {
      if (typeof f === "string") return this.isParamRef(f) ? this.getParamByRef(f) : f;
      if (!f || typeof f !== "object") return f;
      if (f.constant || !f.parameter) return f.value;
      return this.getParamByRef(f.parameter);
    }
    /** A text value to store. The app fills in tokens first: "{PAC}" is stored as your partner's name, not "{PAC}". */
    textValue(f) {
      const v = String(this.val(f) ?? "");
      return /\{[A-Za-z0-9_]+\}/.test(v) ? this.fmt(v) : v;
    }
    /** Name of the variable a field reads, or null for a constant. */
    refParamName(f) {
      if (typeof f === "string") return this.isParamRef(f) ? this.paramName(f) : null;
      if (f && typeof f === "object" && f.parameter && !f.constant) return this.paramName(f.parameter);
      return null;
    }
    setParam(name, v) { if (name) this.params[name] = v; }
    setParamRef(f, v) {
      const pk = typeof f === "string" ? f : f && f.parameter;
      if (pk) { const n = this.paramName(pk); if (n) this.params[n] = v; }
    }
    /** Bring back everything you've done this season before this episode (most recent wins). */
    /** keepOwn: an import partway through an episode must not undo what you chose earlier in this same episode. */
    recall(keepOwn) {
      const mem = memoryBefore(this.S, this.save, this.ep);
      for (const [k, v] of Object.entries(mem)) {
        if (keepOwn && this.touched.has(k)) continue;
        if (isNodeConst(k)) continue;                       // never a story variable (older saves may hold one)
        this.raw[k] = v; this.remembered.add(k);
      }
      return mem;
    }

    /* ---------- characters ---------- */
    ck(k) { return k ? this.S.canon(k) : k; }
    resolveRef(refKey) {
      if (!refKey) return null;
      const refs = this.save.refs, id = this.S.refId(refKey);
      if (refs[id]) return this.ck(refs[id]);
      if (refs[refKey]) {                       // saved by an older version under the pack's own copy
        refs[id] = refs[refKey];
        if (id !== refKey) delete refs[refKey];
        return this.ck(refs[id]);
      }
      const r = this.S.get(refKey);
      return r ? this.ck(r.character) : null;
    }
    hasRef(refKey) { return !!(refKey && (this.save.refs[this.S.refId(refKey)] || this.save.refs[refKey])); }
    setRef(refKey, charKey, why) {
      if (!refKey || !charKey) return;
      const id = this.S.refId(refKey), k = this.ck(charKey), refs = this.save.refs;
      const before = refs[id] || refs[refKey] || null;
      refs[id] = k;
      if (id !== refKey) delete refs[refKey];
      if (before !== k) {
        const log = (this.save.refLog = this.save.refLog || []);
        log.push({ ep: this.ep.key, role: (this.S.get(refKey) || {}).m_Name || refKey, now: this.charName(k),
          was: before ? this.charName(before) : "(default)", why: why || "" });
        if (log.length > 60) log.splice(0, log.length - 60);
      }
    }
    charOf(o) {
      if (!o) return null;
      if (o.player) return this.S.playerKey;
      if (o.useReferenceCharacter || (!o.character && o.referenceCharacter)) return this.resolveRef(o.referenceCharacter);
      return this.ck(o.character) || null;
    }
    charName(k) {
      if (!k) return "";
      if (k === this.S.playerKey) return this.save.playerName || "You";
      k = this.ck(k);
      const role = (this.save.roles || {})[k];
      if (role && role.name) return role.name;
      const c = this.S.characters[k];
      return c ? c.name : "";
    }
    traitsFor(k) {
      k = this.ck(k);
      if (!k) return {};
      if (!this.save.traits[k]) {
        // an older save may hold this Islander's scores under a pack copy
        for (const [alias, to] of Object.entries(this.S.canonMap || {}))
          if (to === k && this.save.traits[alias]) { this.save.traits[k] = this.save.traits[alias]; delete this.save.traits[alias]; break; }
      }
      if (!this.save.traits[k]) {
        const t = {};
        const c = this.S.characters[k];
        if (c && c.traits) for (const r of c.traits.traitParameters || []) {
          const p = this.S.get(r);
          if (p && p.m_Name) t[p.m_Name] = this.startValue(p);
        }
        this.save.traits[k] = t;
      }
      const t = this.save.traits[k];
      // Scores are numbers from 0 to 100 (an on/off trait stays on/off).
      const types = this.S.traitTypes(k);
      for (const n of Object.keys(t)) if (typeof t[n] !== "number" && this.S.isStat(n) && (types[n] === 0 || types[n] === 1)) t[n] = this.S.statStart();
      return t;
    }
    /** A stat's current value (neutral if it has none yet; an on/off one counts as "like" when on). */
    statOf(store, name) {
      const v = store[name];
      if (typeof v === "boolean") return v ? 70 : this.S.statStart();
      return typeof v === "number" && Number.isFinite(v) ? v : this.S.statStart();
    }
    /** Which Islander a trait node is about. */
    charFromTraits(ref, n) {
      const tb = this.S.get(ref);
      let k = tb && (tb.characterSettings || tb.character || null);
      if (!k && ref) k = this.S.behaviourOwner[ref] || null;
      if (!k && tb && tb._c === "CharacterSettings") k = ref;
      if (!k && n) k = n.character || n.characterSettings || null;
      if (!k) this.S.warn("trait node without a character");
      return this.ck(k) || null;
    }

    /* ---------- flow ---------- */
    start() {
      this.initParams(this.ctrl);
      this.recall();
      for (const [k, v] of Object.entries(this.save.globals || {})) if (k in this.raw) this.raw[k] = v;
      for (const [k, v] of Object.entries(this.save.custParams || {})) if (k in this.raw) this.raw[k] = v;
      this.frames.push({ root: this.ctrl.rootGraph, ctrl: this.ctrl._k, ret: null });
      this.enterGraph(this.ctrl.rootGraph);
    }

    enterGraph(gk) {
      const g = this.S.get(gk);
      if (!g) { this.S.warn("missing graph"); return this.exitGraph(gk); }
      if (g.defaultNode) return this.enter(g.defaultNode);
      for (const t of g.entryTransitions || []) { const to = this.S.get(t); if (to && to.destination) return this.enter(to.destination); }
      return this.exitGraph(gk);
    }

    exitGraph(gk) {
      const top = this.frames[this.frames.length - 1];
      if (!top) { this.done = true; return; }
      if (gk === top.root) {
        this.frames.pop();
        if (!this.frames.length) { this.done = true; return; }
        return this.follow(top.ret, "Out");
      }
      const g = this.S.get(gk);
      const P = g ? this.S.get(g.parent) : null;
      if (!P || P._c !== "Story") { this.frames.length = 1; return this.exitGraph(this.frames[0].root); }
      for (const tk of P.graphTransitions || []) {
        const t = this.S.get(tk);
        if (t && t.sourceGraph === gk) {
          if (t.destination) return this.enter(t.destination);
          if (t.destinationGraph) return this.enterGraph(t.destinationGraph);
          return this.exitGraph(P._k);
        }
      }
      return this.exitGraph(P._k);
    }

    follow(nk, slot) {
      const n = this.S.get(nk);
      if (!n) { this.done = true; return; }
      const ts = (n.transitions || []).map((t) => this.S.get(t)).filter((t) => t && !t.mute && this.conditionsPass(t.conditions));
      let t = ts.find((x) => x.fromSlot === slot);
      if (!t && slot !== "Out") t = ts.find((x) => x.fromSlot === "Out");
      if (!t && slot === "Out" && ts.length === 1) t = ts[0];
      if (!t) return this.exitGraph(n.parent);
      return this.take(t, n);
    }
    take(t, n) {
      if (t.destination) return this.enter(t.destination);
      if (t.destinationGraph) return this.enterGraph(t.destinationGraph);
      return this.exitGraph(n.parent);
    }

    enter(nk) {
      this.queue = nk;   // processed by step()
    }

    /** Run until the story needs the player. Returns the pending step. */
    step() {
      let guard = 0;
      while (!this.pending && !this.done) {
        if (++guard > MAX_STEPS) { this.S.warn("step limit"); this.done = true; break; }
        const nk = this.queue; this.queue = null;
        if (!nk) { this.done = true; break; }
        this.process(nk);
      }
      if (this.done) { this.finish(); return { type: "end" }; }
      return this.pending;
    }

    process(nk, startAction) {
      const n = this.S.get(nk);
      if (!n) { this.S.warn("missing node"); this.done = true; return; }
      this.node = nk;
      if (!startAction) {
        this.trace.push([nk, n._c, n.m_Name || ""]);
        if (this.trace.length > 80) this.trace.shift();
      }
      const acts = n.actions || [];
      for (let i = startAction || 0; i < acts.length; i++) {
        this.action(this.S.get(acts[i]));
        if (this.pending) { this.resumeAt = i + 1; return; }
        if (this.done) return;
      }
      this.resumeAt = acts.length;
      if (this.done || this.pending) return;
      const c = n._c;
      if (c === "ParticleEffectNode") this.queueEffect(n);
      if (LINE_NODES.has(c)) {
        const text = this.text(n);
        if (!text) return this.follow(nk, "Out");
        this.pending = this.lineStep(n, text);
        return;
      }
      if (CHOICE_NODES.has(c)) {
        const opts = [];
        const names = (n.choices || []).map((ck) => (this.S.get(ck) || {}).m_Name);
        (n.choices || []).forEach((ck, i) => {
          const ch = this.S.get(ck);
          if (!ch) return;
          if (!this.conditionsPass(ch.conditions)) return;
          const image = (ch.image && this.S.sprites[ch.image]) || null;
          opts.push({ i, occ: names.slice(0, i).filter((x) => x === ch.m_Name).length, key: ck, slot: ch.m_Name, raw: ch.text || "",
            text: this.fmt(this.choiceText(ch), n.tokens),
            premium: /Premium/.test(ch._c), gems: ch.gemCosts || 0, image, outfit: image ? null : this.optionOutfit(n, ch) });
        });
        // Outfit previews only for a real outfit choice: options that put you in different outfits.
        const CLOTHES = /bikini|swim|dress|outfit|pyjama|pajama|nightie|onesie|robe|kimono|gown|skirt|shorts|jeans|trousers|shirt|top\b|jumpsuit|playsuit|lingerie|cami|vest|suit\b|wear\b|get changed|leopard|sequin|crochet|frill|strapp/i;
        if (new Set(opts.map((o) => o.outfit).filter(Boolean)).size < 2 || opts.filter((o) => CLOTHES.test(o.text)).length < 2)
          for (const o of opts) o.outfit = null;
        if (!opts.length) (n.choices || []).forEach((ck, i) => {
          const ch = this.S.get(ck);
          if (ch) opts.push({ i, occ: names.slice(0, i).filter((x) => x === ch.m_Name).length, key: ck, slot: ch.m_Name, raw: ch.text || "",
            text: this.fmt(this.choiceText(ch), n.tokens) });
        });
        // Outfit choices ("What to wear...", Season 1): show you wearing each option.
        const looks = opts.map((o) => this.optionOutfit(n, this.S.get(o.key)));
        if (looks.filter(Boolean).length >= 2) {
          const now = this.save.skins[this.S.playerKey] || null;   // an option that keeps your outfit shows what you're wearing
          opts.forEach((o, i) => { if (looks[i] || now) o.outfit = looks[i] || now; });
        }
        const prompt = this.text(n);
        const sk = this.speakerOf(n);
        this.narrFocus = !sk && prompt ? this.narrationFocus(prompt) : null;
        this.pending = { type: "choice", prompt, speaker: sk, options: opts, view: this.viewSnap(sk) };
        return;
      }
      switch (c) {
        case "OpenWorldNode": return this.openWorld(n);
        case "LogicNode": {
          let a = this.paramValue(n.selectedParameterName);
          const b = this.getParamByRef(n.targetParameter);
          const of = outfitFlag(n.selectedParameterName);
          if (of !== null && typeof b === "boolean") { a = of; this.S.note("outfit-check", { name: n.selectedParameterName, as: of }); }
          return this.follow(nk, (CMP[n.comparisonMode] || CMP[0])(a, b) ? "TrueSlot" : "Out");
        }
        case "StoryLogicNode": return this.follow(nk, this.firstCase(n.logicalCases, (lc) => this.storyCase(lc)));
        case "CharacterTraitLogicNode": {
          const ch = this.charFromTraits(n.characterTraits, n);
          return this.follow(nk, this.firstCase(n.logicalCases, (lc) => this.traitCase(ch, lc)));
        }
        case "ReferenceCharacterTraitLogicNode": {
          const ch = this.resolveRef(n.referenceCharacter);
          return this.follow(nk, this.firstCase(n.logicalCases, (lc) => this.traitCase(ch, lc)));
        }
        case "StoryModificationNode":
          for (const m of n.modifications || []) this.modify(this.S.get(m), null);
          return this.follow(nk, "Out");
        case "CharacterTraitModificationNode": {
          const ch = this.charFromTraits(n.characterTraits, n);
          if (ch) this.lastTraitChar = ch;
          for (const m of n.modifications || []) this.modify(this.S.get(m), ch, true);
          return this.follow(nk, "Out");
        }
        case "ReferenceCharacterTraitModificationNode": {
          const ch = this.resolveRef(n.referenceCharacter);
          if (ch) this.lastTraitChar = ch;
          for (const m of n.modifications || []) this.modify(this.S.get(m), ch, true);
          return this.follow(nk, "Out");
        }
        case "ABTestNode": return this.follow(nk, "A");
        case "DependencyMatrixNode": this.dependencyMatrix(n); return this.follow(nk, "Out");
        case "ReferenceStoryNode": {
          const rc = this.S.get(n.referenceStoryController);
          if (!rc || !rc.rootGraph) { this.S.warn("missing reference story"); return this.follow(nk, "Out"); }
          this.initParams(rc);
          this.frames.push({ root: rc.rootGraph, ctrl: rc._k, ret: nk });
          return this.enterGraph(rc.rootGraph);
        }
        case "WardrobeNode": {
          const tree = n.ClothingCustomizationTree || n.CustomizationTree || n.customizationTree;
          if (tree) { this.pending = { type: "customize", tree, char: this.S.playerKey, fromAction: false, view: this.viewSnap(null) }; return; }
          this.setOutfitFlags(); this.markPremiumOutfit();
          return this.afterWardrobe(n);
        }
        case "Story": return this.enterGraph(nk);
        default:
          if (!["StoryNode", "ShutterNode", "DebugNode"].includes(c)) this.S.warn("node " + c);
          return this.follow(nk, "Out");
      }
    }

    /** The outfit an option puts you in (found a few steps down its path), so the option can show you wearing it. */
    optionOutfit(n, ch) {
      const t = (n.transitions || []).map((x) => this.S.get(x)).find((x) => x && !x.mute && x.fromSlot === ch.m_Name);
      const pc = this.S.characters[this.S.playerKey], av = pc && this.S.get((this.save.avatars || {})[this.S.playerKey] || pc.avatar);
      if (!t || !av) return null;
      if (!this._skinNames || this._skinNamesAv !== av._k) { this._skinNames = new Set((av.skins || []).map((x) => (this.S.get(x) || {}).m_Name)); this._skinNamesAv = av._k; }
      let k = t.destination;
      for (let i = 0; i < 6 && k; i++) {
        const d = this.S.get(k);
        if (!d) break;
        for (const a of d.actions || []) {
          const A = this.S.get(a);
          if (!A || A._c !== "SetSkin" || this.charOf(A) !== this.S.playerKey) continue;
          const name = A.IsSkinNameSelected === 0 ? this.val(A.skinNameParameter) : A.skinName;
          if (name && name !== "Default" && this._skinNames.has(name)) return name;
        }
        for (const a of d.actions || []) {          // Season 1 also stores the outfit in a variable first
          const A = this.S.get(a);
          if (A && A._c === "SetString" && A.value && A.value.constant && this._skinNames.has(A.value.value) && A.value.value !== "Default") return A.value.value;
        }
        for (const m of d.modifications || []) {
          const M = this.S.get(m);
          if (M && M._c === "StringModification" && M.newValue && M.newValue.constant && this._skinNames.has(M.newValue.value) && M.newValue.value !== "Default") return M.newValue.value;
        }
        if ((LINE_NODES.has(d._c) || CHOICE_NODES.has(d._c)) && (d.text || d.femaleText)) break;   // only the steps right after the pick
        const nx = (d.transitions || []).map((x) => this.S.get(x)).filter((x) => x && !x.mute);
        if (nx.length !== 1) break;
        k = nx[0].destination;
      }
      return null;
    }

    /** Emoji burst ("exploji"): picture, how many, and who it bursts from. Plays with the next thing shown. */
    queueEffect(n) {
      const base = this.S.effects[n.baseParticleEffect];
      if (!base || !base.tex) return;
      const ps = base.ps || {}, use = base.use || {};
      const pick = (k, nodeVal, psVal, dflt) => (use[k] && base[k] ? base[k] : (nodeVal || psVal || dflt));
      const name = base.name || "";
      let who = null;
      if (/player/i.test(name)) who = this.S.playerKey;
      else who = this.lastTraitChar || this.lastSpeaker || null;
      this.view.effect = {
        tex: base.tex, name,
        count: Math.max(3, Math.min(30, Math.round(pick("count", n.particleCount, ps.count, 10)))),
        size: pick("size", n.particleSize, ps.size, 50),
        char: who, left: /left/i.test(name), n: Math.random(),
      };
    }

    firstCase(cases, test) {
      for (const ck of cases || []) {
        const lc = this.S.get(ck);
        if (lc && test(lc)) return lc.m_Name;
      }
      return "Out";
    }

    storyCase(lc) {
      const name = this.vname(lc.parameterName);
      if (lc._c === "InventoryLogicalCase") {
        let have = this.save.inventory[name] || 0;
        const want = Number(this.val(lc.targetValue)) || 0;
        // Outfits cost gems in the app and are free here: you always own them.
        if (OUTFIT_WORD.test(name || "")) have = Math.max(have, want, 1);
        return (CMP[lc.comparisonMode] || CMP[0])(have, want);
      }
      let a = this.paramValue(name);
      const b = this.val(lc.targetValue);
      if (lc._c === "BoolLogicalCase") {
        const of = outfitFlag(name);
        if (of !== null) { a = of; this.S.note("outfit-check", { name, as: of }); }
        return (CMP[lc.comparisonMode] || CMP[0])(!!a, !!b);
      }
      if (lc._c === "IntLogicalCase" || lc._c === "FloatLogicalCase") return (CMP[lc.comparisonMode] || CMP[0])(Number(a) || 0, Number(b) || 0);
      if (lc._c === "StatLogicalCase") return this.statCompare(this.statOf(this.raw, name), b, lc.comparisonMode);
      return textCmp(lc.comparisonMode, a, b);
    }

    traitCase(ch, lc) {
      const t = this.traitsFor(ch);
      const a = t[lc.parameterName];
      const b = this.val(lc.targetValue);
      if (lc._c === "StatLogicalCase") return this.statCompare(this.statOf(t, lc.parameterName), b, lc.comparisonMode);
      if (lc._c === "BoolLogicalCase") return (CMP[lc.comparisonMode] || CMP[0])(!!a, !!b);
      if (lc._c === "IntLogicalCase" || lc._c === "FloatLogicalCase") return (CMP[lc.comparisonMode] || CMP[0])(Number(a) || 0, Number(b) || 0);
      return textCmp(lc.comparisonMode, a, b);
    }

    statCompare(v, rangeRef, mode) {
      const r = this.S.get(rangeRef);
      if (!r || !r.valueRange) return false;
      const lo = r.valueRange.x, hi = r.valueRange.y;
      switch (mode) {
        case 0: return v >= lo && v <= hi;
        case 1: return v < lo || v > hi;
        case 2: return v < lo;
        case 3: return v > hi;
        case 4: return v >= lo;
        case 5: return v <= hi;
      }
      return false;
    }

    /** Apply one modification. `traitNode`: it belongs to an Islander, so never write it into story variables. */
    modify(m, ch, traitNode) {
      if (!m) return;
      if (traitNode && !ch) { this.S.warn("trait change without a character"); return; }
      const store = ch ? this.traitsFor(ch) : this.params;
      const name = ch ? m.parameterName : this.vname(m.parameterName);
      if (!name) return;
      switch (m._c) {
        case "StatModification": {
          const sm = this.S.get(this.val(m.newValue));
          if (!sm) return;
          const stat = this.S.get(sm.stat);
          const max = (stat && stat.maximumValue) || 100;
          const step = statStep(sm);
          if (typeof store[name] === "boolean") { if (step) store[name] = step > 0; return; }   // on/off: a raise switches it on
          store[name] = Math.max(0, Math.min(max, this.statOf(store, name) + step));
          return;
        }
        case "StatSetterModification": {
          const r = this.S.get(this.val(m.newValue));
          if (r && r.valueRange) store[name] = Math.round((r.valueRange.x + r.valueRange.y) / 2);
          return;
        }
        case "IntModification": store[name] = Number(this.val(m.newValue)) || 0; return;
        case "FloatModification": store[name] = Number(this.val(m.newValue)) || 0; return;
        case "BoolModification": store[name] = !!this.val(m.newValue); return;
        case "StringModification": store[name] = this.textValue(m.newValue); return;
        default: this.S.warn("modification " + m._c);
      }
    }

    dependencyMatrix(n) {
      const rows = (n.selectedGroupRecords || []).map((r) => r.columns || []);
      if (!rows.length) return;
      const key = rows[0], cur = norm(this.paramValue(key[0]));
      const col = key.findIndex((v, i) => i > 0 && v && norm(v) === cur);
      if (col < 1) { if (cur) this.S.note("matrix-nomatch", { name: key[0], value: cur }); return; }
      for (const r of rows.slice(1)) if (r[0] && r[col]) this.params[r[0]] = /\{[A-Za-z0-9_]+\}/.test(r[col]) ? this.fmt(r[col]) : r[col];
    }

    conditionsPass(conds) {
      for (const ck of conds || []) {
        const c = this.S.get(ck);
        if (!c || c.enabled === 0) continue;
        if (c._c === "CompareString") {
          if (!textCmp(c.comparer, this.val(c.parameterA), this.val(c.parameterB))) return false;
        } else if (c._c === "CompareBool") {
          let v = this.val(c.parameter);
          const of = outfitFlag(this.refParamName(c.parameter));
          if (of !== null) v = of;
          if (!!v !== !!this.val(c.equals)) return false;
        } else if (c._c === "CompareInt") {
          const a = Number(this.val(c.parameterA ?? c.parameter)) || 0, b = Number(this.val(c.parameterB ?? c.value ?? c.equals)) || 0;
          if (!(CMP[c.comparer ?? c.comparison ?? 0] || CMP[0])(a, b)) return false;
        } else if (c._c === "ExitTime") {
          continue;
        } else if (/LogicalCase$/.test(c._c)) {
          if (!this.storyCase(c)) return false;
        } else this.S.warn("condition " + c._c);
      }
      return true;
    }

    openWorld(n) {
      const seen = this.visited[n._k] || (this.visited[n._k] = []);
      if (n.overrideBackground) { const f = bgFile(this.S, n.overrideBackground); if (f) this.view.bg = f; }
      const locs = [];
      let requiredLeft = 0;
      for (const lk of n.locationConfigurationsImpl || []) {
        const l = this.S.get(lk);
        if (!l || seen.includes(l.locationName)) continue;
        if (!this.conditionsPass(l.conditions)) continue;
        if (l.isRequired) requiredLeft++;
        // who's waiting there (their faces go on the map)
        const chars = [];
        for (const k0 of l.presentCharacters || []) { const k = this.ck(k0); if (k && !chars.includes(k)) chars.push(k); }
        for (const r of l.presentReferenceCharacters || []) { const k = this.resolveRef(r); if (k && !chars.includes(k)) chars.push(k); }
        locs.push({ slot: l.locationName, text: l.locationName, required: !!l.isRequired, chars });
      }
      const hasExit = (n.transitions || []).some((t) => { const o = this.S.get(t); return o && o.fromSlot === "Exit"; });
      if (!locs.length) return this.follow(n._k, "Exit");
      this.pending = { type: "openworld", options: locs, canExit: hasExit && requiredLeft === 0,
        map: this.view.bg, view: this.viewSnap(null) };
    }

    /* ---------- outfits ---------- */
    /** You're wearing something you "bought" (premium outfits are free here): set the story's outfit flags to match. */
    setOutfitFlags() {
      for (const k of Object.keys(this.raw)) {
        const of = outfitFlag(k);
        if (of !== null && typeof this.raw[k] === "boolean" && this.raw[k] !== of) { this.params[k] = of; this.S.note("outfit-flag", { name: k, as: of }); }
      }
    }
    /**
     * The app sets your character's "outfit_premium" trait after the outfit picker: "premium" for an outfit bought with
     * gems, "old" for one you've worn before, "free" otherwise - and the Islanders react to it. Every outfit is free
     * here, so you're always wearing something "premium".
     */
    markPremiumOutfit() {
      for (const k of Object.keys(this.S.characters)) {
        if (this.S.canon(k) !== k || !("outfit_premium" in this.S.traitTypes(k))) continue;
        const t = this.traitsFor(k);
        if (t.outfit_premium !== "premium") { t.outfit_premium = "premium"; this.S.note("outfit-premium", { who: this.charName(k) }); }
      }
    }
    /** After the outfit picker: if the story has a separate path for a bought outfit, take it. */
    afterWardrobe(n) {
      let best = null;
      for (const tk of n.transitions || []) {
        const t = this.S.get(tk);
        if (t && !t.mute && t.fromSlot && t.fromSlot !== "Out" && boughtScore(t.fromSlot) > 0) { best = t.fromSlot; break; }
      }
      if (best) this.S.note("outfit-path", { slot: best });
      return this.follow(n._k, best || "Out");
    }
    /** The variable object a field points at (or null for a constant). */
    refParam(f) {
      const k = typeof f === "string" ? f : f && typeof f === "object" && !f.constant ? f.parameter : null;
      const p = k && this.S.get(k);
      return isParamObj(p) ? p : null;
    }
    /** Flags an action (purchase, rewarded ad) would set on success. */
    markBought(a) {
      for (const [f, v] of Object.entries(a)) {
        if (f === "_k" || f === "_c" || f === "enabled") continue;
        const p = this.refParam(v);
        if (p && (p.type === 2 || p.type === 3)) this.params[p.m_Name] = boughtScore(f) >= 0 && boughtScore(p.m_Name) >= 0;
      }
      this.S.note("purchase", { action: a._c });
    }

    /* ---------- actions ---------- */
    action(a) {
      if (!a || a.enabled === 0) return;
      const v = this.view;
      switch (a._c) {
        case "SetExpression": { const k = this.charOf(a); if (k) v.expr[k] = a.expressionName; return; }
        case "MassSetExpression":
          for (const k of a.characterList || []) v.expr[this.ck(k)] = a.expressionName;
          for (const r of a.refCharacterList || []) { const k = this.resolveRef(r); if (k) v.expr[k] = a.expressionName; }
          return;
        case "EnterView": {
          const k = this.charOf(a);
          if (!k) return;
          // "overflow" entries arrive in the bar of little heads (present, but not on the main stage yet)
          if (a.overflow) { if (!v.stage.includes(k)) this.toOverflow(k); }
          else this.enterView(k);
          return;
        }
        case "LeaveView": { const k = this.charOf(a); if (k) { v.stage = v.stage.filter((x) => x !== k); v.overflow = v.overflow.filter((x) => x !== k); } return; }
        case "Overflow": { const k = this.charOf(a); if (k) this.toOverflow(k); return; }
        case "MassOverflow":
          for (const k of a.characterList || []) this.toOverflow(this.ck(k));
          for (const r of a.refCharacterList || []) { const k = this.resolveRef(r); if (k) this.toOverflow(k); }
          return;
        case "ClearView": {
          const keep = new Set((a.charactersToIgnore || []).map((k) => this.ck(k)).concat((a.referenceCharactersToIgnore || []).map((r) => this.resolveRef(r))));
          if (a.ignorePlayer) keep.add(this.S.playerKey);
          const f = (k) => keep.has(k) || (a.ignoreOtherCharacters && k !== this.S.playerKey);
          v.stage = v.stage.filter(f); v.overflow = v.overflow.filter(f);
          return;
        }
        case "SetSkin": {
          const k = this.charOf(a);
          const name = a.IsSkinNameSelected === 0 ? this.val(a.skinNameParameter) : a.skinName;
          if (k && name) this.save.skins[k] = name;
          return;
        }
        case "MassSetSkin":
          for (const k of a.characterList || []) if (a.skinName) this.save.skins[this.ck(k)] = a.skinName;
          return;
        case "SetCustomization": {
          const k = this.charOf(a);
          if (k && a.customization && a.slotName) {
            // Season 1 sets the face once per expression (Happy, Sad...), so keep those apart.
            const c = this.save.custom[k] || (this.save.custom[k] = {});
            c[a.expressionName ? "@" + a.expressionName + "|" + a.slotName : (a.skinName || "*") + "|" + a.slotName] = a.customization;
          }
          return;
        }
        case "StageDirector": {
          const f = bgFile(this.S, a.Background) || bgFile(this.S, (a.backgroundPath || "").toLowerCase());
          if (f) v.bg = f;
          return;
        }
        case "PlayBackgroundMusic": case "CrossFadeMusic": {
          const m = this.S.audio[a.music || a.audio];
          if (m && m.files.length) v.music = m.files[0];
          return;
        }
        case "PlayAudio": { const m = this.S.audio[a.audio]; if (m && m.files.length) v.sfx = { file: m.files[0], n: Math.random() }; return; }
        case "StopAudio": { const m = this.S.audio[a.audio]; if (m && m.files.includes(v.music)) v.music = null; return; }
        case "SetBool": this.setParamRef(a.parameter, !!this.val(a.value)); return;
        case "SetString": this.setParamRef(a.parameter, this.textValue(a.value)); return;
        case "SetInt": this.setParamRef(a.parameter, Number(this.val(a.value)) || 0); return;
        case "SetFloat": this.setParamRef(a.parameter, Number(this.val(a.value)) || 0); return;
        case "ModifyInt": {
          const f = a.parameterToModify;
          const n = this.paramName(typeof f === "string" ? f : f && f.parameter);
          if (n) this.params[n] = (Number(this.raw[n]) || 0) + (Number(this.val(a.value)) || 0);
          return;
        }
        case "ImportParametersFromStory": {
          // Seasons 2 and 3 point at the episode's info entry (whose story id is "storyControllerId").
          const t = this.S.get(a.referenceStory);
          const id = t ? (t._c === "EpisodeInformation" ? t.storyControllerId : t.id) : null;
          if (!id) { this.S.warn("import from unknown story"); return; }
          if (!this.S.episodes.some((ep) => ep.controllerId === id)) {
            // An episode from an earlier season (e.g. Season 3 checking what you did in Season 2). Only add what this
            // season doesn't track itself, so names both seasons use (like "D01E01_partner") aren't overwritten.
            const snap = crossState(this.S, id);
            if (snap) { for (const [k, x] of Object.entries(snap)) if (!(k in this.raw)) { this.raw[k] = x; this.remembered.add(k); } }
            else this.S.warn("import: other season not played here");
            return;
          }
          // Everything you've done this season so far comes back (most recent choice wins), whichever earlier
          // episode the file names, so a choice from days ago is never forgotten.
          this.recall(true);
          if (id !== this.ep.controllerId && !stateAt(this.S, this.save, id)) this.S.warn("import: earlier episode not played yet");
          return;
        }
        case "SetAffinity": {
          // Season 1 affinity: 0 dislike, 1 neutral, 2 like, 3 love
          const n = this.paramName(a.affinityParameter && a.affinityParameter.parameter);
          if (!n) return;
          const cur = Number(this.getParamByRef(a.affinityParameter.parameter)) || 0;
          const t = a.setTo;
          this.params[n] = t <= 3 ? t : Math.max(0, Math.min(3, cur + (t === 4 ? 1 : -1)));
          return;
        }
        case "SetObject": this.setParamRef(a.parameter, this.val(a.value)); return;
        case "HasUnfinishedStories": this.setParamRef(a.result || a.hasUnfinishedStories, false); return;
        case "ClearOverflow": v.overflow = []; return;
        case "PlayEffectInStoryView": case "ContinueAudio": return;
        case "GetString": case "GetBool": case "GetInt": {
          const info = this.S.get(a.story);
          const id = info && (info.storyControllerId || info.id);
          if (!id) return;
          const st = id === this.ep.controllerId ? this.raw
            : (this.S.episodes.some((ep) => ep.controllerId === id) ? stateAt(this.S, this.save, id) : crossState(this.S, id));
          if (st && a.parameterName in st) this.setParamRef(a.result, st[a.parameterName]);
          return;
        }
        case "SetReferenceCharacter": if (a.referenceCharacter && a.newCharacter) this.setRef(a.referenceCharacter, a.newCharacter, "story"); return;
        case "ModifyReferenceCharacter": {
          const pn = this.refParamName(a.Parameter);
          const pv = norm(this.textValue(a.Parameter));
          // A variable that was never set only holds the file's default (often the first Islander, e.g. Bill):
          // it must not undo a role you already filled with your own choice.
          if (pn && !this.known(pn) && this.hasRef(a.referenceCharacter)) {
            this.S.note("role-kept", { role: (this.S.get(a.referenceCharacter) || {}).m_Name, variable: pn, value: pv });
            return;
          }
          for (const x of a.CharacterAssignments || [])
            if (norm(x.ParameterValue) === pv && x.NewCharacterSettings) { this.setRef(a.referenceCharacter, x.NewCharacterSettings, (pn || "value") + " = " + pv); return; }
          // Some lists (Season 2's murder mystery) leave the value blank: the value is the Islander's own name.
          for (const x of a.CharacterAssignments || [])
            if (!x.ParameterValue && x.NewCharacterSettings && pv && norm(this.charName(x.NewCharacterSettings)) === pv) { this.setRef(a.referenceCharacter, x.NewCharacterSettings, (pn || "value") + " = " + pv); return; }
          for (const x of a.ReferenceCharacterAssignments || [])
            if (norm(x.ParameterValue) === pv) {
              const k = this.resolveRef(x.NewReferenceCharacter || x.ReferenceCharacter);
              if (k) this.setRef(a.referenceCharacter, k, (pn || "value") + " = " + pv);
              return;
            }
          return;
        }
        case "GetReferenceCharacterName": this.setParamRef(a.outputName, this.charName(this.resolveRef(a.referenceCharacter))); return;
        case "ReferenceCharacterTraitCalculation": {
          const tn = this.isParamRef(a.traitName) ? this.paramName(a.traitName) : a.traitName;
          const score = (k) => { const t = this.traitsFor(k); return this.S.isStat(tn) || !(tn in t) ? this.statOf(t, tn) : Number(t[tn]) || 0; };
          // Leave out the ignored Islanders and, if asked, anyone no longer in the villa.
          const toChar = (r) => { const o = this.S.get(r); return o && o._c === "ReferenceCharacterSettings" ? this.resolveRef(r) : this.ck(r); };
          const ignored = new Set((a.ignoredCharacters || []).map(toChar).concat((a.ignoredReferenceCharacters || []).map((r) => this.resolveRef(r))));
          // "Who else you fancy" (Season 2's Current_Beau) is never your own partner: two Day 3 picks in Season 2's files
          // forgot to exclude them, so your partner came up as your second love interest too.
          const roleName = (this.S.get(a.referenceCharacter) || {}).m_Name || "";
          if (/beau|crush|second|fancy/i.test(roleName)) {
            const pp = this.save.refs["R:player_partner"] || this.save.refs["R:li3_player_partner"];
            if (pp) ignored.add(this.ck(pp));
          }
          const cands = (a.candidateCharacters || []).map(toChar).filter((k) => k && !ignored.has(k)
            && !(a.onlyIncludeInTheVillaCharacters && this.traitsFor(k).in_the_villa === false));
          let best = null, bestV = null;
          for (const k of cands) {
            const t = score(k);
            if (best === null || (a.desiredResult ? t < bestV : t > bestV)) { best = k; bestV = t; }
          }
          // On a tie, whoever already has the role keeps it (no switching to whoever is listed first).
          const cur = this.hasRef(a.referenceCharacter) ? this.resolveRef(a.referenceCharacter) : null;
          if (cur && cur !== best && cands.includes(cur) && score(cur) === bestV) best = cur;
          if (best) this.setRef(a.referenceCharacter, best, "highest " + tn);
          return;
        }
        case "ShowPlayerNameInput":
          this.setParamRef(a.nameIsAllowed, true);
          if (!this.save.playerName) this.pending = { type: "name", title: "What's your name?", def: "", view: this.viewSnap(null) };
          return;
        case "ShowStringParameterInput": {
          const out = a.outputText || a.parameter || a.stringParameter;
          this.setParamRef(a.nameIsAllowed, true);
          this.pending = { type: "text", title: a.messageBoxTitle || "Enter a name:", def: a.defaultValue || "",
            max: a.characterLimit || 64, param: out && out.parameter ? this.paramName(out.parameter) : null, view: this.viewSnap(null) };
          return;
        }
        case "SetPlayerName":
          // Copies the player's chosen name into a story variable.
          if (this.save.playerName) this.setParamRef(a.playerNameParameter, this.save.playerName);
          return;
        case "ShowIntroduction": {
          // The app's introduction card shows the character. Season 1's paintings are "introduced" this way too.
          const k = this.charOf(a);
          v.toast = { headline: a.headline || "", name: this.charName(k), n: Math.random() };
          if (k && k !== this.S.playerKey) v.intro = k;
          return;
        }
        case "ShowGenericImageIntroduction": v.toast = { headline: a.headline || "", name: a.subheading || "", n: Math.random() }; return;
        case "AddItemToStoryInventory": {
          const kk = a.storyInventoryMetadataKey; if (kk) this.save.inventory[kk] = (this.save.inventory[kk] || 0) + (a.quantityToAdd || 1); return;
        }
        case "GetIsSignedInToAccount": this.setParamRef(a.signedInResult, false); return;
        case "FinishStory": this.done = true; return;
        case "LaunchCustomization": {
          const k = a.Player ? this.S.playerKey : (this.ck(a.Character) || this.S.playerKey);
          if (a.CustomizationTree) this.pending = { type: "customize", tree: a.CustomizationTree, char: k, fromAction: true, view: this.viewSnap(null) };
          return;
        }
        case "ModifyCharacter": {
          // Season 1 "shared roles" (Player_Partner, Jasper_Miles...): one role, played by whichever Islander
          // the story variable says - their name and face change, the lines stay the same.
          const role = this.ck(a.character);
          if (!role) return;
          const roles = (this.save.roles = this.save.roles || {});
          if (!this.known(a.parameterName) && roles[role]) return;   // unset variable: keep who already plays it
          const pv = norm(this.paramValue(a.parameterName));
          for (const m of a.characterModifications || []) {
            if (norm(m.parameterValue) === pv) {
              roles[role] = { name: m.newName || "", avatar: m.newAvatar || null };
              return;
            }
          }
          return;
        }
        case "PurchaseOutfit": case "ShowUnityAd": this.markBought(a); return;
        case "GetSkin": {
          const k = this.charOf(a) || this.S.playerKey;
          let skin = this.save.skins[k];
          if (!skin) { const c = this.S.characters[k], av = c && this.S.get(c.avatar), sk = av && this.S.get(av.initialSkin); skin = sk ? sk.m_Name : "Default"; }
          for (const x of Object.values(a)) {
            const p = this.refParam(x);
            if (p && p.type === 4) { this.params[p.m_Name] = skin; break; }
          }
          return;
        }
        case "SwitchView": case "Save": case "TrackAchievement": case "ShowSignUpDialog":
        case "QueueDicoveredEndingsMessageBox":
          return;
        default: this.S.warn("action " + a._c);
      }
    }

    enterView(k) {
      const v = this.view;
      v.overflow = v.overflow.filter((x) => x !== k);
      if (!v.stage.includes(k)) v.stage.push(k);
      this.met(k);
      while (v.stage.length > 3) {
        const i = v.stage.findIndex((x) => x !== k && x !== this.S.playerKey);
        const out = v.stage.splice(i < 0 ? 0 : i, 1)[0];
        if (!v.overflow.includes(out)) v.overflow.push(out);
      }
    }
    toOverflow(k) {
      const v = this.view;
      v.stage = v.stage.filter((x) => x !== k);
      if (!v.overflow.includes(k)) v.overflow.push(k);
      this.met(k);
    }
    /** Remember who has been part of this episode's scenes. */
    met(k) { const m = (this.view.met = this.view.met || []); if (k && !m.includes(k)) m.push(k); }

    /* ---------- text ---------- */
    /** A node's line. Some lines are stored as an internal key ("AJ.2.I.was.wondering.li"): show the real words. */
    pickText(o) {
      const t = o.text || o.femaleText || "";
      if (!t || !isKeyLike(t)) return t;
      for (const x of [o.femaleText, o.maleText]) if (isRealText(x)) return x;
      for (const [f, x] of Object.entries(o)) if (/text/i.test(f) && f !== "text" && isRealText(x)) return x;
      return this.keyText(t);
    }
    choiceText(ch) {
      const t = ch.text || ch.femaleText || "";
      if (t) return this.pickText(ch);
      return isKeyLike(ch.m_Name) ? this.keyText(ch.m_Name) : (ch.m_Name || "");
    }
    keyText(key) {
      const hit = this.S.textForKey(key);
      if (hit) return hit;
      this.S.warn("text key not found");
      this.S.keyMisses.add(key);
      return humanizeKey(key);
    }
    text(n) {
      const t = this.pickText(n);
      return t ? this.fmt(t, n.tokens) : "";
    }
    fmt(t, tokens) {
      const map = { "{PLAYERNAME}": this.save.playerName || "You", "{playername}": this.save.playerName || "You" };
      const addTok = (tk) => {
        const o = this.S.get(tk);
        if (o && o._c === "StringToken" && o.token) map[o.token] = String(this.val(o.parameter) ?? "");
      };
      for (const f of this.frames) { const c = this.S.get(f.ctrl); for (const tk of (c && c.locaTokens) || []) addTok(tk); }
      for (const tk of tokens || []) addTok(tk);
      const lookup = (m) => {
        if (m in map) return map[m];
        // Token defined elsewhere in the season (e.g. in a shared module): use its parameter's current value.
        for (const o of this.S.tokensNamed(m)) {
          const v = this.val(o.parameter);
          if (v !== undefined && v !== null && v !== "") return (map[m] = String(v));
        }
        return m;
      };
      for (let pass = 0; pass < 3 && /\{[A-Za-z0-9_]+\}/.test(t); pass++)
        t = t.replace(/\{[A-Za-z0-9_]+\}/g, lookup);
      return t;
    }
    speakerOf(n) {
      switch (n._c) {
        case "PlayerNode": return this.S.playerKey;
        case "ReferenceCharacterNode": return this.resolveRef(n.referenceCharacter);
        // A character line can also be set to "use reference character" (e.g. your partner): the plain character
        // field then only holds a placeholder Islander and must not be shown.
        case "CharacterNode": case "ChoiceNode": case "TimedChoiceNode": return this.charOf(n);
        default: return null;
      }
    }
    /** Everyone named in a line, earliest first (role names count, e.g. whoever plays "Miles" right now). */
    namedIn(text) {
      const out = [];
      this._nameRe = this._nameRe || new Map();
      for (const k of this.S.islanders || []) {
        const name = this.charName(k);
        if (!name || name.length < 2) continue;
        let re = this._nameRe.get(name);
        if (!re) { re = new RegExp("\\b(" + escRe(name) + "|" + escRe(name.toUpperCase()) + ")\\b"); this._nameRe.set(name, re); }
        const m = re.exec(text);
        if (m) out.push({ k, at: m.index });
      }
      return out.sort((a, b) => a.at - b.at);
    }
    /** Present Islander named first in the text (kept for older callers). */
    mentioned(text) {
      const v = this.view, here = new Set(v.stage.concat(v.overflow));
      const hit = this.namedIn(text).find((x) => here.has(x.k));
      return hit ? hit.k : null;
    }
    /**
     * Narration: bring forward the Islander it talks about. If it names someone, the last speaker no longer stays
     * forward (narration about Miles must not show Mason). Someone named who was in this scene earlier comes back up.
     */
    narrationFocus(text) {
      const named = this.namedIn(text);
      if (!named.length) return null;
      this.noCarry = true;
      const v = this.view, here = new Set(v.stage.concat(v.overflow)), met = new Set(v.met || []);
      const hit = named.find((x) => here.has(x.k)) || named.find((x) => met.has(x.k));
      return hit ? hit.k : null;
    }
    lineStep(n, text) {
      const sk = this.speakerOf(n);
      if (sk && sk !== this.S.playerKey) { this.lastSpeaker = sk; this.met(sk); }   // whoever talks is part of the scene
      this.narrFocus = sk ? null : this.narrationFocus(text);
      if (sk && n.expressionName) this.view.expr[sk] = n.expressionName;
      if (sk && n.skinName) this.save.skins[sk] = n.skinName;
      return {
        type: "line", text, speaker: sk, name: this.charName(sk),
        narrator: !sk, thinking: !!n.isThinking, textMessage: !!n.isTextMessage,
        view: this.viewSnap(sk),
      };
    }
    viewSnap(speaker) {
      const v = this.view;
      // Who to bring forward: the speaker, or (during narration) the Islander the narration talks about.
      let focus = speaker || null, named = false;
      if (!focus && this.narrFocus) { focus = this.narrFocus; named = true; }
      // Otherwise whoever just spoke stays in view for the narration right after their line.
      const ls = this.lastSpeaker;
      if (!focus && !this.noCarry && ls && this.prevSpeaker === ls && (v.stage.includes(ls) || v.overflow.includes(ls))) focus = ls;
      // Someone only heard - the story hasn't put them on screen - while in their bare outfit (Tim singing behind the
      // shower door in Season 1) stays off screen: you see their name, not them.
      if (focus && focus !== this.S.playerKey && !v.stage.includes(focus) && !v.overflow.includes(focus) && undressed(this.S, this.save, focus, v.expr[focus])) { focus = null; named = false; }
      const s = { bg: v.bg, stage: v.stage.slice(), overflow: v.overflow.slice(), speaker, focus, named, music: v.music, sfx: v.sfx,
        toast: v.toast, effect: v.effect || null, intro: v.intro || null };
      v.sfx = null; v.toast = null; v.effect = null; v.intro = null; this.lastTraitChar = null; this.narrFocus = null;
      this.prevSpeaker = speaker || (named || this.noCarry ? null : this.prevSpeaker);
      this.noCarry = false;
      return s;
    }

    /* ---------- player input ---------- */
    advance() { if (!this.pending || this.pending.type !== "line") return; const nk = this.node; this.pending = null; this.follow(nk, "Out"); }
    choose(opt) {
      if (!this.pending) return;
      const p = this.pending, nk = this.node;
      this.pending = null;
      if (p.type === "choice") {
        const ch = this.S.get(opt.key);
        if (ch && ch._c === "ReferenceCharacterChoice" && ch.referenceCharacter && ch.newCharacter) this.setRef(ch.referenceCharacter, ch.newCharacter, "your choice");
        if (ch && ch._c === "CustomizationChoice" && ch.customization) {
          // Season 1 look choices: a picture option that sets one layer of your look
          const cs = this.S.get(ch.customization);
          if (cs && cs.slot) {
            const m = (this.save.custom[this.S.playerKey] = this.save.custom[this.S.playerKey] || {});
            m[(ch.skin || "Default") + "|" + cs.slot] = ch.customization;
          }
        }
        if (ch && ch._c === "AvatarChoice" && ch.avatar) (this.save.avatars = this.save.avatars || {})[this.S.playerKey] = ch.avatar;
        if (ch) this.choiceEffects(ch, this.S.get(nk));
        this.log.push(opt.text);
        const t = this.choiceLink(nk, opt);
        if (t) return this.take(t, this.S.get(nk));
        return this.follow(nk, opt.slot);
      }
      if (p.type === "openworld") {
        if (opt === "Exit") return this.follow(nk, "Exit");
        (this.visited[nk] || (this.visited[nk] = [])).push(opt.slot);
        return this.follow(nk, opt.slot);
      }
    }
    /**
     * Which link a picked option follows, when the plain name match can't be trusted: several options sharing one
     * name (the k-th option takes the k-th link), or links named a little differently from their options.
     * Returns null to use the normal name match.
     */
    choiceLink(nk, opt) {
      const n = this.S.get(nk);
      if (!n) return null;
      const all = (n.transitions || []).map((t) => this.S.get(t)).filter((t) => t && !t.mute);
      const names = (n.choices || []).map((c) => (this.S.get(c) || {}).m_Name);
      const exact = all.filter((t) => t.fromSlot === opt.slot);
      const same = names.filter((x) => x === opt.slot).length;
      if (same > 1 && exact.length === same) {
        const t = exact[opt.occ || 0];
        if (t && this.conditionsPass(t.conditions)) { this.S.note("choice-link", { option: opt.text, by: "position among same-named options" }); return t; }
      }
      if (exact.some((t) => this.conditionsPass(t.conditions))) return null;
      const pass = all.filter((t) => this.conditionsPass(t.conditions));
      let t = pass.find((x) => norm(x.fromSlot) === norm(opt.slot)) || (opt.raw && pass.find((x) => norm(x.fromSlot) === norm(opt.raw)));
      if (!t) {
        const named = all.filter((x) => x.fromSlot !== "Out");
        if (named.length > 1 && named.length === names.length && !named.some((x) => names.includes(x.fromSlot))) {
          const c = named[opt.i];
          if (c && this.conditionsPass(c.conditions)) t = c;
        }
      }
      if (t) this.S.note("choice-link", { option: opt.text, by: "link " + t.fromSlot });
      return t || null;
    }
    /** Effects stored on the option itself (stat changes or actions attached to a choice). */
    choiceEffects(ch, node) {
      for (const [f, v] of Object.entries(ch)) {
        if (f === "conditions" || f === "_k" || f === "_c" || f === "parent" || f === "image") continue;
        const refs = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
        for (const r of refs) {
          if (typeof r !== "string" || !r.startsWith("cab-")) continue;
          const o = this.S.get(r);
          if (!o || !o._c) continue;
          if (/Modification$/.test(o._c) && o.parameterName) {
            let who = ch.characterTraits ? this.charFromTraits(ch.characterTraits)
              : (ch.character || ch.referenceCharacter || ch.player) ? this.charOf(ch) : null;
            if (who === this.S.playerKey) who = null;
            const trait = this.S.isTraitName(o.parameterName) && !(o.parameterName in this.raw);
            if (trait && !who) who = this.speakerOf(node) || this.lastSpeaker || null;
            if (trait && !who) { this.S.warn("choice trait change without a character"); continue; }
            this.modify(o, who, trait);
            if (who) this.lastTraitChar = who;
            this.S.note("choice-effect", { option: ch.m_Name, change: o._c, name: o.parameterName, who: who ? this.charName(who) : "story" });
          } else if (CHOICE_ACTIONS.has(o._c)) {
            this.action(o);
            this.S.note("choice-effect", { option: ch.m_Name, action: o._c });
          }
        }
      }
    }
    submitText(value) {
      const p = this.pending; if (!p || (p.type !== "name" && p.type !== "text")) return;
      this.pending = null;
      value = String(value || "").trim() || p.def || (p.type === "name" ? "You" : "");
      if (p.type === "name") this.save.playerName = value;
      else if (p.param) this.params[p.param] = value;
      this.queue = null;
      this.process(this.node, this.resumeAt);   // finish the rest of that node
    }

    /** Called when the player closes the look / outfit picker. */
    finishCustomize() {
      const p = this.pending; if (!p || p.type !== "customize") return;
      this.pending = null;
      const tree = this.S.get(p.tree);
      const outfit = !!(tree && tree.SkinToModify && tree.SkinToModify !== "Default");
      if (outfit) applyPremiumEffects(this.S, this.save, p.tree);
      for (const [k, v] of Object.entries(this.save.custParams || {})) this.params[k] = v;
      if (outfit && !p.fromAction) this.save.skins[p.char] = tree.SkinToModify;
      if (outfit) { this.setOutfitFlags(); this.markPremiumOutfit(); }
      if (p.fromAction) this.process(this.node, this.resumeAt);
      else {
        const n = this.S.get(this.node);
        if (n && n._c === "WardrobeNode") this.afterWardrobe(n);
        else this.follow(this.node, "Out");
      }
    }

    /* ---------- end / save ---------- */
    finish() {
      if (this.finished) return;
      this.finished = true;
      const id = this.ep.controllerId, save = this.save;
      if (this.legacy) {
        (save.snapshots = save.snapshots || {})[id] = Object.assign({}, this.raw);
        if (save.deltas) delete save.deltas[id];
      } else {
        // The whole end state, like the app: the next episode starts from it, so values an episode only declared
        // (defaults that differ between episodes) carry on exactly as they did in the original.
        (save.states = save.states || {})[id] = Object.assign({}, this.raw);
        if (save.snapshots) delete save.snapshots[id];
        if (save.deltas) delete save.deltas[id];
      }
      save.order = (save.order || []).filter((x) => x !== id);
      save.order.push(id);
      for (const [k, x] of Object.entries(this.raw)) if (/^GLOBAL_/i.test(k)) save.globals[k] = x;
      if (!save.completed.includes(this.ep.key)) save.completed.push(this.ep.key);
      save.current = null;
    }
    /** Mid-episode state, taken while the player is looking at a step. */
    snapshot() {
      const p = this.pending;
      const input = p && (p.type === "name" || p.type === "text" || (p.type === "customize" && p.fromAction));
      return JSON.parse(JSON.stringify({
        ep: this.ep.key, node: this.node, resumeAt: input ? this.resumeAt - 1 : this.resumeAt,
        frames: this.frames, params: this.raw, touched: [...this.touched], legacy: !!this.legacy,
        view: this.view, visited: this.visited, log: this.log.slice(-200),
        lastSpeaker: this.lastSpeaker || null,
      }));
    }
    restore(s) {
      this.frames = s.frames;
      if (Array.isArray(s.touched)) {
        this._store(s.params || {}, s.touched, Object.keys(memoryBefore(this.S, this.save, this.ep)));
        this.legacy = !!s.legacy;
      } else {
        // Paused by a version before 1.1.4: every value it holds counts as real.
        this._store(s.params || {}, [], Object.keys(s.params || {}));
        this.legacy = true;
      }
      this.visited = s.visited || {};
      this.view = Object.assign({ stage: [], overflow: [], expr: {}, met: [] }, s.view);
      if (!this.view.met) this.view.met = this.view.stage.concat(this.view.overflow);
      this.log = s.log || [];
      this.lastSpeaker = s.lastSpeaker || null;
      this.node = s.node;
      // Rebuild the step we stopped on without re-running the node's earlier actions.
      this.process(s.node, s.resumeAt);
    }
  }

  /** What another season's save says at the end of one of its episodes. */
  function crossState(S, id) {
    if (S.crossSnaps && S.crossSnaps[id]) return S.crossSnaps[id];
    for (const sv of S.crossSaves || []) { const st = stateInSave(sv, id); if (st) return st; }
    return null;
  }

  /**
   * Outfit items can set story variables (e.g. whether the look was a paid one). Everything is free here, so a
   * variable whose values mean "bought" vs "default" gets the bought value.
   */
  function applyPremiumEffects(S, save, treeKey) {
    const tree = S.get(treeKey);
    if (!tree) return;
    const byKey = {};
    for (const ck of tree.categories || []) for (const ik of (S.get(ck) || {}).customisationItems || []) {
      const it = S.get(ik), pe = it && it.ParameterEffect;
      if (pe && pe.Key) (byKey[pe.Key] = byKey[pe.Key] || []).push({ v: pe.Value, prem: itemIsPremium(it) });
    }
    const cp = (save.custParams = save.custParams || {});
    for (const [k, list] of Object.entries(byKey)) {
      const vals = [...new Set(list.map((x) => x.v))];
      if (vals.length < 2) continue;
      let v = vals.find((x) => boughtScore(x) > 0);
      if (v === undefined && boughtScore(k) !== 0) v = (list.find((x) => x.prem) || {}).v;
      if (v === undefined || boughtScore(cp[k]) > 0) continue;
      if (cp[k] !== v) { cp[k] = v; S.note("outfit-value", { name: k, value: v }); }
    }
  }

  function bgFile(S, key) {
    if (!key) return null;
    const b = S.backgrounds[key];
    return b && b.files && b.files.length ? b.files[0] : null;
  }

  /* ------------------------------------------------------------------ avatar layers */
  const CLOTH_SLOT = /cloth|layer\d|^cover$|outfit|top$|bottom|swim|dress|shirt|short|trouser|towel/i;
  /** Would be drawn with no clothing at all, though they're a person who wears clothes (not an animal, baby or doll). */
  function undressed(S, save, k, expr) {
    const av = S.get(avatarKeyFor(S, save, k));
    if (!av || !(av.slots || []).some((sl) => CLOTH_SLOT.test((S.get(sl) || {}).m_Name || ""))) return false;
    const lay = avatarLayers(S, save, k, expr);
    return lay.length > 0 && !lay.some((l) => CLOTH_SLOT.test(l.slot));
  }
  /** Which art a character is drawn with right now (their own, or the Islander currently playing their role). */
  function avatarKeyFor(S, save, charKey) {
    charKey = S.canon(charKey);
    const c = S.characters[charKey];
    if (!c) return null;
    const role = (save.roles || {})[charKey];
    const own = (save.avatars || {})[charKey];
    let ak = own || (role && role.avatar) || c.avatar;
    // An Islander drawn with someone else's art in the files (Season 1 "Miles"): use their own art.
    if (!own && charKey !== S.playerKey && S.avatarForName) ak = S.avatarForName((role && role.name) || c.name, ak);
    return S.get(ak) ? ak : c.avatar;
  }
  function avatarLayers(S, save, charKey, expr, skinOverride) {
    charKey = S.canon(charKey);
    const c = S.characters[charKey];
    if (!c) return [];
    const av = S.get(avatarKeyFor(S, save, charKey));
    if (!av) return [];
    const skinName = skinOverride || save.skins[charKey];
    let skin = null;
    for (const sk of av.skins || []) { const o = S.get(sk); if (o && o.m_Name === skinName) { skin = o; break; } }
    if (!skin) skin = S.get(av.initialSkin);
    let ex = null;
    for (const e of av.expressions || []) { const o = S.get(e); if (o && o.m_Name === expr) { ex = o; break; } }
    if (!ex) ex = S.get(av.defaultExpression);
    const exName = ex ? ex.m_Name : expr;
    const bySlot = (o) => { const m = {}; for (const a of (o && o.attachments) || []) if (a.slot) m[a.slot] = a.attachment; return m; };
    const sm = bySlot(skin), em = bySlot(ex);
    const baseSkin = S.get(av.initialSkin), baseName = baseSkin ? baseSkin.m_Name : null;
    const dm = baseSkin && baseSkin !== skin ? bySlot(baseSkin) : sm;
    const custom = (save.custom || {})[charKey] || {};
    const slots = (av.slots || []).map((k) => S.get(k)).filter(Boolean).sort((a, b) => (a.drawOrder || 0) - (b.drawOrder || 0));
    const out = [];
    for (const sl of slots) {
      let att = sm[sl._k] || null;
      // Which skin "owns" this slot? Outfits point back to the base look for hair, face and body:
      // a "reference" slot simply means "same as the base look", whatever the link points at.
      let owner = skin ? skin.m_Name : "";
      const ao = S.get(att);
      if (ao && ao._c === "ReferenceAttachment" && baseName) {
        owner = baseName;
        if (dm[sl._k]) att = dm[sl._k];
      } else if (!ao && em[sl._k] && baseName) owner = baseName;   // face parts an outfit doesn't define come from the base look
      const slot = sl.m_Name;
      // Per-expression changes (Season 1 sets your face once per expression) apply in every outfit.
      const exOv = custom["@" + exName + "|" + slot] || custom["@Neutral|" + slot];
      const ov = custom[owner + "|" + slot] || custom["*|" + slot];
      if (ov === "-") continue;   // emptied by the wardrobe
      let sprite = null;
      if (exOv) sprite = overrideSprite(S, exOv, slot, exName);
      if (!sprite && ov) sprite = overrideSprite(S, ov, slot, exName);
      if (!sprite && em[sl._k]) sprite = attachmentSprite(S, em[sl._k], exName, 0);
      if (!sprite) sprite = attachmentSprite(S, att, exName, 0);
      if (sprite) out.push(Object.assign({ slot }, sprite));
    }
    // Season 3 draws eyebrows in white and the app tinted them to match your hair colour.
    const brows = out.filter((l) => /^brow/i.test(l.slot) && /white/i.test(l.file));
    if (brows.length) {
      const tint = hairTint(save, charKey, out);
      for (const l of brows) l.tint = tint;
    }
    return out;
  }
  const HAIR_TINTS = { blonde: "#9c7444", brunette: "#4a2e1c", brown: "#4a2e1c", red: "#7a3418", ginger: "#7a3418",
    dark: "#231815", black: "#231815" };
  function hairTint(save, charKey, layers) {
    const hair = layers.find((l) => /^hair/i.test(l.slot) && !/empty/i.test(l.file));
    const m = hair && /(blonde|brunette|brown|red|ginger|dark|black)/i.exec(hair.file);
    const c = (m && m[1].toLowerCase()) || ((save.custParams || {}).hair_colour || "").toLowerCase();
    return HAIR_TINTS[c] || HAIR_TINTS.brunette;
  }
  function spriteInfo(S, linked, ref) {
    if (linked && linked.path) { const s = S.sprites[linked.path.toLowerCase()]; if (s) return s; }
    if (ref) return S.sprites[ref] || null;
    return null;
  }
  /** Sprite for a chosen customization item (or a single setting) on one slot, matching the expression. */
  function overrideSprite(S, key, slotName, exName) {
    const o = S.get(key);
    if (!o) return null;
    if (o._c === "CustomizationSettings") return customizationSprite(S, key, exName);
    if (o._c !== "CustomizationItem") return null;
    let best = null, neutral = null, any = null;
    for (const ck of o.customizations || []) {
      const cs = S.get(ck);
      if (!cs || cs.slot !== slotName) continue;
      for (const b of cs.behaviours || []) {
        const ic = S.get(b);
        if (!ic || ic._c !== "ImageCustomization") continue;
        const sp = spriteInfo(S, ic.linkedSprite, ic.sprite);
        if (!sp) continue;
        if (ic.expression && ic.expression === exName) best = best || sp;
        else if (!ic.expression || ic.expression === "Neutral") neutral = neutral || sp;
        any = any || sp;
      }
    }
    return best || neutral || any;
  }
  function customizationSprite(S, ck, exName) {
    const cs = S.get(ck);
    if (!cs) return null;
    let fallback = null;
    for (const b of cs.behaviours || []) {
      const ic = S.get(b);
      if (!ic || ic._c !== "ImageCustomization") continue;
      const sp = spriteInfo(S, ic.linkedSprite, ic.sprite);
      if (!sp) continue;
      if (ic.expression && exName && ic.expression === exName) return sp;
      if (!fallback) fallback = sp;
    }
    return fallback;
  }
  function attachmentSprite(S, ak, exName, depth) {
    if (!ak || depth > 5) return null;
    const a = S.get(ak);
    if (!a) return null;
    if (a._c === "ImageAttachment") return spriteInfo(S, a.linkedSprite, a.sprite);
    if (a._c === "ReferenceAttachment") return attachmentSprite(S, a.reference, exName, depth + 1);
    if (a._c === "CustomizationAttachment") return customizationSprite(S, a.customization, exName);
    return null;
  }

  /* ------------------------------------------------------------------ customization (look & outfits) */
  /** Groups of choices for a customization tree, e.g. Skin, Eyes (with colour variants), Hair... */
  function customizationModel(S, save, treeKey) {
    const tree = S.get(treeKey);
    if (!tree) return null;
    const params = save.custParams || {};
    const cats = (tree.categories || []).map((k) => S.get(k)).filter(Boolean);
    // parameters that items set themselves (e.g. player_skin) choose categories automatically
    const setByItems = new Set();
    for (const c of cats) for (const it of c.customisationItems || []) { const o = S.get(it); if (o && o.ParameterEffect && o.ParameterEffect.Key) setByItems.add(o.ParameterEffect.Key); }
    const groups = [];
    const byName = new Map();
    for (const c of cats) {
      const label = (c.EditorName || c.m_Name || "").replace(/_category$/i, "");
      const req = c.ActivationParameterRequirementKey || "";
      const val = c.ActivationParameterRequirementValue || "";
      let gname = label;
      if (req && val) gname = label.replace(new RegExp("\\s*-?\\s*" + val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i"), "").trim() || label;
      const key = gname + "|" + req;
      let g = byName.get(key);
      if (!g) { g = { name: gname, req, auto: !req || setByItems.has(req), variants: [] }; byName.set(key, g); groups.push(g); }
      g.variants.push({ value: val, label: val ? val[0].toUpperCase() + val.slice(1) : label, icon: c.UIImage ? S.sprites[c.UIImage] || null : null,
        items: (c.customisationItems || []).map((k) => S.get(k)).filter(Boolean).map((it) => ({ key: it._k, name: (it.m_Name || "").replace(/_item$/i, ""), icon: itemIcon(S, it) })) });
    }
    for (const g of groups) {
      if (!g.req) { g.active = 0; continue; }
      const cur = params[g.req];
      let i = g.variants.findIndex((v) => v.value === cur);
      if (i < 0) i = 0;
      g.active = i;
    }
    return { skin: tree.SkinToModify || "Default", title: tree.displayName || tree.m_Name, groups };
  }
  function itemIcon(S, it) {
    const pref = ["Hair-front", "Eyes", "Mouth", "Nose", "Layer1", "Layer2", "Head", "Body", "Shoes", "Accessory"];
    for (const slot of pref) { const sp = overrideSprite(S, it._k, slot, "Neutral"); if (sp) return sp; }
    return null;
  }
  function applyCustomization(S, save, charKey, treeKey, itemKey) {
    const tree = S.get(treeKey), it = S.get(itemKey);
    if (!tree || !it) return;
    const skin = tree.SkinToModify || "Default";
    const c = (save.custom = save.custom || {});
    const m = c[charKey] || (c[charKey] = {});
    for (const ck of it.customizations || []) { const cs = S.get(ck); if (cs && cs.slot) m[skin + "|" + cs.slot] = itemKey; }
    if (it.ParameterEffect && it.ParameterEffect.Key) (save.custParams = save.custParams || {})[it.ParameterEffect.Key] = it.ParameterEffect.Value;
    (save.custSel = save.custSel || {})[treeKey + "|" + (it.ParentCategory || "")] = itemKey;
  }
  function selectedItem(save, charKey, skin, item, S) {
    const m = ((save.custom || {})[charKey]) || {};
    const it = S.get(item); if (!it) return false;
    for (const ck of it.customizations || []) { const cs = S.get(ck); if (cs && m[skin + "|" + cs.slot] === item) return true; }
    return false;
  }

  /* ------------------------------------------------------------------ wardrobe (any time) */
  const CLOTHES_SLOT = /^(Layer\d*|Cover)$/i, SHOES_SLOT = /^Shoes$/i, JEWEL_SLOT = /^(Accessory.*|Misc\d*)$/i;
  const BODY_SLOT = /^(Body|Head|Face|Hair.*|Eye.*|Nose|Mouth|Chin|Brow|Cheek.*|Lip.*|Paint|Sash|Baby.*|Microphone)$/i;
  const isEmpty = (sp) => !sp || /^empty/i.test(sp.file);

  function occasionLabel(skin) {
    const n = String(skin).replace(/^outfit_/i, "").replace(/[-_]+/g, " ").trim().toLowerCase();
    if (/swim|bikini/.test(n)) return "Swimwear";
    if (/evening|party/.test(n)) return "Evening";
    if (/sleep|pyjama/.test(n)) return "Sleepwear";
    if (/casual/.test(n)) return "Casual";
    return n.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Everything the player can change: look, hair, and an outfit per occasion. */
  function wardrobeModel(S) {
    const c = S.characters[S.playerKey];
    const av = c && S.get(c.avatar);
    if (!av) return [];
    const skins = new Set((av.skins || []).map((k) => (S.get(k) || {}).m_Name).filter(Boolean));
    const trees = [...S.objects.values()].filter((o) => o._c === "CustomizationTree");
    const occ = [];
    const looks = trees.filter((t) => (t.SkinToModify || "Default") === "Default")
      .sort((a, b) => (b.categories || []).length - (a.categories || []).length);
    // Your face and skin are set once, at the start of the season. Any time, you can restyle your hair:
    const hair = looks.find((t) => t !== looks[0] && /hair/i.test(t.m_Name) && !/wedding/i.test(t.m_Name));
    if (hair) occ.push({ type: "look", label: "Hair", tree: hair._k, skin: "Default" });
    else if (looks[0] && (looks[0].categories || []).length > 2)
      occ.push({ type: "look", label: "Hair", tree: looks[0]._k, skin: "Default", only: "^hair" });
    else {
      const h1 = season1Hair(S);
      if (h1) occ.push(h1);
    }
    const bySkin = new Map();
    for (const t of trees) {
      const sk = t.SkinToModify;
      if (!sk || sk === "Default" || !skins.has(sk)) continue;
      if (!bySkin.has(sk)) bySkin.set(sk, []);
      bySkin.get(sk).push(t._k);
    }
    const order = ["Swimwear", "Evening", "Sleepwear", "Casual"];
    const outfits = [...bySkin.entries()].map(([skin, ts]) => ({ type: "outfit", label: occasionLabel(skin), skin, trees: ts }));
    const rank = (o) => { const i = order.indexOf(o.label); return i < 0 ? 99 : i; };
    outfits.sort((a, b) => rank(a) - rank(b) || b.trees.length - a.trees.length);
    const used = new Set();
    for (const o of outfits) { if (used.has(o.label)) o.label += " (" + o.skin + ")"; used.add(o.label); occ.push(o); }
    // Season 1 has no outfit trees: each outfit is a whole look that the story picks through a variable.
    if (!outfits.length) {
      for (const [label, param, re] of [["Swimwear", "current_swimwear", /bikini|swimsuit/i],
        ["Evening", "current_eveningwear", /evening/i], ["Sleepwear", "current_sleepwear", /sleepwear/i]]) {
        const list = [...skins].filter((n) => re.test(n));
        if (list.length > 1) occ.push({ type: "skins", label, param, re, skins: list });
      }
    }
    return occ;
  }

  /**
   * One-time repair for Season 3 saves from before version 1.1.2: affinity used to start at 0 instead of
   * neutral (50), so anyone whose score changed back then is about 50 too low. Scores still at exactly 50
   * were never touched by that bug and are left alone.
   */
  function migrateSave(S, save) {
    save.fixes = save.fixes || {};
    save.refs = save.refs || {};
    let changed = false;
    if (!save.fixes.aff50) {
      save.fixes.aff50 = 1;
      const boolAffinity = Object.values(S.characters).some((c) => c.traits && (c.traits.traitParameters || [])
        .some((r) => { const p = S.get(r); return p && p.m_Name === "affinity" && p.type !== 1; }));
      if (boolAffinity) for (const t of Object.values(save.traits || {})) {
        if (typeof t.affinity === "number" && t.affinity < 50) { t.affinity = Math.min(100, t.affinity + 50); changed = true; }
        else if ("affinity" in t && typeof t.affinity !== "number") { t.affinity = 50; changed = true; }
      }
    }
    if (!save.fixes.stat0) {
      // Before 1.1.4, a relationship score whose file default is 0 (or on/off) started at 0 - "hate" - instead of
      // neutral. Move those scores up by the neutral start so they sit where they should.
      save.fixes.stat0 = 1;
      const start = S.statStart();
      for (const [k, t] of Object.entries(save.traits || {})) {
        const c = S.characters[S.canon(k)];
        if (!c || !c.traits) continue;
        for (const r of c.traits.traitParameters || []) {
          const p = S.get(r);
          if (!p || !p.m_Name || !(p.m_Name in t) || !S.isStat(p.m_Name)) continue;
          const d = paramDefault(p), cur = t[p.m_Name];
          if (typeof d === "number" && d !== 0) continue;                      // it started where it should
          if (p.type !== 0 && p.type !== 1) continue;                         // on/off traits: handled below
          t[p.m_Name] = typeof cur === "number" ? Math.max(0, Math.min(100, cur + start)) : start;
          changed = true;
        }
      }
    }
    if (!save.fixes.onoff) {
      // 1.1.2 to 1.1.4 turned on/off traits (Season 3's own cast: a spark or not) into scores. Turn them back.
      save.fixes.onoff = 1;
      for (const [k, t] of Object.entries(save.traits || {})) {
        const types = S.traitTypes(S.canon(k));
        for (const [n, v] of Object.entries(t)) if ((types[n] === 2 || types[n] === 3) && typeof v === "number") { t[n] = v >= 60; changed = true; }
      }
    }
    // Before 1.1.4 Season 3 used a leftover Season 2-style player, not Rica (your character): move the look across.
    const pk = S.playerKey;
    for (const field of ["custom", "skins", "avatars", "traits"]) {
      const m = save[field];
      if (!m || !pk) continue;
      for (const k of Object.keys(m)) {
        if (k === pk) continue;
        const known = S.characters[k];
        const oldPlayer = known ? S.canon(k) === pk : /_stories/.test(S.bundleOfCab[k.split(":")[0]] || "");
        if (!oldPlayer) continue;
        if (!(pk in m)) m[pk] = m[k];
        delete m[k]; changed = true;
      }
    }
    if (save.skins && pk && save.skins[pk] && !(S.get((S.characters[pk] || {}).avatar) || { skins: [] }).skins
      .some((x) => (S.get(x) || {}).m_Name === save.skins[pk])) { delete save.skins[pk]; changed = true; }
    // Roles ("your partner"...) are now remembered by name rather than by the pack the story file was in.
    for (const k of Object.keys(save.refs)) {
      if (!k.startsWith("cab-")) continue;
      const id = S.refId(k);
      if (id === k) continue;
      if (!save.refs[id]) save.refs[id] = save.refs[k];
      delete save.refs[k];
      changed = true;
    }
    return changed;
  }

  const CLOTHING_SLOT = /cloth|layer\s*\d|cover|outfit|swim|top|bottom|dress|shirt|short|trouser|skirt|bikini/i;
  /** True if a character would be drawn with no clothing at all (e.g. Tim behind the shower door in his base body). */
  function isUnclothed(S, save, k, expr) {
    const c = S.characters[S.canon(k)];
    if (!c || c.prop) return false;
    const av = S.get(avatarKeyFor(S, save, S.canon(k)));
    if (!av || !(av.slots || []).some((sl) => CLOTHING_SLOT.test((S.get(sl) || {}).m_Name || ""))) return false;
    return !avatarLayers(S, save, k, expr).some((l) => CLOTHING_SLOT.test(l.slot || ""));
  }
  /** Story variables as they stand now: the episode being played, or everything finished so far. */
  function currentState(S, save, run) {
    if (run) return run.raw;
    const st = {}, defs = S.paramDefaults();
    for (const e of S.episodes) layerEpisode(st, save, e.controllerId, defs);
    return st;
  }
  /**
   * Season 1 keeps relationships as "<who>_affinity" levels: 0 dislike, 1 neutral, 2 like, 3 love. <who> is either one
   * Islander ("mason_affinity") or a shared role ("jasper_miles_affinity": whoever you coupled with on Day 1,
   * "player_partner_affinity": your partner now...). A role's level is shown under whoever plays that role in your story
   * and wins over that person's own early value; a role nobody has been given yet is left out.
   */
  function seasonOneAffinity(S, save, run) {
    const st = currentState(S, save, run), roles = (save && save.roles) || {};
    const byInternal = new Map();
    for (const c of Object.values(S.characters)) {
      if (c.isPlayer) continue;
      const o = S.get(c.key) || {};
      byInternal.set(norm(o.m_Name), c.key);
      if (!byInternal.has(norm(c.name))) byInternal.set(norm(c.name), c.key);
    }
    const nameOf = (k) => (roles[k] && roles[k].name) || (S.characters[k] || {}).name || "";
    const rows = new Map();   // shown name -> row
    for (const [v, x] of Object.entries(st)) {
      const m = /^(.+)_affinity$/i.exec(v);
      if (!m || typeof x !== "number") continue;
      const k = byInternal.get(norm(m[1]));
      if (!k) continue;                                     // a counter, not a person
      const isRole = m[1].includes("_");
      if (isRole && !roles[k]) continue;                    // shared role not given to anyone yet
      const name = nameOf(k);
      if (!name || /_/.test(name)) continue;
      const rank = /player_partner/i.test(m[1]) ? 3 : isRole ? 2 : 1;
      const prev = rows.get(norm(name));
      if (!prev || rank > prev.rank) rows.set(norm(name), { k, name, level: Math.max(0, Math.min(3, x)), rank, role: isRole });
    }
    return [...rows.values()];
  }

  /** Everything useful for tracking down a story problem, as one object (saved as problem_report.json). */
  function debugReport(S, save, run) {
    const name = (k) => (run ? run.charName(k) : ((S.characters[S.canon(k)] || {}).name || "")) || k;
    const trim = (v, d) => {
      if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
      if (Array.isArray(v)) return d > 3 ? "[…]" : v.slice(0, 40).map((x) => trim(x, d + 1));
      if (v && typeof v === "object") {
        if (d > 3) return "{…}";
        const o = {};
        for (const [k, x] of Object.entries(v)) if (k !== "parent") o[k] = trim(x, d + 1);
        return o;
      }
      return v;
    };
    const describe = (k) => { const o = S.get(k); return o ? { key: k, type: o._c, name: o.m_Name, data: trim(o, 0) } : { key: k }; };
    const node = run && run.node;
    const rel = {};
    for (const [k, t] of Object.entries(save.traits || {})) rel[name(k)] = t;
    const vars = {};
    if (run) for (const [k, x] of Object.entries(run.raw)) if (/partner|couple|crush|date|graft|recoupl|outfit|premium|bought/i.test(k)) vars[k] = x;
    return {
      version: VERSION, season: save && save.season, made: new Date().toISOString(),
      episode: run ? { key: run.ep.key, day: run.ep.day, ep: run.ep.ep } : null,
      node: node ? describe(node) : null,
      nodeLinks: node ? ((S.get(node) || {}).transitions || []).map(describe) : [],
      lastNodes: run ? run.trace.slice(-60) : [],
      roles: Object.fromEntries(Object.entries(save.refs || {}).map(([k, v]) => [k, name(v)])),
      roleChanges: (save.refLog || []).slice(-40),
      sharedRoles: save.roles || {},
      storyVariables: vars,
      changedThisEpisode: run ? Object.fromEntries([...run.touched].slice(-80).map((k) => [k, run.raw[k]])) : {},
      relationships: rel,
      notes: S.notes.slice(-100),
      warnings: Object.fromEntries(S.warnings),
      unresolvedText: [...S.keyMisses],
      completed: (save.completed || []).length,
    };
  }

  /** Make skin-tone-matched parts (like the nose) match the chosen skin tone. Fixes older saves too. */
  function repairLook(S, save) {
    const pk = S.playerKey;
    const trees = [...S.objects.values()].filter((o) => o._c === "CustomizationTree" && (o.SkinToModify || "Default") === "Default");
    for (const t of trees) {
      let model = customizationModel(S, save, t._k);
      for (const name of model.groups.map((g) => g.name)) {
        model = customizationModel(S, save, t._k);
        const g = model.groups.find((x) => x.name === name);
        if (!g || !g.auto || !g.req || !(save.custParams || {})[g.req]) continue;
        let vi = -1, ii = -1;
        g.variants.forEach((v, i) => v.items.forEach((it, j) => { if (selectedItem(save, pk, model.skin, it.key, S)) { vi = i; ii = j; } }));
        if (vi === g.active) continue;
        const v = g.variants[g.active];
        const it = v && v.items[Math.max(0, Math.min(ii, v.items.length - 1))];
        if (it) applyCustomization(S, save, pk, t._k, it.key);
      }
    }
  }

  /** Season 1 hairstyles: "Hair 5 Blonde" (front) plus its matching back piece, grouped by colour. */
  function season1Hair(S) {
    const front = [], back = new Map();
    for (const o of S.objects.values()) {
      if (o._c !== "CustomizationSettings") continue;
      let m;
      if (o.slot === "Hair" && (m = /^Hair (\d+) (\w+)$/.exec(o.m_Name || ""))) front.push({ key: o._k, n: +m[1], colour: m[2] });
      else if (o.slot === "Hair Back") back.set(o.m_Name, o._k);
    }
    if (front.length < 2) return null;
    const colours = [...new Set(front.map((f) => f.colour))];
    const seen = new Set();
    const variants = colours.map((c) => ({
      value: c, label: c,
      items: front.filter((f) => f.colour === c && !seen.has(f.n + c) && seen.add(f.n + c)).sort((a, b) => a.n - b.n).map((f) => ({
        front: f.key, back: back.get(`Hair ${f.n} ${f.colour} Back`) || back.get(`Hair ${f.n} Back`) || back.get("Hair Back None") || null,
        name: `Hair ${f.n}`,
      })),
    }));
    return { type: "hair1", label: "Hair", variants };
  }
  function applySeason1Hair(S, save, charKey, item) {
    const m = ((save.custom = save.custom || {})[charKey] = (save.custom[charKey] || {}));
    m["Default|Hair"] = item.front;
    if (item.back) m["Default|Hair Back"] = item.back;
  }
  function hairLayers(S, item) {
    const out = [];
    for (const k of [item.back, item.front]) { const sp = k && customizationSprite(S, k, "Neutral"); if (!isEmpty(sp)) out.push(sp); }
    return out;
  }

  /** Clothes / Shoes / Jewellery choices for one occasion, built from every outfit the game has for it. */
  function outfitCategories(S, occ) {
    const cats = [{ id: "clothes", label: "Clothes", re: CLOTHES_SLOT }, { id: "shoes", label: "Shoes", re: SHOES_SLOT },
      { id: "jewellery", label: "Jewellery", re: JEWEL_SLOT }];
    for (const cat of cats) {
      cat.options = []; cat.slots = new Set();
      const seen = new Set();
      for (const tk of occ.trees) {
        const t = S.get(tk);
        for (const ck of (t && t.categories) || []) for (const ik of (S.get(ck) || {}).customisationItems || []) {
          const it = S.get(ik);
          if (!it) continue;
          const slots = [...new Set((it.customizations || []).map((x) => (S.get(x) || {}).slot).filter((x) => x && cat.re.test(x)))];
          if (!slots.length) continue;
          slots.forEach((x) => cat.slots.add(x));
          const layers = [];
          for (const sl of slots) { const sp = overrideSprite(S, ik, sl, "Neutral"); if (!isEmpty(sp)) layers.push(Object.assign({ slot: sl }, sp)); }
          const sig = layers.map((l) => l.file).sort().join("|");
          if (seen.has(sig)) continue;
          seen.add(sig);
          cat.options.push({ item: ik, slots, layers, sig, none: !layers.length });
        }
      }
      cat.slots = [...cat.slots];
      cat.options.sort((a, b) => (b.none ? 1 : 0) - (a.none ? 1 : 0));
    }
    return cats.filter((c) => c.options.length > 1 || (c.options.length === 1 && !c.options[0].none));
  }
  function applyOutfitOption(S, save, charKey, skin, cat, opt) {
    const m = ((save.custom = save.custom || {})[charKey] = (save.custom[charKey] || {}));
    for (const sl of cat.slots) m[skin + "|" + sl] = opt.slots.includes(sl) ? opt.item : "-";
    // Outfit items can set a story variable too (like the look screen's items do): keep it for the story.
    const it = S.get(opt.item), pe = it && it.ParameterEffect;
    if (pe && pe.Key) (save.custParams = save.custParams || {})[pe.Key] = pe.Value;
  }
  function outfitSig(S, save, charKey, skin, cat) {
    return avatarLayers(S, save, charKey, "Neutral", skin).filter((l) => cat.slots.includes(l.slot) && !isEmpty(l))
      .map((l) => l.file).sort().join("|");
  }
  /** One look item's own layers (e.g. a skin tone's face, a hairstyle), for thumbnails. */
  function itemLayers(S, itemKey) {
    const it = S.get(itemKey);
    if (!it) return [];
    const out = [], seen = new Set();
    for (const ck of it.customizations || []) {
      const cs = S.get(ck);
      if (!cs || !cs.slot || cs.slot === "Body" || seen.has(cs.slot)) continue;
      seen.add(cs.slot);
      const sp = overrideSprite(S, itemKey, cs.slot, "Neutral");
      if (!isEmpty(sp)) out.push(Object.assign({ slot: cs.slot }, sp));
    }
    const order = ["Hair-back", "Head", "Eye-shade", "Brow", "Eyes", "Nose", "Chin", "Mouth", "Hair-front"];
    return out.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  }
  /** Clothing layers of a whole outfit (Season 1 style), without the body. */
  function clothingLayers(S, save, charKey, skin) {
    return avatarLayers(S, save, charKey, "Neutral", skin).filter((l) => !BODY_SLOT.test(l.slot) && !isEmpty(l));
  }

  const api = { VERSION, Season, Run, newSave, avatarLayers, avatarKeyFor, undressed, customizationModel, applyCustomization, selectedItem,
    wardrobeModel, outfitCategories, applyOutfitOption, outfitSig, clothingLayers, occasionLabel, itemLayers,
    applySeason1Hair, hairLayers, repairLook, migrateSave, debugReport, isUnclothed, currentState, seasonOneAffinity, memoryBefore, stateAt, stateInSave,
    isKeyLike, humanizeKey, statStep, outfitFlag, boughtScore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LIEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
