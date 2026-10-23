/* node tests/bugfix_play.js player/engine.js tests/bugfix_data <choice texts, comma separated> */
const fs = require("fs");
const path = require("path");
const E = require(path.resolve(process.argv[2]));
const dir = process.argv[3];
const picks = (process.argv[4] || "").split(",").filter(Boolean);

(async () => {
  const S = new E.Season(async (u) => JSON.parse(fs.readFileSync(u, "utf8")), dir);
  await S.init();
  const save = E.newSave("S99");
  save.playerName = "Marie";
  const out = [];
  for (const ep of S.episodes) {
    await S.prepare(ep.controller);
    const run = new E.Run(S, save, ep, null);
    out.push(`--- ${ep.key}`);
    for (let guard = 0; guard < 200; guard++) {
      const st = run.step();
      if (st.type === "end") break;
      const v = st.view || {};
      const shown = [...new Set((v.stage || []).concat(v.focus && !(v.stage || []).includes(v.focus) ? [v.focus] : []))].map((k) => run.charName(k));
      if (st.type === "line") {
        out.push(`${st.narrator ? "(narration)" : st.name + ":"} ${st.text}` + (st.narrator ? `   [brought forward: ${v.focus ? run.charName(v.focus) : "nobody"}]` : ""));
        run.advance();
      } else if (st.type === "choice") {
        if (st.prompt) out.push(`${st.speaker ? run.charName(st.speaker) + ":" : "(narration)"} ${st.prompt}`);
        const want = picks.find((p) => st.options.some((o) => o.text === p));
        const o = st.options.find((x) => x.text === want) || st.options[0];
        out.push(`  > picks "${o.text}"`);
        run.choose(o);
      } else if (st.type === "customize") {
        out.push("  > opens the outfit picker and keeps the outfit");
        run.finishCustomize();
      } else { out.push("  ? " + st.type); break; }
    }
  }
  const harry = Object.keys(S.characters).find((k) => S.characters[k].name === "Harry");
  out.push(`--- end: Harry affinity = ${JSON.stringify((save.traits[harry] || {}).affinity)}, picked_rude = ${JSON.stringify((save.deltas || save.snapshots)["E1"] && ((save.deltas || {})["E1"] || save.snapshots["E1"]).picked_rude)}`);
  if ([...S.warnings.keys()].length) out.push("warnings: " + JSON.stringify(Object.fromEntries(S.warnings)));
  console.log(out.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
