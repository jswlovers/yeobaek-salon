"""docs/*.md 초안에서 고객에게 공개할 부분만 뽑아 terms.html·privacy.html·policy.html을 만듭니다.
사용: python docs/build_legal_pages.py
- 공개 범위: 첫 본문 장(START)부터 부록 전까지. 제목에 '(내부)'가 붙은 절은 빼고, '(공개)' 등 표시는 지웁니다.
"""
import re
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = [
    # (원본, 출력, 화면 제목, 공개 시작 제목)
    ('terms-of-service.md', 'terms.html', '이용약관', '## 제1장'),
    ('privacy-policy.md', 'privacy.html', '개인정보처리방침', '## 제1조'),
    ('operation-policy.md', 'policy.html', '운영정책', '## 제1장'),
]
LINKS = [('terms.html', '이용약관'), ('privacy.html', '개인정보처리방침'), ('policy.html', '운영정책')]


def inline(t):
    t = escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)


def public_lines(lines, start):
    """START 제목부터 '## 부록' 전까지, '(내부)' 절 제외."""
    i = next(n for n, l in enumerate(lines) if l.startswith(start))
    out, skip_level = [], 0
    for l in lines[i:]:
        if l.startswith('## 부록'):
            break
        m = re.match(r'^(#{2,3}) ', l)
        if m:
            level = len(m.group(1))
            if skip_level and level > skip_level:
                continue
            skip_level = level if '(내부)' in l else 0
            l = re.sub(r'\s*\((공개|내부|[^)]*공개[^)]*)\)\s*$', '', l)
        if not skip_level:
            out.append(l)
    return out


def to_html(lines):
    html, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith('```'):
            j = lines.index('```', i + 1) if '```' in lines[i + 1:] else len(lines)
            html.append(f'<pre>{escape(chr(10).join(lines[i + 1:j]))}</pre>')
            i = j + 1
        elif ln.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                if not re.match(r'^\|[\s\-|]+\|$', lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            head = ''.join(f'<th>{inline(c)}</th>' for c in rows[0])
            body = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows[1:])
            html.append(f'<div class="legal-table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        elif m := re.match(r'^(#{2,3}) (.*)', ln):
            tag = 'h2' if m.group(1) == '##' else 'h3'
            html.append(f'<{tag}>{inline(m.group(2))}</{tag}>')
            i += 1
        elif re.match(r'^(-|\d+\.) ', ln):
            ordered = ln[0].isdigit()
            start = int(ln.split('.')[0]) if ordered else 1
            items = []
            while i < len(lines) and re.match(r'^((-|\d+\.)|\s+[a-z]\.) ', lines[i]):
                if lines[i][0].isspace():  # 하위 항목(a. b. ...)은 직전 항목 안의 목록으로
                    items[-1][1].append(inline(re.sub(r'^\s+[a-z]\. ', '', lines[i])))
                else:
                    items.append([inline(re.sub(r'^(-|\d+\.) ', '', lines[i])), []])
                i += 1
            lis = ''.join(f'<li>{t}' + (f'<ol type="a">{"".join(f"<li>{s}</li>" for s in sub)}</ol>' if sub else '') + '</li>' for t, sub in items)
            html.append(f'<ol start="{start}">{lis}</ol>' if ordered else f'<ul>{lis}</ul>')
        elif ln.startswith('> '):
            html.append(f'<blockquote>{inline(ln[2:])}</blockquote>')
            i += 1
        elif not ln.strip():
            i += 1
        else:
            para = [ln]
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r'^(#|```|\||>|-|\d+\.)', lines[i]):
                para.append(lines[i]); i += 1
            html.append(f'<p>{inline(" ".join(para))}</p>')
    return '\n'.join(html)


TEMPLATE = '''<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} · 여백 미장원</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body class="legal-body">
  <!-- 이 파일은 docs/build_legal_pages.py 로 생성됩니다. 직접 고치지 말고 docs/{src} 을 수정하세요. -->
  <header class="topbar">
    <a class="brand" href="./index.html" aria-label="여백 홈"><span class="brand-mark">餘</span><span><b>여백</b><small>HAIR SALON</small></span></a>
    <a class="outline-btn" href="./index.html">홈으로</a>
  </header>
  <main class="legal-page">
    <p class="eyebrow">YEOBAEK POLICY</p>
    <h1>{title}</h1>
    <p class="legal-meta">문서 버전 {version} · 시행일 [시행일자]</p>
    <nav class="legal-tabs" aria-label="약관 및 정책">{tabs}</nav>
{body}
  </main>
</body>
</html>
'''


def build():
    for src, out, title, start in PAGES:
        lines = (ROOT / 'docs' / src).read_text(encoding='utf-8').splitlines()
        version = next((m.group(1) for l in lines[:5] if (m := re.match(r'^(\d{4}-\d{2}-\d{2})', l))), '')
        tabs = ''.join(f'<a href="./{h}"{" aria-current=page" if h == out else ""}>{t}</a>' for h, t in LINKS)
        page = TEMPLATE.format(title=title, src=src, version=version, tabs=tabs, body=to_html(public_lines(lines, start)))
        (ROOT / out).write_text(page, encoding='utf-8', newline='\n')
        print(ROOT / out)


if __name__ == '__main__':
    build()
