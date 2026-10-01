from pathlib import Path
import re

root = Path(__file__).parent
css_dir = root / "css"
js_dir = root / "js"
css_dir.mkdir(exist_ok=True)
js_dir.mkdir(exist_ok=True)

HEAD_INJECT = """  <script src="https://cdn.tailwindcss.com"></script>
  <script src="js/tailwind.config.js"></script>
  <link rel="stylesheet" href="css/app.css" />
"""

COLOR_REPLACEMENTS = [
    ("linear-gradient(180deg, #8b5cf6 0%, #c026d3 100%)", "linear-gradient(180deg, #81A2C1 0%, #A4B8D9 100%)"),
    ("linear-gradient(180deg, #8b5cf6, #7c3aed)", "#FEB705"),
    ("linear-gradient(180deg, #7c3aed, #6d28d9)", "#FEB705"),
    ("linear-gradient(90deg, #7c3aed 0%, #d946ef 52%, #f472b6 100%)", "linear-gradient(90deg, #81A2C1 0%, #A4B8D9 52%, #BFC8E2 100%)"),
    ("rgba(124, 58, 237, 0.28)", "rgba(254, 183, 5, 0.35)"),
    ("rgba(124, 58, 237, 0.12)", "rgba(129, 162, 193, 0.28)"),
    ("rgba(109, 40, 217, 0.28)", "rgba(254, 183, 5, 0.35)"),
    ("#f3f2f8", "#E2E3E7"),
    ("#7c3aed", "#81A2C1"),
    ("#6d28d9", "#81A2C1"),
    ("#8b5cf6", "#A4B8D9"),
    ("#c026d3", "#81A2C1"),
    ("#efe8ff", "#BFC8E2"),
    ("#f3e8ff", "#BFC8E2"),
    ("#eadcff", "#A4B8D9"),
    ("#d8b4fe", "#A4B8D9"),
    ("#faf5ff", "#E2E3E7"),
    ("#ec4899", "#81A2C1"),
    ("#e11d74", "#81A2C1"),
    ("#db2777", "#81A2C1"),
    ("#fce7f3", "#BFC8E2"),
    ("#fdf2f8", "#E2E3E7"),
    ("#f9a8d4", "#A4B8D9"),
    ("#f6f5fb", "#E2E3E7"),
    ("#f4f3fa", "#E2E3E7"),
    ("#c4b5fd", "#81A2C1"),
]


def recolor(text: str) -> str:
    for old, new in COLOR_REPLACEMENTS:
        text = text.replace(old, new)
        text = text.replace(old.upper(), new)
    return text


SHARED_UI_RE = re.compile(
    r"""
    \s*const\s+drawer\s*=\s*document\.getElementById\("drawer"\);[\s\S]*?
    document\.getElementById\("helpBtn"\)\.onclick\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};
    """,
    re.VERBOSE,
)

css_chunks = []
html_files = sorted(root.glob("*.html"))

for html_path in html_files:
    raw = html_path.read_text(encoding="utf-8")
    stem = html_path.stem

    styles = re.findall(r"<style>([\s\S]*?)</style>", raw)
    for i, style in enumerate(styles):
        css_chunks.append(f"/* ===== {html_path.name} ===== */\n{style.strip()}\n")

    scripts = list(re.finditer(r"<script([^>]*)>([\s\S]*?)</script>", raw))
    page_js = None
    is_module = False
    for m in scripts:
        attrs, body = m.group(1), m.group(2).strip()
        if "src=" in attrs:
            continue
        if not body:
            continue
        page_js = body
        is_module = "type=\"module\"" in attrs
        break

    if page_js and stem != "login":
        cleaned = SHARED_UI_RE.sub("\n", page_js).strip()
        # index keeps drawer code because help/drawer mixed with firebase
        if stem == "index":
            cleaned = page_js.strip()
        js_name = {
            "index": "dashboard.js",
            "topic-scheduler": "topic-scheduler.js",
            "analytics": "analytics.js",
            "student-records": "student-records.js",
            "batch-upload": "batch-upload.js",
            "offline-sync": "offline-sync.js",
            "scan-qr-ar": "scan-qr-ar.js",
            "teacher-manual": "teacher-manual.js",
        }[stem]
        (js_dir / js_name).write_text(cleaned + "\n", encoding="utf-8")

    html = re.sub(r"\s*<style>[\s\S]*?</style>", "", raw, count=1)
    html = re.sub(
        r"\s*<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?</script>",
        "",
        html,
        count=1,
    )
    html = recolor(html)

    html = html.replace(
        '  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />\n',
        '  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />\n'
        + HEAD_INJECT,
    )

    if stem == "login":
        html_path.write_text(html, encoding="utf-8")
        continue

    script_tags = ['  <script src="js/ui.js"></script>']
    if stem == "index":
        script_tags = ['  <script type="module" src="js/dashboard.js"></script>']
    else:
        js_name = {
            "topic-scheduler": "topic-scheduler.js",
            "analytics": "analytics.js",
            "student-records": "student-records.js",
            "batch-upload": "batch-upload.js",
            "offline-sync": "offline-sync.js",
            "scan-qr-ar": "scan-qr-ar.js",
            "teacher-manual": "teacher-manual.js",
        }[stem]
        script_tags.append(f'  <script src="js/{js_name}"></script>')

    html = html.replace("</body>", "\n".join(script_tags) + "\n</body>")
    html_path.write_text(html, encoding="utf-8")
    print("updated", html_path.name)

merged = recolor("\n".join(css_chunks))
overrides = """
/* ===== Palette overrides ===== */
.scan-btn,
.primary-btn,
.login-btn,
.btn-purple,
.cam-btn,
.nav-item.active,
.tabs button.active {
  background: #FEB705 !important;
  color: #1e293b !important;
  box-shadow: 0 8px 18px rgba(254, 183, 5, 0.32);
}
.nav-item.active:hover,
.scan-btn:hover,
.primary-btn:hover,
.login-btn:hover,
.btn-purple:hover,
.cam-btn:hover {
  background: #e5a404 !important;
  color: #1e293b !important;
  filter: none;
}
.brand-mark {
  background: linear-gradient(180deg, #81A2C1 0%, #A4B8D9 100%) !important;
}
.sy-chip {
  background: #BFC8E2 !important;
  color: #3d5570 !important;
}
.ghost-btn {
  background: #BFC8E2 !important;
  color: #3d5570 !important;
}
.avatar,
.user-avatar {
  background: #81A2C1 !important;
}
.bell .dot {
  background: #FEB705 !important;
}
"""
(css_dir / "app.css").write_text(merged + "\n" + overrides, encoding="utf-8")
print("wrote css/app.css")
