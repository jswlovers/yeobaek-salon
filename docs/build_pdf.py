"""docs/*.md 매뉴얼을 PDF로 변환합니다. 사용: python docs/build_pdf.py"""
import re
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (ListFlowable, ListItem, Paragraph, Preformatted,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

pdfmetrics.registerFont(TTFont('K', 'C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('KB', 'C:/Windows/Fonts/malgunbd.ttf'))
pdfmetrics.registerFontFamily('K', normal='K', bold='KB', italic='K', boldItalic='KB')

base = ParagraphStyle('b', fontName='K', fontSize=10, leading=15)
S = {
    'h1': ParagraphStyle('h1', base, fontName='KB', fontSize=20, leading=26, spaceAfter=10, textColor=colors.HexColor('#1d211e')),
    'h2': ParagraphStyle('h2', base, fontName='KB', fontSize=14, leading=20, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor('#1d211e')),
    'h3': ParagraphStyle('h3', base, fontName='KB', fontSize=11.5, leading=17, spaceBefore=10, spaceAfter=4),
    'p': ParagraphStyle('p', base, spaceAfter=5),
    'cell': ParagraphStyle('cell', base, fontSize=8.5, leading=12),
    'cellh': ParagraphStyle('cellh', base, fontName='KB', fontSize=8.5, leading=12),
    'code': ParagraphStyle('code', base, fontSize=8, leading=11, backColor=colors.HexColor('#f3efe8'), borderPadding=5, spaceAfter=8),
}


def inline(t):
    t = escape(t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<link href="\2" color="#2a5db0">\1</link>', t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<font color="#8a4b1f">\1</font>', t)
    return t


def table(rows):
    cols = len(rows[0])
    data = [[Paragraph(inline(c), S['cellh' if i == 0 else 'cell']) for c in r] for i, r in enumerate(rows)]
    w = A4[0] - 40 * mm
    widths = [w * 0.22, w * 0.78] if cols == 2 else None
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eadfcf')),
        ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#b9b0a2')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    return [t, Spacer(1, 8)]


def convert(src: Path):
    lines = src.read_text(encoding='utf-8').splitlines()
    story, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith('```'):
            j = i + 1
            while not lines[j].startswith('```'):
                j += 1
            story.append(Preformatted('\n'.join(lines[i + 1:j]), S['code']))
            i = j + 1
        elif ln.startswith('|'):
            j = i
            while j < len(lines) and lines[j].startswith('|'):
                j += 1
            rows = [[c.strip() for c in l.strip().strip('|').split('|')] for l in lines[i:j] if not re.match(r'^\|[\s\-|]+\|$', l)]
            story += table(rows)
            i = j
        elif re.match(r'^(#{1,3}) ', ln):
            n = len(ln) - len(ln.lstrip('#'))
            story.append(Paragraph(inline(ln[n + 1:]), S[f'h{n}']))
            i += 1
        elif re.match(r'^\s*(-|\d+\.) ', ln):
            ordered = ln.lstrip()[0].isdigit()
            items = []
            while i < len(lines) and re.match(r'^\s*(-|\d+\.) ', lines[i]):
                items.append(ListItem(Paragraph(inline(re.sub(r'^\s*(-|\d+\.) ', '', lines[i])), S['p']), leftIndent=14))
                i += 1
            story.append(ListFlowable(items, bulletType='1' if ordered else 'bullet', start=None if not ordered else 1,
                                      bulletFontName='K', bulletFontSize=9, leftIndent=14))
            story.append(Spacer(1, 4))
        elif not ln.strip():
            i += 1
        else:
            para = [ln]
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r'^(#|```|\||\s*(-|\d+\.) )', lines[i]):
                para.append(lines[i]); i += 1
            story.append(Paragraph(inline(' '.join(para)), S['p']))

    out = src.with_suffix('.pdf')
    title = lines[0].lstrip('# ').strip()

    def footer(c, d):
        c.setFont('K', 8); c.setFillColor(colors.grey)
        c.drawCentredString(A4[0] / 2, 10 * mm, f'{title}  ·  {d.page}')

    SimpleDocTemplate(str(out), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm,
                      bottomMargin=18 * mm, title=title, author='여백 미장원').build(story, onFirstPage=footer, onLaterPages=footer)
    print(out)


for f in ('user-manual.md', 'admin-manual.md'):
    convert(Path(__file__).parent / f)
