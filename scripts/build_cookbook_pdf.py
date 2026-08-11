#!/usr/bin/env python3
"""Build the printable ARM MCP Quick Start Cookbook from Markdown sources."""

from __future__ import annotations

import argparse
import re
import textwrap
from datetime import date
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "cookbooks"
DEFAULT_OUTPUT = ROOT / "output" / "pdf" / "ARM-MCP-Quick-Start-Cookbook.pdf"

SOURCE_FILES = [
    "README.md",
    "00-connect-codex-and-claude.md",
    "01-pr-component-and-ci-readiness.md",
    "02-daily-deployment-digest.md",
    "03-failed-ci-build-triage.md",
    "04-ncino-build-health.md",
    "05-audit-activity-review.md",
    "06-controlled-build-and-quick-deploy.md",
]

NAVY = colors.HexColor("#13233A")
GREEN = colors.HexColor("#63A70A")
BLUE = colors.HexColor("#087EA4")
INK = colors.HexColor("#202A35")
MUTED = colors.HexColor("#5A6978")
PALE = colors.HexColor("#F3F6F8")
LINE = colors.HexColor("#D6DEE4")
WHITE = colors.white


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    bold_candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    mono_candidates = [
        Path("/System/Library/Fonts/Supplemental/Courier New.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    ]

    regular = next((path for path in candidates if path.exists()), None)
    bold = next((path for path in bold_candidates if path.exists()), None)
    mono = next((path for path in mono_candidates if path.exists()), None)

    if regular and bold and mono:
        pdfmetrics.registerFont(TTFont("CookbookSans", str(regular)))
        pdfmetrics.registerFont(TTFont("CookbookSansBold", str(bold)))
        pdfmetrics.registerFont(TTFont("CookbookMono", str(mono)))
        return "CookbookSans", "CookbookSansBold", "CookbookMono"
    return "Helvetica", "Helvetica-Bold", "Courier"


FONT, FONT_BOLD, FONT_MONO = register_fonts()


def sanitize(text: str) -> str:
    replacements = {
        "→": "->",
        "–": "-",
        "—": "-",
        "’": "'",
        "“": '"',
        "”": '"',
        "…": "...",
        "≥": ">=",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def inline_markup(text: str) -> str:
    text = sanitize(text)
    placeholders: list[str] = []

    def protect(value: str) -> str:
        placeholders.append(value)
        return f"@@MARKUP{len(placeholders) - 1}@@"

    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda match: protect(
            f'<link href="{escape(match.group(2), quote=True)}" color="#087EA4">'
            f"{escape(match.group(1))}</link>"
        ),
        text,
    )
    text = re.sub(
        r"`([^`]+)`",
        lambda match: protect(f'<font name="{FONT_MONO}">{escape(match.group(1))}</font>'),
        text,
    )
    text = escape(text)
    for index, value in enumerate(placeholders):
        text = text.replace(f"@@MARKUP{index}@@", value)
    return text


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "CoverTitle",
            parent=base["Title"],
            fontName=FONT_BOLD,
            fontSize=28,
            leading=32,
            textColor=WHITE,
            alignment=TA_LEFT,
            spaceAfter=16,
        ),
        "subtitle": ParagraphStyle(
            "CoverSubtitle",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=13,
            leading=19,
            textColor=colors.HexColor("#DDE8EF"),
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName=FONT_BOLD,
            fontSize=21,
            leading=25,
            textColor=NAVY,
            spaceBefore=4,
            spaceAfter=10,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=14,
            leading=18,
            textColor=BLUE,
            spaceBefore=12,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "H3",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=11.5,
            leading=15,
            textColor=GREEN,
            spaceBefore=9,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.3,
            leading=13.4,
            textColor=INK,
            spaceAfter=6,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.1,
            leading=13,
            textColor=INK,
            leftIndent=16,
            firstLineIndent=-8,
            spaceAfter=3,
        ),
        "number": ParagraphStyle(
            "Number",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.1,
            leading=13,
            textColor=INK,
            leftIndent=18,
            firstLineIndent=-12,
            spaceAfter=3,
        ),
        "code": ParagraphStyle(
            "Code",
            parent=base["Code"],
            fontName=FONT_MONO,
            fontSize=7.1,
            leading=9.2,
            textColor=INK,
            backColor=PALE,
            borderColor=LINE,
            borderWidth=0.5,
            borderPadding=7,
            leftIndent=3,
            rightIndent=3,
            spaceBefore=4,
            spaceAfter=9,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=base["BodyText"],
            fontName=FONT_BOLD,
            fontSize=7.5,
            leading=9.3,
            textColor=WHITE,
        ),
        "table_body": ParagraphStyle(
            "TableBody",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=7.3,
            leading=9.2,
            textColor=INK,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8,
            leading=11,
            textColor=MUTED,
        ),
    }


STYLES = styles()


def wrap_code(code: str, width: int = 100) -> str:
    wrapped: list[str] = []
    for raw_line in sanitize(code).splitlines():
        if len(raw_line) <= width:
            wrapped.append(raw_line)
            continue
        indent = re.match(r"\s*", raw_line).group(0)
        wrapper = textwrap.TextWrapper(
            width=width,
            subsequent_indent=indent + "  ",
            break_long_words=False,
            break_on_hyphens=False,
            replace_whitespace=False,
            drop_whitespace=False,
        )
        wrapped.extend(wrapper.wrap(raw_line) or [""])
    return "\n".join(wrapped)


def make_table(rows: list[list[str]], content_width: float) -> Table:
    column_count = max(len(row) for row in rows)
    normalized = [row + [""] * (column_count - len(row)) for row in rows]
    rendered: list[list[Paragraph]] = []
    for row_index, row in enumerate(normalized):
        style = STYLES["table_header"] if row_index == 0 else STYLES["table_body"]
        rendered.append([Paragraph(inline_markup(cell.strip()), style) for cell in row])

    table = Table(rendered, colWidths=[content_width / column_count] * column_count, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
            ]
        )
    )
    return table


def parse_markdown(path: Path, content_width: float) -> list[object]:
    lines = path.read_text(encoding="utf-8").splitlines()
    story: list[object] = []
    index = 0

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if not stripped:
            index += 1
            continue

        if stripped.startswith("```"):
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code_lines.append(lines[index])
                index += 1
            index += 1
            story.append(Preformatted(wrap_code("\n".join(code_lines)), STYLES["code"]));
            continue

        if stripped.startswith("|") and index + 1 < len(lines):
            separator = lines[index + 1].strip()
            if re.match(r"^\|?\s*:?-+", separator):
                rows: list[list[str]] = []
                while index < len(lines) and lines[index].strip().startswith("|"):
                    cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                    rows.append(cells)
                    index += 1
                if len(rows) >= 2:
                    rows.pop(1)
                story.extend([make_table(rows, content_width), Spacer(1, 8)])
                continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            level = len(heading.group(1))
            style = STYLES[f"h{level}"]
            title = inline_markup(heading.group(2))
            if level == 1:
                story.extend([Paragraph(title, style), HRFlowable(width="100%", thickness=1.2, color=GREEN), Spacer(1, 7)])
            else:
                story.append(Paragraph(title, style))
            index += 1
            continue

        bullet = re.match(r"^\s*-\s+(.+)$", line)
        if bullet:
            story.append(Paragraph(f"- {inline_markup(bullet.group(1))}", STYLES["bullet"]))
            index += 1
            continue

        numbered = re.match(r"^\s*(\d+)\.\s+(.+)$", line)
        if numbered:
            story.append(
                Paragraph(
                    f"{numbered.group(1)}. {inline_markup(numbered.group(2))}",
                    STYLES["number"],
                )
            )
            index += 1
            continue

        paragraph_lines = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if (
                not candidate
                or candidate.startswith("#")
                or candidate.startswith("```")
                or candidate.startswith("|")
                or re.match(r"^\s*-\s+", lines[index])
                or re.match(r"^\s*\d+\.\s+", lines[index])
            ):
                break
            paragraph_lines.append(candidate)
            index += 1
        story.append(Paragraph(inline_markup(" ".join(paragraph_lines)), STYLES["body"]))

    return story


def cover_story() -> list[object]:
    banner = Table(
        [
            [
                Paragraph("ARM MCP", STYLES["subtitle"]),
                Paragraph("QUICK START", STYLES["subtitle"]),
            ],
            [
                Paragraph("Quick Start Cookbooks", STYLES["title"]),
                "",
            ],
            [
                Paragraph(
                    "Immediate-value workflows for Codex and Claude Code",
                    STYLES["subtitle"],
                ),
                "",
            ],
        ],
        colWidths=[5.2 * inch, 1.3 * inch],
        rowHeights=[0.55 * inch, 1.05 * inch, 0.75 * inch],
    )
    banner.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, -1), WHITE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("SPAN", (0, 1), (1, 1)),
                ("SPAN", (0, 2), (1, 2)),
                ("LEFTPADDING", (0, 0), (-1, -1), 18),
                ("RIGHTPADDING", (0, 0), (-1, -1), 18),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LINEBELOW", (0, 0), (-1, 0), 2, GREEN),
            ]
        )
    )

    recipe_rows = [
        ["01", "Connect Codex or Claude Code"],
        ["02", "PR component and CI readiness"],
        ["03", "Daily deployment digest"],
        ["04", "Failed CI build triage"],
        ["05", "nCino build health"],
        ["06", "Audit activity review"],
        ["07", "Controlled build or quick deploy"],
    ]
    recipe_table = Table(
        [
            [Paragraph(row[0], STYLES["h3"]), Paragraph(row[1], STYLES["body"])]
            for row in recipe_rows
        ],
        colWidths=[0.55 * inch, 5.95 * inch],
    )
    recipe_table.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )

    return [
        banner,
        Spacer(1, 0.55 * inch),
        Paragraph("OUTCOMES", STYLES["h2"]),
        recipe_table,
        Spacer(1, 0.35 * inch),
        HRFlowable(width="100%", thickness=1, color=GREEN),
        Spacer(1, 0.15 * inch),
        Paragraph(
            "Outcome-oriented workflows for PR validation, ARM CI checks, deployment reporting, nCino build health, and audit review. Built from the verified ARM MCP server contract.",
            STYLES["small"],
        ),
        Paragraph(f"Edition: {date.today().isoformat()}", STYLES["small"]),
        PageBreak(),
    ]


def header_footer(canvas, document) -> None:
    canvas.saveState()
    page = canvas.getPageNumber()
    if page > 1:
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(0.65 * inch, 0.53 * inch, 7.85 * inch, 0.53 * inch)
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(0.65 * inch, 0.34 * inch, "ARM MCP Quick Start Cookbooks")
        canvas.drawRightString(7.85 * inch, 0.34 * inch, str(page))
    canvas.restoreState()


def build(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    document = SimpleDocTemplate(
        str(output),
        pagesize=letter,
        rightMargin=0.65 * inch,
        leftMargin=0.65 * inch,
        topMargin=0.62 * inch,
        bottomMargin=0.72 * inch,
        title="ARM MCP Quick Start Cookbooks",
        author="AutoRABIT",
        subject="Immediate-value ARM MCP workflows for Codex and Claude Code",
    )
    content_width = letter[0] - document.leftMargin - document.rightMargin
    story = cover_story()
    for file_index, file_name in enumerate(SOURCE_FILES):
        path = SOURCE_DIR / file_name
        if not path.exists():
            raise FileNotFoundError(path)
        story.extend(parse_markdown(path, content_width))
        if file_index < len(SOURCE_FILES) - 1:
            story.append(PageBreak())
    document.build(story, onFirstPage=header_footer, onLaterPages=header_footer)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    build(arguments.output.resolve())
    print(arguments.output.resolve())


if __name__ == "__main__":
    main()
