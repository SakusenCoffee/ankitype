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

  * It carries no meanings, so those are joined in from the JLPT lists already here.
    Roughly seven in ten of the top 500 find one; the rest are typed without a gloss,
    which is what the meaning toggle already shows for an Anki card with no meaning
    field.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(HERE, "[Freq] JPDB ", "term_meta_bank_1.json")
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
    by_pair, by_word = jlpt_meanings()

    words = []
    for rank in sorted(ranks)[:WANTED]:
        chosen = pick(ranks[rank])
        if not chosen:
            continue
        term, reading = chosen
        entry = {"kanji": term, "reading": reading}
        meaning = by_pair.get((term, reading)) or by_word.get(term)
        if meaning:
            entry["meaning"] = meaning
        words.append(entry)

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(words, fh, ensure_ascii=False, separators=(",", ":"))

    glossed = sum(1 for w in words if "meaning" in w)
    print(f"{len(words)} words -> {OUT} ({glossed} with a meaning)")


if __name__ == "__main__":
    main()
