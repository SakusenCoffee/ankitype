"""Builds joyo.json — the 2,136 jōyō kanji as a word list — and kanji-yomi.json, the
readings any single kanji answers to, from joyo2010.json plus two dictionaries that are
not in this repository (see build-freq.py for the folder rule).

joyo2010.json is the 2010 cabinet list: every kanji with its on and kun readings. It says
nothing about which reading is the ordinary one and nothing about what the kanji means, so:

  * The reading a bare kanji is given in the test comes from the JPDB kanji dictionary,
    which counts how often each is used — 人 is にん before ひと. Where that says nothing,
    kun before on, since a kanji standing alone is usually being read as a word.

  * The meaning comes from JMdict, which has most single kanji as words in their own
    right. Those that aren't are left without one rather than given a guess.

kanji-yomi.json is what lets a standalone kanji be typed either way round: kanji ->
every reading it has, in kana. Kana rather than romaji so the page turns them into
letters with the same converter it used on the word itself, and the two cannot disagree.
It is used for any bare kanji in any list, not only the jōyō level.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
JOYO = os.path.join(HERE, "joyo2010.json")
JPDB_KANJI = os.path.join(HERE, "[Kanji] JPDB Kanji", "kanji_bank_1.json")
JMDICT = os.path.join(HERE, "[Bilingual] JMdict (Recommended)")
OUT_LIST = os.path.join(HERE, "joyo.json")
OUT_YOMI = os.path.join(HERE, "kanji-yomi.json")

# The reading files write kun readings as stems: しか-る, ひと-つ. The part before the
# hyphen is the kanji's own reading; what follows is the okurigana and is not.
STEM = re.compile(r"[-.].*$")

KATAKANA = {chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)}


def to_hiragana(text):
    return "".join(KATAKANA.get(ch, ch) for ch in text)


def load_joyo():
    with open(JOYO, encoding="utf-8") as fh:
        raw = json.load(fh)

    out = {}
    for entry in raw.values():
        kanji = entry["joyo_kanji"]
        yomi = entry.get("yomi") or {}
        on = [STEM.sub("", r) for r in yomi.get("on_yomi", [])]
        kun = [STEM.sub("", r) for r in yomi.get("kun_yomi", [])]
        out[kanji] = {"on": [to_hiragana(r) for r in on], "kun": [to_hiragana(r) for r in kun]}
    return out


def jpdb_reading_order():
    """kanji -> its readings, commonest first, from the percentages JPDB records."""
    if not os.path.exists(JPDB_KANJI):
        return {}

    with open(JPDB_KANJI, encoding="utf-8") as fh:
        raw = json.load(fh)

    order = {}
    for entry in raw:
        kanji, readings = entry[0], entry[2] or ""
        ranked = []
        for piece in readings.split():
            reading = re.sub(r"\(\d+%\)$", "", piece)
            if reading:
                ranked.append(to_hiragana(reading))
        if ranked:
            order[kanji] = ranked
    return order


def jmdict_single_kanji():
    """Glosses for the kanji that are also words: 人, 山, 本."""
    banks = sorted(
        os.path.join(JMDICT, name)
        for name in (os.listdir(JMDICT) if os.path.isdir(JMDICT) else [])
        if name.startswith("term_bank_") and name.endswith(".json")
    )
    if not banks:
        print("No JMdict beside this script — the jōyō list will have no meanings.")
        return {}

    # The gloss reader lives next door; one copy of it is enough. Loaded by path
    # because build-freq.py has a hyphen in it and so cannot simply be imported.
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_freq", os.path.join(HERE, "build-freq.py"))
    build_freq = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build_freq)

    best = {}
    for path in banks:
        with open(path, encoding="utf-8") as fh:
            for entry in json.load(fh):
                term = entry[0]
                if len(term) != 1:
                    continue
                gloss = build_freq.first_sense(entry)
                if not gloss:
                    continue
                score = entry[4] if isinstance(entry[4], (int, float)) else 0
                held = best.get(term)
                if held is None or score > held[0]:
                    best[term] = (score, gloss)
    return {k: v[1] for k, v in best.items()}


def main():
    if not os.path.exists(JOYO):
        raise SystemExit(f"No {JOYO} — the 2010 jōyō list is what this is built from.")

    joyo = load_joyo()
    order = jpdb_reading_order()
    meanings = jmdict_single_kanji()

    yomi_out = {}
    listed = []

    for kanji, readings in joyo.items():
        every = list(dict.fromkeys(readings["kun"] + readings["on"]))
        if not every:
            continue
        yomi_out[kanji] = every

        # The one it is given to type: whichever JPDB sees most, else a kun reading
        ranked = [r for r in order.get(kanji, []) if r in every]
        primary = ranked[0] if ranked else (readings["kun"] or readings["on"])[0]

        entry = {"kanji": kanji, "reading": primary}
        gloss = meanings.get(kanji)
        if gloss:
            entry["meaning"] = gloss
        listed.append(entry)

    with open(OUT_LIST, "w", encoding="utf-8") as fh:
        json.dump(listed, fh, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_YOMI, "w", encoding="utf-8") as fh:
        json.dump(yomi_out, fh, ensure_ascii=False, separators=(",", ":"))

    glossed = sum(1 for e in listed if "meaning" in e)
    print(f"{len(listed)} kanji -> {OUT_LIST} ({glossed} with a meaning)")
    print(f"{len(yomi_out)} kanji -> {OUT_YOMI}")


if __name__ == "__main__":
    main()
