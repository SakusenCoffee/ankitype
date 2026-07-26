import re, js
from pyscript import document, when
from pyodide.ffi import create_proxy

# Regex Patterns
IGNORED_CHAR_RE = re.compile(r'[\u30FB]')
KANJI_RE = re.compile(r'[\u4E00-\u9FFF]')
HIRAGANA_RE = re.compile(r'[\u3040-\u309F]')
KATAKANA_RE = re.compile(r'[\u30A0-\u30FF]')

@when("input", "#jptext")
def count_text(event):
    input_area = document.querySelector("#jptext")
    text = input_area.value

    # Counting logic
    ignore = len(IGNORED_CHAR_RE.findall(text))
    kanji = len(KANJI_RE.findall(text))
    hiragana = len(HIRAGANA_RE.findall(text))
    katakana = len(KATAKANA_RE.findall(text))

    # UI Updates
    if (el := document.querySelector("#total span")): el.innerText = str((kanji + hiragana + katakana) - ignore)
    if (el := document.querySelector("#kanji span")): el.innerText = str(kanji)
    if (el := document.querySelector("#hiragana span")): el.innerText = str(hiragana)
    if (el := document.querySelector("#katakana span")): el.innerText = str(max(0, katakana - ignore))

_hidden_copy_el = js.document.createElement("textarea")
_hidden_copy_el.style.position = "fixed"
_hidden_copy_el.style.left = "-9999px"
js.document.body.appendChild(_hidden_copy_el)

@when("click", "#total, #kanji, #hiragana, #katakana")
def handle_copy(event):
    span = event.currentTarget.querySelector("span")
    if not span: return
    text_to_copy = span.innerText
    _hidden_copy_el.value = text_to_copy
    _hidden_copy_el.select()
    js.document.execCommand("copy")
    span.innerText = "Copied!"
    def reset_text(): span.innerText = text_to_copy
    js.setTimeout(create_proxy(reset_text), 800)

def init():
    area = document.querySelector("#jptext")
    overlay = document.querySelector("#loader-overlay")
    bar = document.querySelector(".progress-bar")

    if area and overlay and bar:
        area.classList.add("ready")
        area.removeAttribute("disabled")
        area.placeholder = "Paste Japanese text here..."

        bar.style.width = "100%"

        def drop_flower():
            overlay.classList.add("hidden")
            count_text(None)

        js.setTimeout(create_proxy(drop_flower), 500)

init()
