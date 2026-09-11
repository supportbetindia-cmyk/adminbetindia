"""Minimal .docx -> text extractor (stdlib only).

Preserves paragraph breaks, table rows (cells joined by " | ") and heading
markers so the specification structure survives the conversion.
"""
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def para_text(p):
    parts = []
    for node in p.iter():
        tag = node.tag
        if tag == W + "t":
            parts.append(node.text or "")
        elif tag == W + "tab":
            parts.append("\t")
        elif tag == W + "br":
            parts.append("\n")
    return "".join(parts)


def style_of(p):
    pr = p.find(W + "pPr")
    if pr is None:
        return ""
    st = pr.find(W + "pStyle")
    if st is None:
        return ""
    return st.get(W + "val") or ""


def numbered(p):
    pr = p.find(W + "pPr")
    return pr is not None and pr.find(W + "numPr") is not None


def render_block(el, out):
    if el.tag == W + "p":
        txt = para_text(el).strip()
        style = style_of(el)
        m = re.match(r"Heading(\d)", style)
        if m and txt:
            out.append("\n" + "#" * (int(m.group(1)) + 1) + " " + txt)
        elif txt and numbered(el):
            out.append("- " + txt)
        else:
            out.append(txt)
    elif el.tag == W + "tbl":
        for row in el.findall(W + "tr"):
            cells = []
            for cell in row.findall(W + "tc"):
                cell_text = " ".join(
                    para_text(p).strip() for p in cell.findall(W + "p")
                ).strip()
                cells.append(cell_text)
            out.append("| " + " | ".join(cells) + " |")
        out.append("")


def convert(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    body = root.find(W + "body")
    out = []
    for el in body:
        render_block(el, out)
    text = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(convert(sys.argv[1]))
