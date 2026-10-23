/* Real-data check: node tests/real_forgotten.js player/engine.js data/S03  (counts earlier choices that get lost) */
/* node amnesia.js <engine.js> <dataDir> : plays a season with seeded random choices; counts choices that get forgotten */
const fs = require("fs"), path = require("path");
const E = require(path.resolve(process.argv[2]));
const dir = process.argv[3];
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
(async () => {
  const S = new E.Season(async (u) => JSON.parse(fs.readFileSync(u, "utf8")), dir);
  await S.init();
  const save = E.newSave("x"); save.playerName = "Marie";
  let prev = {}, forgotten = 0; const where = {}; let crashes = 0; const lowAff = new Set();
  for (const ep of S.episodes.filter((e) => !e.abAlt)) {
    await S.prepare(ep.controller);
    let run;
    try {
      run = new E.Run(S, save, ep, null);
      for (let g = 0; g < 60000; g++) {
        const st = run.step();
        if (st.type === "end") break;
        if (st.type === "line") run.advance();
        else if (st.type === "choice") run.choose(st.options[Math.floor(rnd() * st.options.length)]);
        else if (st.type === "openworld") run.choose(st.options.find((x) => x.required) || st.options[0]);
        else if (st.type === "customize") run.finishCustomize();
        else run.submitText("");
      }
    } catch (e) { crashes++; console.log("crash", ep.key, e.message); continue; }
    // what the story knows at the end of this episode vs what it knew before
    const now = Object.assign({}, run.raw || run.params);
    const defs = S.paramDefaults ? S.paramDefaults() : {};
    for (const [k, v] of Object.entries(prev)) {
      if (!(k in now)) continue;
      const d = k in defs ? defs[k] : (typeof v === "string" ? "" : typeof v === "boolean" ? false : 0);
      if (v !== d && now[k] === d && !(run.touched && run.touched.has(k))) { forgotten++; where[ep.key] = (where[ep.key] || 0) + 1; if (process.env.DETAIL) console.log('   lost', ep.key, k, JSON.stringify(v), '->', JSON.stringify(now[k])); }
    }
    for (const [k, v] of Object.entries(now)) prev[k] = v;
    for (const [c, t] of Object.entries(save.traits)) if (typeof t.affinity === "number" && t.affinity < 20) lowAff.add((S.characters[c] || {}).name + "=" + t.affinity + "@" + ep.key);
  }
  const top = Object.entries(where).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ":" + v).join(" ");
  const affs = Object.entries(save.traits).map(([c, t]) => t.affinity).filter((x) => typeof x === "number");
  console.log(`${path.basename(dir)}  forgotten values: ${forgotten}  (worst: ${top || "none"})  crashes: ${crashes}  affinity range end: ${Math.min(...affs)}-${Math.max(...affs)}  low(<20): ${[...lowAff].slice(0, 4).join(", ") || "none"}`);
  console.log("   warnings:", JSON.stringify(Object.fromEntries([...S.warnings].filter(([k]) => !/text key/.test(k)))));
})();
