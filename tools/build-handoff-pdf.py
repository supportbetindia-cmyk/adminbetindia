"""
Builds handoff/BetIndia-Integration-Brief.pdf from handoff/README.md.

Deliberately a small purpose-built renderer rather than a general markdown-to-PDF
converter: the brief has a fixed, known structure, and the output needs to look
like something you would send to an external team.

Uses the design tokens from the UI/UX handoff (#FF6B00 primary, #050B18 navy)
so the document matches the product it describes.

    python tools/build-handoff-pdf.py
"""

import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, KeepTogether, ListFlowable, ListItem,
    PageTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "handoff" / "README.md"
OUTPUT = ROOT / "handoff" / "BetIndia-Integration-Brief.pdf"

NAVY = colors.HexColor("#050B18")
PRIMARY = colors.HexColor("#FF6B00")
INK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#64748B")
BORDER = colors.HexColor("#E2E8F0")
CODE_BG = colors.HexColor("#F1F5F9")
TABLE_HEAD = colors.HexColor("#0B1F3A")

PAGE_W, PAGE_H = A4
MARGIN = 20 * mm


# ── Styles ───────────────────────────────────────────────────

def build_styles():
    base = getSampleStyleSheet()
    s = {}

    s["title"] = ParagraphStyle(
        "title", parent=base["Title"], fontName="Helvetica-Bold",
        fontSize=22, leading=26, textColor=INK, alignment=TA_LEFT, spaceAfter=2,
    )
    s["brand"] = ParagraphStyle(
        "brand", parent=base["Normal"], fontName="Helvetica-Bold",
        fontSize=9, leading=12, textColor=PRIMARY, spaceAfter=6,
    )
    s["subtitle"] = ParagraphStyle(
        "subtitle", parent=base["Normal"], fontName="Helvetica",
        fontSize=10.5, leading=15, textColor=MUTED, spaceAfter=14,
    )
    s["h1"] = ParagraphStyle(
        "h1", parent=base["Heading1"], fontName="Helvetica-Bold",
        fontSize=16, leading=20, textColor=INK, spaceBefore=18, spaceAfter=8,
    )
    s["h2"] = ParagraphStyle(
        "h2", parent=base["Heading2"], fontName="Helvetica-Bold",
        fontSize=12.5, leading=16, textColor=INK, spaceBefore=14, spaceAfter=6,
    )
    s["h3"] = ParagraphStyle(
        "h3", parent=base["Heading3"], fontName="Helvetica-Bold",
        fontSize=10.5, leading=14, textColor=INK, spaceBefore=10, spaceAfter=4,
    )
    s["body"] = ParagraphStyle(
        "body", parent=base["Normal"], fontName="Helvetica",
        fontSize=9.5, leading=14, textColor=INK, spaceAfter=7,
    )
    s["bullet"] = ParagraphStyle(
        "bullet", parent=s["body"], spaceAfter=3,
    )
    s["code"] = ParagraphStyle(
        "code", parent=base["Code"], fontName="Courier",
        fontSize=8, leading=11, textColor=INK,
        backColor=CODE_BG, borderPadding=7, spaceBefore=3, spaceAfter=9,
    )
    s["cell"] = ParagraphStyle(
        "cell", parent=base["Normal"], fontName="Helvetica",
        fontSize=8.5, leading=11.5, textColor=INK,
    )
    s["cellhead"] = ParagraphStyle(
        "cellhead", parent=s["cell"], fontName="Helvetica-Bold",
        textColor=colors.white,
    )
    s["footer"] = ParagraphStyle(
        "footer", parent=base["Normal"], fontName="Helvetica",
        fontSize=7.5, leading=10, textColor=MUTED,
    )
    return s


STYLES = build_styles()


# ── Inline markdown ──────────────────────────────────────────

def inline(text: str) -> str:
    """Converts the inline markdown the brief actually uses into ReportLab markup."""
    text = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    # `code`
    text = re.sub(
        r"`([^`]+)`",
        r'<font face="Courier" size="8.5" backColor="#F1F5F9">\1</font>',
        text,
    )
    # **bold**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    # *italic*
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    # [label](url) -> label only; a printed brief gains nothing from a raw URL
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    return text


def split_row(line: str):
    return [c.strip() for c in line.strip().strip("|").split("|")]


# ── Document assembly ────────────────────────────────────────

def build_story(markdown: str):
    story = []
    lines = markdown.split("\n")
    i = 0
    first_heading_seen = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code
        if stripped.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1
            if block:
                story.append(Preformatted("\n".join(block), STYLES["code"]))
            continue

        # Tables
        if stripped.startswith("|") and i + 1 < len(lines) and set(lines[i + 1].strip()) <= set("|-: "):
            header = split_row(stripped)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            story.append(make_table(header, rows))
            continue

        # Horizontal rule
        if stripped in ("---", "***", "___"):
            story.append(Spacer(1, 6))
            story.append(HRFlowable(width="100%", thickness=0.6, color=BORDER))
            story.append(Spacer(1, 6))
            i += 1
            continue

        # Headings
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped.lstrip("#").strip()
            if not first_heading_seen and level == 1:
                first_heading_seen = True
                i += 1
                continue  # the cover block already carries the title
            key = {1: "h1", 2: "h2", 3: "h3"}.get(level, "h3")
            para = Paragraph(inline(text), STYLES[key])
            if key == "h1":
                story.append(Spacer(1, 4))
                story.append(KeepTogether([para]))
            else:
                story.append(para)
            i += 1
            continue

        # Lists
        if re.match(r"^\s*[-*]\s+", line) or re.match(r"^\s*\d+\.\s+", line):
            items = []
            ordered = bool(re.match(r"^\s*\d+\.\s+", line))

            while i < len(lines) and (
                re.match(r"^\s*[-*]\s+", lines[i]) or re.match(r"^\s*\d+\.\s+", lines[i])
            ):
                parts = [re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", lines[i])]
                i += 1

                # A bullet that soft-wraps continues on the following lines.
                # Without this they escape the list and render as stray
                # paragraphs after it.
                while i < len(lines):
                    nxt = lines[i]
                    if not nxt.strip():
                        break
                    if re.match(r"^\s*(?:[-*]|\d+\.)\s+", nxt):
                        break
                    if re.match(r"^\s*(#|\||```|---$)", nxt):
                        break
                    parts.append(nxt.strip())
                    i += 1

                items.append(ListItem(
                    Paragraph(inline(" ".join(parts)), STYLES["bullet"]), leftIndent=12,
                ))
            story.append(ListFlowable(
                items,
                bulletType="1" if ordered else "bullet",
                bulletFontSize=7,
                bulletColor=PRIMARY,
                leftIndent=14,
                spaceAfter=8,
            ))
            continue

        # Blank
        if not stripped:
            i += 1
            continue

        # Paragraph
        buffer = []
        while i < len(lines) and lines[i].strip() and not re.match(
            r"^\s*(#|[-*]\s|\d+\.\s|\||```|---$)", lines[i]
        ):
            buffer.append(lines[i].strip())
            i += 1
        if buffer:
            story.append(Paragraph(inline(" ".join(buffer)), STYLES["body"]))

    return story


def make_table(header, rows):
    usable = PAGE_W - 2 * MARGIN
    cols = len(header)

    # First column carries the label and needs more room; the rest share what is
    # left. Keeps "Field / Required / Notes" style tables readable.
    if cols == 2:
        widths = [usable * 0.32, usable * 0.68]
    elif cols == 3:
        widths = [usable * 0.26, usable * 0.16, usable * 0.58]
    else:
        widths = [usable / cols] * cols

    data = [[Paragraph(inline(c), STYLES["cellhead"]) for c in header]]
    for row in rows:
        row = (row + [""] * cols)[:cols]
        data.append([Paragraph(inline(c), STYLES["cell"]) for c in row])

    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TABLE_HEAD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FBFDFF")]),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
    ]))
    return KeepTogether([Spacer(1, 2), table, Spacer(1, 10)])


def cover_block():
    return [
        Paragraph("BETINDIA", STYLES["brand"]),
        Paragraph("Click Tracking — Integration Brief", STYLES["title"]),
        Paragraph(
            "For the betindia.bet website team &nbsp;·&nbsp; "
            "Smart Link Manager &nbsp;·&nbsp; go.betindia.games",
            STYLES["subtitle"],
        ),
        HRFlowable(width="100%", thickness=2, color=PRIMARY, spaceAfter=14),
    ]


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(
        MARGIN, 12 * mm,
        "BetIndia Smart Link Manager — Integration Brief",
    )
    canvas.drawRightString(PAGE_W - MARGIN, 12 * mm, f"Page {canvas.getPageNumber()}")
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN, 15 * mm, PAGE_W - MARGIN, 15 * mm)
    canvas.restoreState()


def main():
    if not SOURCE.exists():
        sys.exit(f"Source not found: {SOURCE}")

    markdown = SOURCE.read_text(encoding="utf-8")

    doc = BaseDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=22 * mm,
        title="BetIndia — Click Tracking Integration Brief",
        author="BetIndia Smart Link Manager",
        subject="Integration brief for the betindia.bet website team",
    )
    frame = Frame(
        MARGIN, 22 * mm,
        PAGE_W - 2 * MARGIN, PAGE_H - MARGIN - 22 * mm,
        id="body", showBoundary=0,
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

    doc.build(cover_block() + build_story(markdown))
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
