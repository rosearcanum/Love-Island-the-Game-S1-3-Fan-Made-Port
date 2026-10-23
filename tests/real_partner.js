/* Real-data check, e.g. node tests/real_partner.js player/engine.js data/S03 harry  (partner roles per episode)
 * node play.js <engine.js> <dataDir> <preferRegex> [maxEpisodes] [verbose] */
const fs = require("fs"), path = require("path");
const E = require(path.resolve(process.argv[2]));
const dir = process.argv[3], prefer = new RegExp(process.argv[4] || "^$", "i"), maxEp = +(process.argv[5] || 999), verbose = process.argv[6];
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
(async () => {
  const S = new E.Season(async (u) => JSON.parse(fs.readFileSync(u, "utf8")), dir);
  await S.init();
  const save = E.newSave(path.basename(dir)); save.playerName = "Marie"; save.custParams = save.custParams || {};
  const eps = S.episodes.filter((e) => !e.abAlt).slice(0, maxEp);
  const log = []; let errors = 0;
  for (const ep of eps) {
    await S.prepare(ep.controller);
    let run, lines = 0, partnerLines = {};
    try {
      run = new E.Run(S, save, ep, null);
      for (let g = 0; g < 60000; g++) {
        const st = run.step();
        if (st.type === "end") break;
        if (st.type === "line") {
          lines++;
          const n = S.get(run.node);
          if (n && n._c === "ReferenceCharacterNode" && /PARTNER/i.test((S.get(n.referenceCharacter) || {}).m_Name || "")) partnerLines[st.name] = (partnerLines[st.name] || 0) + 1;
          if (verbose && new RegExp(verbose, "i").test(st.text)) log.push(`   [${ep.key}] ${st.name || "(narr)"}: ${st.text.slice(0, 110)}`);
          run.advance();
        } else if (st.type === "choice") {
          const o = st.options.find((x) => prefer.test(x.text)) || st.options[Math.floor(rnd() * st.options.length)];
          if (process.env.SHOW && new RegExp(process.env.SHOW).test(ep.key) && /couple|partner|pick|choose/i.test((st.prompt || "") + st.options.map((x) => x.text).join(" ")))
            log.push(`   [${ep.key}] ${(st.prompt || "").slice(0, 70)} :: ${st.options.map((x) => x.text.slice(0, 40)).join(" | ")}  => ${o.text.slice(0, 30)}`);
          if (verbose && prefer.test(o.text)) log.push(`   [${ep.key}] > ${o.text.slice(0, 90)}`);
          run.choose(o);
        } else if (st.type === "openworld") run.choose(st.options.find((x) => prefer.test(x.chars.map((k) => run.charName(k)).join(" "))) || st.options.find((x) => x.required) || st.options[0]);
        else if (st.type === "customize") run.finishCustomize();
        else if (st.type === "name" || st.type === "text") run.submitText("");
      }
    } catch (e) { errors++; log.push(`   !! ${ep.key} crashed: ${e.message}`); save.current = null; if (!save.completed.includes(ep.key)) save.completed.push(ep.key); continue; }
    const raw = run.raw || run.params;
    const roles = {}; for (const o of S.objects.values()) if (o._c === "ReferenceCharacterSettings" && /PARTNER/.test(o.m_Name) && !/BESTFRIEND|MIKI|REJECT|EX$/.test(o.m_Name) && !(o.m_Name in roles)) roles[o.m_Name.replace(/^LI3_/, "")] = run.charName(run.resolveRef(o._k));
    const vars = Object.entries(raw).filter(([k, v]) => /^D\d\dE\d\d_partner$/.test(k)).map(([k, v]) => k.slice(0, 3) + "=" + v).join(" ");
    log.push(`${ep.key.padEnd(10)} ${vars.padEnd(40)} roles: ${Object.entries(roles).map(([k, v]) => k.replace("_PARTNER", "") + ":" + v).join(" ")}`);
  }
  console.log(log.join("\n"));
  console.log("errors:", errors, " warnings:", JSON.stringify(Object.fromEntries(S.warnings)));
})().catch((e) => { console.error("FATAL", e.stack); process.exit(1); });
