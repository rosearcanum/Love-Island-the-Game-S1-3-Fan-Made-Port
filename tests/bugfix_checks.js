/* 1.1.4 regression checks on a small fake season with each reported bug built in.
 *   node tests/bugfix_checks.js   (builds tests/bugfix_data the first time)
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "../player/engine.js"));
const dir = path.join(__dirname, "bugfix_data");
if (!fs.existsSync(path.join(dir, "episodes.json"))) require("./bugfix_fixture").build(dir);
let n = 0;
const ok = (c, msg) => { assert.ok(c, msg); n++; console.log("  ok  " + msg); };

async function season(extra) {
  const S = new E.Season(async (u) => {
    if (extra && extra[path.basename(u)]) return extra[path.basename(u)];
    return JSON.parse(fs.readFileSync(u, "utf8"));
  }, dir);
  await S.init();
  return S;
}
const charKey = (S, name) => Object.keys(S.characters).find((k) => S.characters[k].name === name);
function playTo(run, stop) {   // advance until a line containing `stop`
  for (let i = 0; i < 100; i++) {
    const st = run.step();
    if (st.type === "end") return st;
    if (st.type === "line" && st.text.includes(stop)) return st;
    if (st.type === "line") run.advance();
    else if (st.type === "choice") run.choose(st.options.find((o) => /Harry|nice/.test(o.text)) || st.options[0]);
    else if (st.type === "customize") run.finishCustomize();
  }
}

(async () => {
  console.log("helpers");
  ok(E.isKeyLike("AJ.2.I.was.wondering.li"), "AJ key is recognised");
  ok(!E.isKeyLike("Okay.") && !E.isKeyLike("I was wondering.") && !E.isKeyLike("H1") && !E.isKeyLike("Eth2"), "real lines and S1 picture codes are not keys");
  ok(E.humanizeKey("AJ.2.I.was.wondering.li") === "I was wondering li…", "fallback wording for an unknown key");
  ok(E.statStep({ m_Name: "+", modifier: 5 }) === 5 && E.statStep({ m_Name: "----", modifier: 30 }) === -30, "+ and ---- keep their meaning");
  ok(E.statStep({ m_Name: "++", modifier: 0 }) === 10 && E.statStep({ m_Name: "Like-Plus", modifier: 5 }) === 5, "sizes from symbols; a hyphenated name isn't a minus");
  ok(E.statStep({ m_Name: "Affinity --", modifier: 10 }) === -10, "trailing -- is a minus");
  ok(E.outfitFlag("bought_premium_outfit") === true && E.outfitFlag("wearing_default_outfit") === false, "outfit flags read both ways");
  ok(E.outfitFlag("not_bought_outfit") === false, "negated outfit flag");
  ok(E.outfitFlag("gemma_outfit_compliment") === null && E.outfitFlag("partner_premium_choice") === null && E.outfitFlag("swear_paid") === null,
    "no false positives (Gemma, premium choices, 'swear')");

  console.log("save mid-episode and resume");
  {
    const S = await season();
    const save = E.newSave("S99");
    await S.prepare(S.episodes[0].controller);
    const r1 = new E.Run(S, save, S.episodes[0], null);
    playTo(r1, "Hey you");
    const snap = JSON.parse(JSON.stringify(r1.snapshot()));
    const r2 = new E.Run(S, save, S.episodes[0], snap);
    ok(r2.pending && r2.pending.text.includes("Hey you") && r2.pending.name === "Harry", "resume shows the same line, still Harry");
    ok(r2.touched.has("d1_partner"), "resume keeps track of what this episode set");
    r2.advance(); playTo(r2, "@@end");
    ok(save.states.E1 && save.states.E1.d1_partner === "Harry", "episode end saves its whole state");
    ok(save.order[0] === "E1", "finished order recorded");
  }

  console.log("old (1.1.3) save");
  {
    const S = await season();
    await S.prepare(S.episodes[1].controller); await S.prepare(S.episodes[2].controller);
    const harry = charKey(S, "Harry");
    const old = { season: "S99", version: 1, playerName: "M", completed: ["S99_D01E01", "S99_D01E02"], fixes: { aff50: 1 },
      snapshots: { E1: { partner: "Bill", d1_partner: "Harry", picked_rude: false }, E2: { partner: "Bill", d1_partner: "Bill", bought_premium_outfit: false } },
      globals: {}, traits: { [harry]: { affinity: 15 } }, refs: { [S.episodes && Object.keys(S.characters).length && "cab-base:1013"]: harry }, skins: {}, custom: {}, inventory: {}, current: null };
    const refKey = Object.entries(JSON.parse(fs.readFileSync(path.join(dir, "objects/s99_stories.json"), "utf8")).objects)
      .find(([, o]) => o._c === "ReferenceCharacter");
    old.refs = { ["cab-base:" + refKey[0]]: harry };
    E.migrateSave(S, old);
    ok(old.traits[harry].affinity === 65, "score that started at 0 moved up to where it should be (15 -> 65)");
    ok(old.refs["R:partner"] === harry && !old.refs["cab-base:" + refKey[0]], "partner role re-filed by name");
    const mem = E.memoryBefore(S, old, S.episodes[2]);
    ok(mem.d1_partner === "Harry", "Episode 2's untouched default no longer overwrites Day 1's pick in an old save");
    E.migrateSave(S, old);
    ok(old.traits[harry].affinity === 65, "repair only runs once");
  }

  console.log("other season's save (Season 3 looking back)");
  {
    const sv = { order: ["A", "B", "C"], states: { A: { x: 1, p: "Harry" }, B: { x: 2, p: "Harry" }, C: { x: 2, p: "Noah" } } };
    ok(E.stateInSave(sv, "B").p === "Harry" && E.stateInSave(sv, "B").x === 2, "state at a given episode");
    ok(E.stateInSave(sv, "C").p === "Noah", "later change is seen at the later episode");
    const legacy = { snapshots: { A: { p: "Harry" }, B: { p: "Harry", y: 1 } } };
    ok(E.stateInSave(legacy, "B").y === 1, "old-format saves still work");
  }

  console.log("text lookups");
  {
    const objs = JSON.parse(fs.readFileSync(path.join(dir, "objects/s99_stories02.json"), "utf8"));
    // remove the in-pack copy so the line must come from somewhere else
    for (const [k, o] of Object.entries(objs.objects)) if (o.m_Name === "AJ.2.I.was.wondering.li") delete objs.objects[k];
    const csv = "key,english\nAJ.2.I.was.wondering.li,\"I was wondering, like, if you fancied a \"\"chat\"\"?\"\n";
    const S = await season({ "s99_stories02.json": objs, "texts.json": { "cab-x:1": { name: "loc", text: csv } } });
    await S.prepare(S.episodes[1].controller);
    ok(S.textForKey("AJ.2.I.was.wondering.li") === 'I was wondering, like, if you fancied a "chat"?', "found in a localisation table (texts.json)");

    const S2 = await season({ "s99_stories02.json": objs });
    await S2.prepare(S2.episodes[1].controller);
    const run = new E.Run(S2, E.newSave("S99"), S2.episodes[1], null);
    const st = playTo(run, "wondering");
    ok(st.text === "I was wondering li…", "unknown key: readable fallback instead of dots");
    ok(S2.keyMisses.has("AJ.2.I.was.wondering.li"), "...and it's listed in the problem report");

    const objs3 = JSON.parse(JSON.stringify(objs));
    const aj = Object.values(objs3.objects).find((o) => o.text === "AJ.2.I.was.wondering.li");
    aj.femaleText = "I was wondering if you'd like a chat, babe.";
    const S3 = await season({ "s99_stories02.json": objs3 });
    await S3.prepare(S3.episodes[1].controller);
    const st3 = playTo(new E.Run(S3, E.newSave("S99"), S3.episodes[1], null), "wondering");
    ok(st3.text === "I was wondering if you'd like a chat, babe.", "key in the text field, real line in femaleText");

    const objs4 = JSON.parse(JSON.stringify(objs));
    objs4.objects["99999"] = { _c: "CharacterNode", character: Object.values(objs4.objects).find((o) => o.text === "AJ.2.I.was.wondering.li").character,
      m_Name: "line 7", text: "I was wondering, like, whether you're free tonight?" };
    const S4 = await season({ "s99_stories02.json": objs4 });
    await S4.prepare(S4.episodes[1].controller);
    ok(/whether you're free/.test(S4.textForKey("AJ.2.I.was.wondering.li") || ""), "last resort: AJ's own line that starts with those words");
  }

  console.log("Islanders on screen");
  {
    const S = await season();
    await S.prepare(S.episodes[1].controller);
    const miles = charKey(S, "Miles");
    const layers = E.avatarLayers(S, E.newSave("S99"), miles, "Neutral");
    const used = S.notes.find((x) => x.kind === "art-fixed");
    ok(used && used.from === "Jasper" && used.to === "Miles", "Miles drawn with his own art, not Jasper's");
    const jasper = charKey(S, "Jasper");
    E.avatarLayers(S, E.newSave("S99"), jasper, "Neutral");
    ok(S.notes.filter((x) => x.kind === "art-fixed").length === 1, "Jasper keeps his art");

    // Miles was in the scene earlier: narration about him brings him back up
    const save = E.newSave("S99");
    const run = new E.Run(S, save, S.episodes[1], null);
    run.met(miles);
    const st = playTo(run, "Miles strikes");
    ok(st.view.focus === miles && st.view.named, "narration about Miles (seen earlier in the scene) shows Miles");
  }

  console.log("roles and scores");
  {
    const S = await season();
    await S.prepare(S.episodes[0].controller);
    const save = E.newSave("S99");
    const run = new E.Run(S, save, S.episodes[0], null);
    const bill = charKey(S, "Bill"), harry = charKey(S, "Harry");
    const ref = [...S.objects.values()].find((o) => o._c === "ReferenceCharacter")._k;
    run.setRef(ref, harry, "test");
    run.traitsFor(bill).affinity = 55; run.traitsFor(harry).affinity = 55;
    run.action({ _c: "ReferenceCharacterTraitCalculation", referenceCharacter: ref, traitName: "affinity", candidateCharacters: [bill, harry], desiredResult: 0 });
    ok(run.resolveRef(ref) === harry, "a tie doesn't hand the role to whoever is listed first");
    run.traitsFor(bill).affinity = 70;
    run.action({ _c: "ReferenceCharacterTraitCalculation", referenceCharacter: ref, traitName: "affinity", candidateCharacters: [bill, harry], desiredResult: 0 });
    ok(run.resolveRef(ref) === bill, "a real difference still decides");
    ok(save.refLog.length >= 2 && save.refLog[save.refLog.length - 1].now === "Bill", "role changes are logged");
    const t = run.traitsFor(charKey(S, "AJ"));
    ok(t.affinity === 50, "a new Islander starts at neutral (50), not 0");
    run.params.mm = "HARRY ";
    run.dependencyMatrix({ selectedGroupRecords: [{ columns: ["mm", "Bill", "Harry"] }, { columns: ["mm_line", "x", "y"] }] });
    ok(run.raw.mm_line === "y", "matrix match ignores case and spaces");
  }

  console.log("problem report");
  {
    const S = await season();
    await S.prepare(S.episodes[0].controller);
    const save = E.newSave("S99");
    const run = new E.Run(S, save, S.episodes[0], null);
    playTo(run, "Hey you");
    const rep = E.debugReport(S, save, run);
    ok(rep.version === E.VERSION && rep.node.type === "CharacterNode" && rep.lastNodes.length > 2, "report has version, node and recent path");
    ok(rep.roles["R:partner"] === "Harry", "report shows who plays which role");
    ok(JSON.stringify(rep).length < 200000, "report is a reasonable size");
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
