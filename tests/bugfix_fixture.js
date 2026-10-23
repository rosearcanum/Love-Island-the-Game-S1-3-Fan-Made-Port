/* Version 1.1.4 bug-fix checks. Builds a small fake season ("S99") in the converter's format, with each reported bug built in. */
const fs = require("fs");
const path = require("path");

function build(dir) {
  const bundles = {};       // bundle -> {cab, objects}
  const B = (bundle, cab) => (bundles[bundle] = bundles[bundle] || { cab, bundle, objects: {} });
  let pid = 1000;
  const add = (bundle, cab, cls, fields) => { const id = String(pid++); B(bundle, cab).objects[id] = Object.assign({ _c: cls }, fields); return `${cab}:${id}`; };
  const base = (c, f) => add("s99_stories", "cab-base", c, f);
  const av = (c, f) => add("s99_avatars", "cab-av", c, f);
  const ip = (c, f) => add("s99_ip_metadata", "cab-ip", c, f);
  const e1 = (c, f) => add("s99_stories01", "cab-e1", c, f);
  const e2 = (c, f) => add("s99_stories02", "cab-e2", c, f);
  const e3 = (c, f) => add("s99_stories03", "cab-e3", c, f);
  const set = (k, f) => { const [cab, id] = k.split(":"); for (const b of Object.values(bundles)) if (b.cab === cab) Object.assign(b.objects[id], f); };

  /* ---- characters (avatar pack) */
  const affinity = av("Parameter", { m_Name: "affinity", type: 1, defaultIntValue: 0 });      // file default 0 ("hate")
  const avatars = {};
  for (const n of ["Player", "Bill", "Harry", "Mason", "Miles", "Jasper", "AJ"]) avatars[n] = av("Avatar", { m_Name: n, skins: [], expressions: [], slots: [] });
  const chars = {};
  const pb = av("PlayerBehaviour", { avatar: avatars.Player });
  chars.Player = av("CharacterSettings", { m_Name: "Player", characterName: "Player", behaviours: [pb] });
  for (const n of ["Bill", "Harry", "Mason", "Miles", "Jasper", "AJ"]) {
    // Data quirk: Miles is drawn with Jasper's avatar.
    const ab = av("AvatarBehaviour", { avatar: n === "Miles" ? avatars.Jasper : avatars[n] });
    const tb = av("CharacterTraitsBehaviour", { traitParameters: [affinity] });                 // no back-link to the character
    chars[n] = av("CharacterSettings", { m_Name: n, characterName: n, behaviours: [ab, tb] });
    chars[n + "_traits"] = tb;
  }

  /* ---- shared story things (base pack) */
  const stat = base("Stat", { m_Name: "Affinity", maximumValue: 100 });
  const plus = base("StatModifier", { m_Name: "+", modifier: 5, stat });
  const likePlus = base("StatModifier", { m_Name: "Like-Plus", modifier: 5, stat });   // old engine: "-" in the name = minus
  const minus = base("StatModifier", { m_Name: "--", modifier: 10, stat });
  const neutral = base("StatRange", { m_Name: "Neutral", valueRange: { x: 40, y: 59 } });
  const like = base("StatRange", { m_Name: "Like", valueRange: { x: 60, y: 79 } });
  const refPartner1 = base("ReferenceCharacter", { m_Name: "Partner", character: chars.Bill });   // default Islander: Bill

  /* ---- episode 1 (pack 01): couple up, partner line, trait change, duplicate-named options */
  const pPartner1 = e1("Parameter", { m_Name: "partner", type: 4, defaultStringValue: "Bill" });
  const pD1 = e1("Parameter", { m_Name: "d1_partner", type: 4, defaultStringValue: "Bill" });
  const pRude = e1("Parameter", { m_Name: "picked_rude", type: 2, defaultBoolValue: false });
  const g1 = e1("Story", { m_Name: "E1" });
  const end1 = e1("NarratorNode", { parent: g1, text: "", transitions: [] });
  const tr = (from, slot, to, extra) => { const t = e1("Transition", Object.assign({ fromSlot: slot, destination: to, mute: 0, conditions: [] }, extra || {})); return t; };
  // duplicate option names (both "Choice")
  const n6a = e1("StoryModificationNode", { parent: g1, modifications: [e1("BoolModification", { parameterName: "picked_rude", newValue: { constant: 1, value: 0 } })], transitions: [] });
  const n6b = e1("StoryModificationNode", { parent: g1, modifications: [e1("BoolModification", { parameterName: "picked_rude", newValue: { constant: 1, value: 1 } })], transitions: [] });
  const dA = e1("Choice", { m_Name: "Choice", text: "Be nice to Harry" });
  const dB = e1("Choice", { m_Name: "Choice", text: "Be rude to Harry",
    modifications: [e1("StatModification", { parameterName: "affinity", newValue: { constant: 1, value: minus } })] });  // stat change stored on the option
  const n5 = e1("ChoiceNode", { parent: g1, character: chars.Harry, text: "So what do you think of me?", choices: [dA, dB],
    transitions: [tr(null, "Choice", n6a), tr(null, "Choice", n6b)] });
  const n4 = e1("CharacterTraitModificationNode", { parent: g1, characterTraits: chars.Harry_traits,
    modifications: [e1("StatModification", { parameterName: "affinity", newValue: { constant: 1, value: plus } }),
      e1("StatModification", { parameterName: "affinity", newValue: { constant: 1, value: likePlus } })], transitions: [tr(null, "Out", n5)] });
  // partner line: a CharacterNode set to "use reference character"; its plain character field still says Bill
  const n3 = e1("CharacterNode", { parent: g1, character: chars.Bill, useReferenceCharacter: 1, referenceCharacter: refPartner1,
    text: "Hey you! Glad we're coupled up.", transitions: [tr(null, "Out", n4)] });
  const setBill = e1("StoryModificationNode", { parent: g1, modifications: [e1("StringModification", { parameterName: "d1_partner", newValue: { constant: 1, value: "Bill" } })], transitions: [tr(null, "Out", n3)] });
  const setHarry = e1("StoryModificationNode", { parent: g1, modifications: [e1("StringModification", { parameterName: "d1_partner", newValue: { constant: 1, value: "Harry" } })], transitions: [tr(null, "Out", n3)] });
  const cBill = e1("ReferenceCharacterChoice", { m_Name: "Bill", text: "Couple up with Bill", referenceCharacter: refPartner1, newCharacter: chars.Bill });
  const cHarry = e1("ReferenceCharacterChoice", { m_Name: "Harry", text: "Couple up with Harry", referenceCharacter: refPartner1, newCharacter: chars.Harry });
  const n2 = e1("ChoiceNode", { parent: g1, text: "Who do you couple up with?", choices: [cBill, cHarry], transitions: [tr(null, "Bill", setBill), tr(null, "Harry", setHarry)] });
  const n1 = e1("NarratorNode", { parent: g1, text: "Welcome to the villa.", transitions: [tr(null, "Out", n2)] });
  set(g1, { nodes: [n1, n2, n3, n4, n5, n6a, n6b, setBill, setHarry, end1], defaultNode: n1 });
  const c1 = e1("StoryController", { m_Name: "E1", id: "E1", rootGraph: g1, parameterList: [pPartner1, pD1, pRude] });

  /* ---- episode 2 (pack 02, its own copy of the Partner role): no import, AJ key line, narration, wardrobe */
  const t2 = (slot, to, extra) => e2("Transition", Object.assign({ fromSlot: slot, destination: to, mute: 0, conditions: [] }, extra || {}));
  const refPartner2 = e2("ReferenceCharacter", { m_Name: "Partner", character: chars.Bill });   // pack copy, default Bill
  const pPartner2 = e2("Parameter", { m_Name: "partner", type: 4, defaultStringValue: "Bill" });
  const pD1b = e2("Parameter", { m_Name: "d1_partner", type: 4, defaultStringValue: "Bill" });
  const pBought = e2("Parameter", { m_Name: "bought_premium_outfit", type: 2, defaultBoolValue: false });
  const pLook = e2("Parameter", { m_Name: "outfit_tier", type: 4, defaultStringValue: "" });
  const g2 = e2("Story", { m_Name: "E2" });
  const end2 = e2("NarratorNode", { parent: g2, text: "", transitions: [] });
  const nNo = e2("NarratorNode", { parent: g2, text: "Nobody mentions your outfit.", transitions: [t2("Out", end2)] });
  const nYes = e2("CharacterNode", { parent: g2, character: chars.AJ, text: "Babe, that outfit is everything!", transitions: [t2("Out", end2)] });
  const caseYes = e2("BoolLogicalCase", { m_Name: "Yes", parameterName: "bought_premium_outfit", comparisonMode: 0, targetValue: { constant: 1, value: 1 } });
  const n7 = e2("StoryLogicNode", { parent: g2, logicalCases: [caseYes], transitions: [t2("Yes", nYes), t2("Out", nNo)] });
  const caseTier = e2("StringLogicalCase", { m_Name: "Premium", parameterName: "outfit_tier", comparisonMode: 0, targetValue: { constant: 1, value: "premium" } });
  const nTierNo = e2("NarratorNode", { parent: g2, text: "The girls give your look a pitying glance.", transitions: [t2("Out", n7)] });
  const nTierYes = e2("NarratorNode", { parent: g2, text: "The girls gasp at your look.", transitions: [t2("Out", n7)] });
  const n6 = e2("StoryLogicNode", { parent: g2, logicalCases: [caseTier], transitions: [t2("Premium", nTierYes), t2("Out", nTierNo)] });
  const nDefault = e2("NarratorNode", { parent: g2, text: "Everyone stares at your basic outfit.", transitions: [t2("Out", n6)] });
  const nBought = e2("NarratorNode", { parent: g2, text: "Everyone loves your new outfit!", transitions: [t2("Out", n6)] });
  // outfit tree: a free item and a paid item, each setting outfit_tier
  const itFree = e2("CustomizationItem", { m_Name: "Dress_Basic_item", customizations: [], ParameterEffect: { Key: "outfit_tier", Value: "default" } });
  const itPaid = e2("CustomizationItem", { m_Name: "Dress_Gold_item", GemCost: 25, customizations: [], ParameterEffect: { Key: "outfit_tier", Value: "premium" } });
  const cat = e2("CustomizationCategory", { m_Name: "Dress", customisationItems: [itFree, itPaid] });
  const tree = e2("CustomizationTree", { m_Name: "EveningTree", SkinToModify: "Evening", categories: [cat] });
  const n5w = e2("WardrobeNode", { parent: g2, ClothingCustomizationTree: tree, transitions: [t2("Out", nDefault), t2("Purchased", nBought)] });
  const nMiles = e2("NarratorNode", { parent: g2, text: "Miles strikes a pose by the pool, flexing for nobody in particular.", transitions: [t2("Out", n5w)] });
  const nMason = e2("CharacterNode", { parent: g2, character: chars.Mason, text: "Look at this guy.",
    actions: [e2("EnterView", { character: chars.Mason, overflow: 1 })], transitions: [t2("Out", nMiles)] });
  const nAJ = e2("CharacterNode", { parent: g2, character: chars.AJ, text: "AJ.2.I.was.wondering.li", transitions: [t2("Out", nMason)] });
  e2("CharacterNode", { m_Name: "AJ.2.I.was.wondering.li", character: chars.AJ, text: "I was wondering, like, if you fancied a chat later?" });  // the real wording, elsewhere in the pack
  const nMorning = e2("ReferenceCharacterNode", { parent: g2, referenceCharacter: refPartner2, text: "Morning, babe.", transitions: [t2("Out", nAJ)],
    actions: [e2("ModifyReferenceCharacter", { referenceCharacter: refPartner2, Parameter: { parameter: pPartner2, constant: 0 },
      CharacterAssignments: [{ ParameterValue: "Bill", NewCharacterSettings: chars.Bill }, { ParameterValue: "Harry", NewCharacterSettings: chars.Harry }] })] });
  set(g2, { nodes: [nMorning, nAJ, nMason, nMiles, n5w, nDefault, nBought, n6, nTierNo, nTierYes, n7, nYes, nNo, end2], defaultNode: nMorning });
  const c2 = e2("StoryController", { m_Name: "E2", id: "E2", rootGraph: g2, parameterList: [pPartner2, pD1b, pBought, pLook] });

  /* ---- episode 3 (pack 03): imports episode 2 and checks Day 1's partner and Harry's score */
  const t3 = (slot, to) => e3("Transition", { fromSlot: slot, destination: to, mute: 0, conditions: [] });
  const pD1c = e3("Parameter", { m_Name: "d1_partner", type: 4, defaultStringValue: "Bill" });
  const g3 = e3("Story", { m_Name: "E3" });
  const end3 = e3("NarratorNode", { parent: g3, text: "", transitions: [] });
  const likeYes = e3("CharacterNode", { parent: g3, character: chars.Harry, text: "I really like you, you know.", transitions: [t3("Out", end3)] });
  const likeNo = e3("CharacterNode", { parent: g3, character: chars.Harry, text: "Do I even know you?", transitions: [t3("Out", end3)] });
  const lcLike = e3("StatLogicalCase", { m_Name: "Likes", parameterName: "affinity", comparisonMode: 4, targetValue: { constant: 1, value: like } });
  const nLike = e3("CharacterTraitLogicNode", { parent: g3, characterTraits: chars.Harry_traits, logicalCases: [lcLike], transitions: [t3("Likes", likeYes), t3("Out", likeNo)] });
  const remembered = e3("NarratorNode", { parent: g3, text: "You think back to Day 1, when you picked Harry.", transitions: [t3("Out", nLike)] });
  const forgot = e3("NarratorNode", { parent: g3, text: "You think back to Day 1, when you picked Bill.", transitions: [t3("Out", nLike)] });
  const lcHarry = e3("StringLogicalCase", { m_Name: "Harry", parameterName: "d1_partner", comparisonMode: 0, targetValue: { constant: 1, value: "Harry" } });
  const nCheck = e3("StoryLogicNode", { parent: g3, logicalCases: [lcHarry], transitions: [t3("Harry", remembered), t3("Out", forgot)] });
  const info2 = ip("EpisodeInformation", { episodeMetadataKey: "S99_D01E02", storyControllerId: "E2" });
  const nStart = e3("StoryNode", { parent: g3, actions: [e3("ImportParametersFromStory", { referenceStory: info2 })], transitions: [t3("Out", nCheck)] });
  set(g3, { nodes: [nStart, nCheck, remembered, forgot, nLike, likeYes, likeNo, end3], defaultNode: nStart });
  const c3 = e3("StoryController", { m_Name: "E3", id: "E3", rootGraph: g3, parameterList: [pD1c] });
  ip("EpisodeInformation", { episodeMetadataKey: "S99_D01E01", storyControllerId: "E1" });
  ip("EpisodeInformation", { episodeMetadataKey: "S99_D01E03", storyControllerId: "E3" });

  /* ---- write */
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  const cabs = {};
  for (const b of Object.values(bundles)) {
    cabs[b.cab] = b.bundle;
    fs.writeFileSync(path.join(dir, "objects", b.bundle + ".json"), JSON.stringify(b));
  }
  const episodes = [
    { key: "S99_D01E01", day: 1, ep: 1, controllerId: "E1", controller: c1, bundle: "s99_stories01" },
    { key: "S99_D01E02", day: 1, ep: 2, controllerId: "E2", controller: c2, bundle: "s99_stories02" },
    { key: "S99_D01E03", day: 1, ep: 3, controllerId: "E3", controller: c3, bundle: "s99_stories03" },
  ];
  const w = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  w("episodes.json", episodes);
  w("controllers.json", [{ id: "E1", key: c1 }, { id: "E2", key: c2 }, { id: "E3", key: c3 }]);
  w("sprites.json", {}); w("backgrounds.json", {}); w("audio.json", {}); w("effects.json", {}); w("cabs.json", cabs);
  return { chars, refPartner1, refPartner2, avatars, plus, likePlus, minus };
}
module.exports = { build };
