"""Builds freq.json — the commonest Japanese words, in order — from a JPDB frequency
dictionary that is NOT in this repository.

The dictionary is a Yomichan/Yomitan term-meta bank (jpdb.io, by-frequency-global),
46MB of it, and it is the author's to keep locally rather than ship: drop the folder
beside this script and run `python3 build-freq.py`. Without it, freq.json is simply
whatever was last committed.

Two things the raw bank needs before it is a word list:

  * A rank can hold two spellings of one word. Where the count was taken over a reading
    — JPDB marks those with ㋕ — the word is one people write in kana, so する is taken
    over 為る, こと over 事, それ over 其. Everywhere else the written form is taken, so
    名前 stays 名前.

  * It carries no meanings. Those come from JMdict — the same folder rule applies, it
    is not in the repository — with the JLPT lists preferred where they have one, since
    those glosses are already short enough to sit under a word. JMdict's are cut to the
    first sense for the same reason.

JMdict is EDRDG material under CC BY-SA: the glosses that end up in freq.json are a
derivative of it, and the site credits it in the ANKI drawer's attribution line beside
the note about Anki itself.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "[Freq] JPDB ", "term_meta_bank_1.json")
JMDICT = os.path.join(HERE, "[Bilingual] JMdict (Recommended)")
OUT = os.path.join(HERE, "freq.json")
WANTED = 500

KANJI = re.compile(r"[一-龯㐀-䶿]")


def read_bank(path):
    """rank -> the spellings the bank offers for it."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)

    ranks = {}
    for term, _kind, info in raw:
        if "reading" in info:
            reading = info["reading"]
            rank = info["frequency"]["value"]
            shown = str(info["frequency"]["displayValue"])
        else:
            reading = term
            rank = info["value"]
            shown = str(info["displayValue"])

        # ❌ marks a term the corpus never saw, which is not a frequency at all
        if "❌" in shown:
            continue

        slot = ranks.setdefault(rank, {"kana": None, "kanji": None, "by_reading": False})
        if "㋕" in shown:
            slot["by_reading"] = True

        key = "kanji" if KANJI.search(term) else "kana"
        if slot[key] is None:
            slot[key] = (term, reading)

    return ranks


def pick(slot):
    if slot["by_reading"] and slot["kana"]:
        return slot["kana"]
    return slot["kanji"] or slot["kana"]


def structured_text(node, want, out, inside=False):
    """Yomitan glossaries are nested content objects; this pulls the words back out."""
    if isinstance(node, str):
        if inside:
            out.append(node)
        return
    if isinstance(node, list):
        for child in node:
            structured_text(child, want, out, inside)
        return
    if isinstance(node, dict):
        data = node.get("data") or {}
        structured_text(node.get("content"), want, out, inside or data.get("content") == want)


def first_sense(entry):
    """One sense, short enough to sit under a word on screen."""
    for want in ("glossary", "infoGlossary"):
        out = []
        structured_text(entry[5], want, out)
        text = " ".join(t.strip() for t in out if t.strip())
        if text:
            break
    else:
        text = "; ".join(g for g in entry[5] if isinstance(g, str))

    if not text:
        return ""
    # The first sense only, and never a paragraph of it
    text = re.split(r"\s{2,}|;|\u3001", text)[0].strip()
    return text[:59] + "…" if len(text) > 60 else text


def jmdict_meanings(wanted):
    """The glosses JMdict has for the words asked about.

    Indexed by reading as well as by written form, because a word people write in kana is
    usually filed under its kanji: ある is JMdict's 有る, and looking for the kana alone
    finds nothing. The reading index is the way back to it.

    Scores are kept rather than spent, because the caller has three ways to reach a word
    and the best answer is not always the most specific one: とき matches a kana headword
    exactly and a Shinkansen service is what that gets you, while the same reading under
    時 is the word anybody means. JMdict scores by how ordinary a word is, so the pick is
    made across all three."""
    by_pair, by_word, by_reading = {}, {}, {}
    # listdir, not glob: the folder is called "[Bilingual] JMdict" and glob reads the
    # brackets as "one of B, i, l..." — the same trap .gitignore has
    banks = sorted(
        os.path.join(JMDICT, name)
        for name in (os.listdir(JMDICT) if os.path.isdir(JMDICT) else [])
        if name.startswith("term_bank_") and name.endswith(".json")
    )
    if not banks:
        print("No JMdict beside this script — meanings will come from the JLPT lists alone.")
        return by_pair, by_word, by_reading

    for path in banks:
        with open(path, encoding="utf-8") as fh:
            for entry in json.load(fh):
                term, reading = entry[0], entry[1] or entry[0]
                if term not in wanted and reading not in wanted:
                    continue
                gloss = first_sense(entry)
                if not gloss:
                    continue

                score = entry[4] if isinstance(entry[4], (int, float)) else 0
                # "uk" is JMdict for "usually written in kana", which is the very class of
                # word the picker above chose a kana form for — こと is 事 and not 琴
                usually_kana = "uk" in str(entry[2]).split()

                for index, key in ((by_pair, (term, reading)), (by_word, term), (by_reading, reading)):
                    held = index.get(key)
                    # Ties are common — 事 and 琴 are both ordinary words with the same
                    # score — and the one written in kana is the one this list means

                    if held is None or (score, usually_kana) > (held[0], held[2]):
                        index[key] = (score, gloss, usually_kana)

    return by_pair, by_word, by_reading


def jlpt_meanings():
    """Every meaning the site already has, by written form and by reading."""
    by_pair, by_word = {}, {}
    for level in ("n5", "n4", "n3", "n2", "n1"):
        with open(os.path.join(HERE, f"{level}.json"), encoding="utf-8") as fh:
            for entry in json.load(fh):
                by_pair.setdefault((entry["kanji"], entry["reading"]), entry["meaning"])
                by_word.setdefault(entry["kanji"], entry["meaning"])
    return by_pair, by_word


def main():
    if not os.path.exists(BANK):
        raise SystemExit(f"No frequency dictionary at {BANK} — see the note at the top of this file.")

    ranks = read_bank(BANK)
    chosen = [pick(ranks[r]) for r in sorted(ranks)[:WANTED]]
    chosen = [c for c in chosen if c]

    jlpt_pair, jlpt_word = jlpt_meanings()
    jm_pair, jm_word, jm_reading = jmdict_meanings(
        {term for term, _ in chosen} | {reading for _, reading in chosen})

    words = []
    missing = []
    for term, reading in chosen:
        # The JLPT lists first — they are already written to sit under a word — and
        # otherwise whichever of JMdict's three ways in offers the commonest word
        meaning = jlpt_pair.get((term, reading)) or jlpt_word.get(term)
        if not meaning:
            found = [c for c in (jm_pair.get((term, reading)), jm_word.get(term),
                                 jm_reading.get(reading)) if c]
            if found:
                # A word this list writes in kana wants the sense that is written in kana
                written_in_kana = not KANJI.search(term)
                meaning = max(
                    found,
                    key=lambda scored: (scored[0] + (1_000_000 if written_in_kana and scored[2] else 0))
                )[1]
        if not meaning:
            missing.append(term)
        words.append({"kanji": term, "reading": reading, "meaning": meaning or ""})

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(words, fh, ensure_ascii=False, separators=(",", ":"))

    glossed = sum(1 for w in words if w["meaning"])
    print(f"{len(words)} words -> {OUT} ({glossed} with a meaning)")
    if missing:
        print("no gloss found for:", " ".join(missing))


if __name__ == "__main__":
    main()
