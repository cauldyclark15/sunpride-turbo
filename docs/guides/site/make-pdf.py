#!/usr/bin/env python3
"""Guide .md -> .html -> .pdf (headless Chrome, A4), the style of the first guides:
Helvetica Neue, ruled title, grey section bands, continuous step numbers.
Images: a line of only ![caption](img/x.png "phone"|"web"|"small") makes a row of figures;
![caption](img/x.png "right") floats one phone shot beside the steps. Lines starting ">" make a boxed note.
Usage: python3 make-pdf.py            (every md/*.md)
       python3 make-pdf.py md/x.md     (one guide)
Each md/<name>.md becomes apps/web/public/docs/sunpride-<name>.pdf (a stable link: never rename a published file)."""
import html, re, struct, subprocess, sys
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CSS = """
@page { size: A4; margin: 13mm 14mm; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.38; color: #111; }
h1 { font-size: 19pt; margin: 0 0 6px; padding: 6px 0; border-top: 2px solid #111; border-bottom: 2px solid #111; }
h2 { font-size: 13pt; background: #ececec; padding: 4px 6px; margin: 14px 0 6px; }
ol { margin: 0; padding-left: 26px; } ol li { margin: 2px 0; }
ul { margin: 2px 0; padding-left: 18px; }
p { margin: 4px 0; } em { font-style: italic; }
h2 { clear: both; }
.figs { display: flex; gap: 8px; align-items: flex-start; justify-content: center; margin: 4px 0 8px 0; break-inside: avoid; }
.figs figure, .float { margin: 0; text-align: center; font-size: 8.5pt; color: #444; flex: none; }
.figs img, .float img { border: 1px solid #bbb; border-radius: 4px; display: block; margin: 0 auto 2px; }
h2 { break-after: avoid; }
.float { float: right; width: 36mm; margin: 0 0 6px 10px; } .float img { width: 36mm; }
.box { clear: both; border: 2px solid #111; border-radius: 6px; padding: 6px 10px; margin: 12px 0 0; break-inside: avoid; }
.box p { margin: 3px 0; }
.lead { color: #333; }
"""

IMG = re.compile(r'!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)')


HEIGHT_MM = {"phone": 66, "web": 60, "strip": 26, "tall": 80, "small": 18}
ROW_MM = 170  # usable width of a figure row


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[16:24]
    return struct.unpack(">II", head)


def figures(line: str, base: Path) -> str | None:
    """A line made only of images. kind "right" floats one phone shot beside the steps; otherwise a
    centred row: each image gets its kind's height ("wide" = full row width), scaled down to fit."""
    imgs = IMG.findall(line)
    if not imgs or IMG.sub("", line).strip():
        return None
    if len(imgs) == 1 and imgs[0][2] == "right":
        cap, src, _ = imgs[0]
        return f'<div class="float"><img src="{src}"><div>{inline(cap)}</div></div>'
    sizes = []
    for cap, src, kind in imgs:
        w, h = png_size(base / src)
        if kind == "wide":
            sizes.append((150.0, 150.0 * h / w))
        else:
            hh = HEIGHT_MM.get(kind or "web", 46)
            sizes.append((hh * w / h, float(hh)))
    total = sum(w for w, _ in sizes) + 3 * (len(sizes) - 1)
    k = min(1.0, ROW_MM / total)
    cells = "".join(
        f'<figure style="width:{w * k:.1f}mm"><img src="{src}" style="width:{w * k:.1f}mm;height:{h * k:.1f}mm">'
        f"<figcaption>{inline(cap)}</figcaption></figure>"
        for (cap, src, _), (w, h) in zip(imgs, sizes))
    return f'<div class="figs">{cells}</div>'


def inline(t: str) -> str:
    t = html.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<em>\1</em>", t)


def convert(md: str, base: Path) -> str:
    out, in_ol, in_ul = [], False, False

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    def close_ol():
        nonlocal in_ol
        close_ul()
        if in_ol:
            out.append("</li></ol>")
            in_ol = False

    box = []
    for line in md.splitlines():
        if line.startswith(">"):
            close_ol()
            box.append(f"<p>{inline(line.lstrip('> ').rstrip())}</p>" if line.strip(">  ") else "")
            continue
        if box:
            out.append(f'<div class="box">{"".join(box)}</div>')
            box = []
        if (fig := figures(line.strip(), base)) is not None:
            out.append(fig)  # inside an open step it stays with that step
            continue
        if m := re.match(r"^(\d+)\. (.*)", line):
            close_ul()
            if in_ol:
                out.append("</li>")
            else:
                out.append(f'<ol start="{m.group(1)}">')
                in_ol = True
            out.append(f"<li>{inline(m.group(2))}")
        elif m := re.match(r"^\s+- (.*)", line):
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{inline(m.group(1))}</li>")
        elif line.startswith("# "):
            close_ol()
            out.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("## "):
            close_ol()
            out.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.strip():
            close_ol()
            out.append(f"<p>{inline(line.strip())}</p>")
    close_ol()
    if box:
        out.append(f'<div class="box">{"".join(box)}</div>')
    return "\n".join(out)


HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "apps" / "web" / "public" / "docs"
OUT.mkdir(parents=True, exist_ok=True)
names = sys.argv[1:] or sorted(str(p) for p in (HERE / "md").glob("*.md"))
for name in names:
    src = Path(name).resolve()
    pdf = OUT / f"sunpride-{src.stem}.pdf"
    page = src.with_suffix(".html")
    page.write_text(
        f'<!doctype html><html><head><meta charset="utf-8"><title>{page.name}</title>'
        f"<style>{CSS}</style></head><body>{convert(src.read_text(), src.parent)}</body></html>"
    )
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
         "--allow-file-access-from-files", f"--print-to-pdf={pdf}", page.as_uri()],
        check=True, capture_output=True,
    )
    page.unlink()
    print(pdf)
