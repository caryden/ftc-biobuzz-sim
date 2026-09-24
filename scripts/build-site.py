#!/usr/bin/env python3
"""Builds the static pages of the site from the result files and the post.
- public/lab/index.html and docs/results.html: the Match Lab, from scripts/results-page.template.html.
- public/lessons/index.html: docs/top-ten.md as HTML.
The simulator (sim/index.html) and the home page (index.html) are Vite entries. Run: python3 scripts/build-site.py"""
import html, json, os, re, statistics as st

STYLE = open('scripts/site-style.css').read()
FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">'
def nav(current):
    items = [('/', 'Home'), ('/sim/', 'Simulator'), ('/lab/', 'Match Lab'), ('/lessons/', 'Ten lessons')]
    return '<nav class="sitenav" aria-label="Site"><a class="brand" href="/">NCSSM FTC · BIOBUZZ</a>' + ''.join('<a href="%s"%s>%s</a>' % (h, ' aria-current="page"' if h == current else '', t) for h, t in items[1:]) + UNITS_SWITCH + GITHUB_LINK + '</nav>' + UNITS_SCRIPT
# The units switch. Metric is the default, the choice is kept in the browser's storage, and a page that draws charts
# listens for the `biobuzz-units` event.
# The link to the source code, as the GitHub mark, at the end of the navigation.
GITHUB_LINK = '''<a class="gh" href="https://github.com/caryden/ftc-biobuzz-sim" aria-label="Source code on GitHub" title="Source code on GitHub"><svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg></a>'''
UNITS_SWITCH = '<span class="units" role="group" aria-label="Units"><button type="button" data-setunits="metric">Metric</button><button type="button" data-setunits="us">US</button></span>'
UNITS_SCRIPT = """<script>(function(){var u='metric';try{if(localStorage.getItem('biobuzz.units')==='us')u='us'}catch(e){}
function apply(v){document.documentElement.dataset.units=v;document.querySelectorAll('[data-setunits]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.setunits===v))})}
apply(u);document.addEventListener('click',function(e){var b=e.target.closest('[data-setunits]');if(!b)return;var v=b.dataset.setunits;try{localStorage.setItem('biobuzz.units',v)}catch(e){}apply(v);dispatchEvent(new CustomEvent('biobuzz-units',{detail:v}))})})();</script>"""

# ---------- both unit systems in the post ----------
def num(v, small=1): return ('%d' % round(v)) if abs(v) >= 10 else (('%.' + str(small) + 'f') % v).rstrip('0').rstrip('.')
def both(si, us): return f'<span class="u-si">{si}</span><span class="u-us">{us}</span>'
UNIT_RE = re.compile(r'(?P<lb2>\d[\d.]*) lb \((?P<kg2>\d[\d.]*) kg(?P<base>, baseline)?\)|(?P<acc>\d[\d.]*) m/s²|(?P<spd>\d[\d.]*) m/s\b|(?P<inch>\d[\d.]*) in\.|(?P<inches>\d[\d.]*)[ -]inch(?:es)?\b|(?P<lb>\d[\d.]*) lb\b|(?P<ft>\d[\d.]*) ft\b|(?P<cm>\d[\d.]*) cm\b|(?P<kg>\d[\d.]*) kg\b|(?P<m>\d[\d.]*) m\b(?!/)|about 5 points per kilogram')
def unit_sub(m):
    g = m.groupdict(); f = lambda k: float(g[k])
    if g['lb2']: tail = ' (baseline)' if g['base'] else ''; return both(f"{g['kg2']} kg{tail}", f"{g['lb2']} lb{tail}")
    if g['acc']: return both(m.group(0), f"{num(f('acc') * 3.28084)} ft/s²")
    if g['spd']: return both(m.group(0), f"{num(f('spd') / 0.0254)} in./s")
    if g['inch']: return both(f"{num(f('inch') * 2.54)} cm", m.group(0))
    if g['inches']: return both(f"{num(f('inches') * 2.54)} cm", m.group(0))
    # A whole number of pounds in the post stands for a whole number of kilograms in the simulator: 15 lb is the 7 kg robot.
    if g['lb']: kg = f('lb') * 0.45359237; return both(f"{round(kg) if f('lb') == int(f('lb')) and kg >= 6 else num(kg)} kg", m.group(0))
    if g['ft']: return both(f"{num(f('ft') * 0.3048)} m", m.group(0))
    if g['cm']: return both(m.group(0), f"{num(f('cm') / 2.54)} in.")
    if g['kg']: return both(m.group(0), f"{num(f('kg') / 0.45359237)} lb")
    if g['m']: v = f('m'); return both(m.group(0), f"{num(v * 3.28084)} ft" if v >= 3 else f"{num(v / 0.0254)} in.")
    return both('about 5 points per kilogram', 'about 2.4 points per pound')
def dual_units(page):
    out, in_code = [], False
    for part in re.split(r'(<[^>]+>)', page):
        if part.startswith('<'): in_code = part.startswith('<code') or (in_code and not part.startswith('</code')); out.append(part)
        else: out.append(part if in_code else UNIT_RE.sub(unit_sub, part))
    return ''.join(out)

FOOT = '<footer class="sitefoot"><p>A project of the students and mentors of the NCSSM FTC teams 5064, 8569, and 22377. This site isn\'t affiliated with or endorsed by <i>FIRST</i>. <i>FIRST</i> and <i>FIRST</i> Tech Challenge are trademarks of For Inspiration and Recognition of Science and Technology.</p></footer>'

# ---------- the Match Lab ----------
rows = [json.loads(l) for l in open('experiments/results.jsonl') if '"tag":"v2"' in l]
specs = re.findall(r"^  '([a-z0-9-]+)': \{ group: '([a-z]+)', label: '([^']*)'", open('scripts/exp-specs.ts').read(), re.M)
configs = []
for cid, group, label in specs:
    v = [r for r in rows if r['id'] == cid]
    if v: configs.append({'id': cid, 'group': group, 'label': label, 'red': [r['red'] for r in v], 'blue': [r['blue'] for r in v], 'auto': round(st.mean(r['redAuto'] for r in v), 1), 'tips': round(st.mean(r['redTips'] for r in v), 1)})
loop = {}
for l in open('experiments/policy-loop.jsonl'):
    d = json.loads(l); loop[d['label']] = d
pick = lambda k: {q: loop[k].get(q) for q in ('combined', 'se', 'red', 'blue', 'margin', 'marginSe')}
# The page gets only the runs that it names, so that a run in the log isn't published until the page shows it.
template = open('scripts/results-page.template.html').read()
shown = [k for k in loop if f"'{k}'" in template]
data = {'configs': configs, 'loop': {k: pick(k) for k in shown}, 'matches': {'design': len(rows), 'loop': sum(d['n'] for d in loop.values()), 'first': 1524}}
lab = template.replace('/*DATA*/', json.dumps(data, separators=(',', ':')))
open('docs/results.html', 'w').write(lab.replace('<!--NAV-->', '').replace('<!--FOOT-->', ''))
os.makedirs('public/lab', exist_ok=True)
open('public/lab/index.html', 'w').write('<!doctype html>\n<html lang="en">\n' + lab.replace('<!--NAV-->', f'<style>{STYLE}</style>{nav("/lab/")}').replace('<!--FOOT-->', FOOT) + '\n</html>\n')

# ---------- the post ----------
def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t); t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: f'<a href="{"/lab/" if m.group(2) == "results.html" else m.group(2)}">{m.group(1)}</a>', t)
    return t
OLD_ANCHORS = {}
def slug(t): return re.sub(r'[^a-z0-9]+', '-', re.sub(r"[`*']", '', t.lower())).strip('-')
def render(md):
    # A comment `<!-- id: name -->` on the line before a heading fixes that heading's anchor, so that a link survives a
    # rename or a new ranking. GitHub doesn't show the comment. OLD_ANCHORS maps each heading's text slug to its fixed id.
    out, lines, i, fixed = [], md.split('\n'), 0, None
    while i < len(lines):
        l = lines[i]
        if not l.strip(): i += 1; continue
        c = re.match(r'<!-- id: ([a-z0-9-]+) -->$', l.strip())
        if c: fixed = c.group(1); i += 1; continue
        m = re.match(r'(#{1,3}) (.*)', l)
        if m:
            # Every section heading carries a link to itself, so that a reader can copy a link to that section.
            n, sid = len(m.group(1)), fixed or slug(m.group(2))
            if fixed and fixed != slug(m.group(2)): OLD_ANCHORS[slug(m.group(2))] = fixed
            fixed = None; link = '' if n == 1 else f' <a class="anchor" href="#{sid}" aria-label="Link to this section">#</a>'
            out.append(f'<h{n} id="{sid}">{inline(m.group(2))}{link}</h{n}>'); i += 1; continue
        if l.startswith('|'):
            tb = []
            while i < len(lines) and lines[i].startswith('|'): tb.append([c.strip() for c in lines[i].strip().strip('|').split('|')]); i += 1
            head, body = tb[0], tb[2:]
            out.append('<div class="wide"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body) + '</tbody></table></div>'); continue
        if re.match(r'- ', l):
            items = []
            while i < len(lines) and (re.match(r'- ', lines[i]) or (lines[i].startswith('  ') and lines[i].strip())):
                if lines[i].startswith('- '): items.append(lines[i][2:])
                else: items[-1] += ' ' + lines[i].strip()
                i += 1
            out.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ul>'); continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r'(#{1,3} |\||- )', lines[i]): para.append(lines[i].strip()); i += 1
        out.append(f'<p>{inline(" ".join(para))}</p>')
    return '\n'.join(out)
post = open('docs/top-ten.md').read(); title = re.match(r'# (.*)', post).group(1)
POST_STYLE = """main.post { max-width: 760px; margin-inline: auto; padding-top: 36px; } .post h1, .post h2, .post h3 { font-family: var(--display); line-height: 1.08; text-wrap: balance; margin: 0; }
.post h1 { font-size: clamp(36px, 6vw, 56px); text-transform: uppercase; margin-bottom: 18px; } .post h2 { font-size: 30px; text-transform: uppercase; margin-top: 48px; padding-top: 18px; border-top: 3px solid var(--ink); } .post h3 { font-size: 24px; font-weight: 600; margin-top: 36px; }
.post h2, .post h3 { scroll-margin-top: 16px; } .post .anchor { font-family: var(--mono); font-weight: 500; font-size: .6em; color: var(--grid); text-decoration: none; margin-left: 6px; vertical-align: middle; }
.post h2:hover .anchor, .post h3:hover .anchor, .post .anchor:focus-visible { color: var(--blue); } @media (hover: none) { .post .anchor { color: var(--dim); } }
.post p, .post ul { margin: 14px 0 0; } .post ul { padding-left: 22px; } .post li { margin-top: 6px; } .post strong { font-weight: 600; } .post code { font: 13px var(--mono); background: var(--faint); padding: 1px 5px; border-radius: 3px; }
.post .wide { overflow-x: auto; margin-top: 16px; } .post table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; } .post th, .post td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--faint); vertical-align: top; }
.post th { font: 500 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--grid); } .post td:not(:first-child), .post th:not(:first-child) { text-align: right; white-space: nowrap; }"""
os.makedirs('public/lessons', exist_ok=True)
BODY = dual_units(render(post))
# A link to a heading's old text anchor goes to the heading's fixed id.
REDIRECT = '<script>(function(){var old=' + json.dumps(OLD_ANCHORS) + ',h=location.hash.slice(1);if(old[h])location.replace("#"+old[h])})();</script>'
open('public/lessons/index.html', 'w').write(f'<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>{FONTS}<style>{STYLE}\n{POST_STYLE}</style></head>\n<body>{nav("/lessons/")}<main class="post">\n{BODY}\n</main>{REDIRECT}{FOOT}</body>\n</html>\n')
print('built docs/results.html, public/lab/index.html, public/lessons/index.html:', len(configs), 'configurations,', data['matches'])
