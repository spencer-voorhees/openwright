"""DOM-walking HTML -> XLSX exporter.

Opens a spreadsheet artifact in headless chromium and turns each
<table class="sheet"> into a real, editable worksheet via openpyxl:
header rows are bold + shaded, numeric cells (class="num") are written
as real numbers so Excel can sum them, total rows are bold, and the
column widths fit the content.

Usage:
    python3 export_xlsx.py --url http://host/preview/.../sheet-v1.html \\
                            --out  /path/to/sheet.xlsx

The HTML grid is the source of truth — the page's own structure and
classes (.sheet, .sheet-name, .num, .total) drive the workbook, the
same way the DOCX exporter walks the .doc-page.
"""
from __future__ import annotations
import argparse
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Walk the rendered page into a list of sheets:
#   { sheets: [ { name, headers:[{text,num}], rows:[{total,cells:[{text,num}]}] } ] }
DOM_WALK_JS = r"""
(() => {
  const pick = document.querySelectorAll('table.sheet');
  const tables = pick.length ? pick : document.querySelectorAll('table');
  const cellNum = (c) => c.classList.contains('num')
      || c.getAttribute('data-type') === 'number'
      || (c.querySelector && c.querySelector('.num'));
  const txt = (c) => (c.textContent || '').replace(/\s+/g, ' ').trim();

  const sheets = [];
  let n = 0;
  for (const t of tables) {
    n++;
    let name = '';
    const wrap = t.closest('.sheet-wrap');
    if (wrap) { const nm = wrap.querySelector('.sheet-name'); if (nm) name = txt(nm); }
    if (!name) { const cap = t.querySelector('caption'); if (cap) name = txt(cap); }
    if (!name) name = 'Sheet ' + n;

    const headRow = t.querySelector('thead tr');
    const headers = headRow
      ? Array.from(headRow.querySelectorAll('th,td')).map(c => ({ text: txt(c), num: !!cellNum(c) }))
      : [];

    const bodyRows = Array.from(t.querySelectorAll('tbody tr')).map(tr => ({
      total: tr.classList.contains('total') || tr.classList.contains('subtotal'),
      cells: Array.from(tr.querySelectorAll('td,th')).map(c => ({ text: txt(c), num: !!cellNum(c) })),
    })).filter(r => r.cells.length);

    // A table with no <tbody> — treat all rows after the first as data.
    if (!bodyRows.length) {
      const rows = Array.from(t.querySelectorAll('tr'));
      const start = headRow ? 1 : 0;
      for (let i = start; i < rows.length; i++) {
        bodyRows.push({
          total: rows[i].classList.contains('total'),
          cells: Array.from(rows[i].querySelectorAll('td,th')).map(c => ({ text: txt(c), num: !!cellNum(c) })),
        });
      }
    }
    sheets.push({ name, headers, rows: bodyRows });
  }
  return { sheets };
})()
"""

HEADER_FILL = PatternFill("solid", fgColor="F5F5F7")
TOTAL_FILL = PatternFill("solid", fgColor="F5F9FE")
INK = "1D1D1F"
MUTED = "6E6E73"
THIN = Side(style="thin", color="E3E4E8")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def parse_number(s: str):
    """Turn a cell's text into a number when it clearly is one, else None.
    Tolerates currency, thousands separators, %, and parentheses-negatives."""
    if s is None:
        return None
    t = s.strip()
    if not t:
        return None
    neg = t.startswith("(") and t.endswith(")")
    cleaned = re.sub(r"[,$€£¥%\s()]", "", t)
    if not re.fullmatch(r"-?\d*\.?\d+", cleaned):
        return None
    try:
        val = float(cleaned)
    except ValueError:
        return None
    if neg:
        val = -val
    pct = t.endswith("%")
    if pct:
        # keep the human number (e.g. 61 for "61%"), Excel users expect
        # the figure they see; a real percent format is a v2 refinement.
        pass
    if val == int(val):
        return int(val)
    return round(val, 6)


def cell_number(text: str):
    """Numeric value for a cell by CONTENT, or None to keep it text.

    Detecting numbers by class alone meant any number the agent forgot to
    tag landed as text — which makes Excel flag "number stored as text".
    So parse by content, but keep true codes/IDs as text:
      - zero-padded values (0007, 01) — leading zeros are meaningful
      - very long digit runs (>15) — account/card numbers Excel mangles
    """
    n = parse_number(text)
    if n is None:
        return None
    core = re.sub(r"[,$€£¥%()\s]", "", (text or "").strip())
    if re.match(r"-?0\d", core):
        return None
    if len(re.sub(r"\D", "", core)) > 15:
        return None
    return n


# Cells that are genuinely "no value" — they don't make a numeric column
# text, and they stay text themselves (Excel doesn't flag non-numbers).
SENTINELS = {"", "-", "–", "—", ".", "n/a", "na", "tbd", "tbc", "—", "null"}


def numeric_columns(rows: list) -> set:
    """Decide column type once, for the whole column — a column is numeric
    only if every real value in it is a number. So a code column with one
    zero-padded ID stays text top to bottom instead of going half-and-half.
    """
    seen, broken = {}, set()
    for row in rows:
        for ci, c in enumerate(row.get("cells") or [], 1):
            t = (c.get("text") or "").strip()
            if t.lower() in SENTINELS:
                continue
            if cell_number(t) is not None:
                seen[ci] = seen.get(ci, 0) + 1
            else:
                broken.add(ci)            # a non-number lives here → text column
    return {ci for ci, n in seen.items() if n and ci not in broken}


def sanitize_title(name: str, used: set) -> str:
    # Excel sheet titles: <=31 chars, no []:*?/\
    t = re.sub(r"[\[\]:\*\?/\\]", " ", name or "Sheet").strip()[:31] or "Sheet"
    base, i = t, 2
    while t.lower() in used:
        suffix = f" {i}"
        t = (base[:31 - len(suffix)] + suffix)
        i += 1
    used.add(t.lower())
    return t


def build(data: dict, out_path: str):
    sheets = data.get("sheets", [])
    wb = Workbook()
    wb.remove(wb.active)
    used = set()

    for s in sheets:
        ws = wb.create_sheet(title=sanitize_title(s.get("name"), used))
        widths = {}
        r = 1
        num_cols = numeric_columns(s.get("rows") or [])

        headers = s.get("headers") or []
        if headers:
            for ci, h in enumerate(headers, 1):
                cell = ws.cell(row=r, column=ci, value=h.get("text", ""))
                cell.font = Font(bold=True, color=MUTED, size=10)
                cell.fill = HEADER_FILL
                cell.alignment = Alignment(horizontal="right" if h.get("num") else "left", vertical="center")
                cell.border = BORDER
                widths[ci] = max(widths.get(ci, 0), len(str(h.get("text", ""))))
            ws.freeze_panes = f"A{r + 1}"
            r += 1

        for row in s.get("rows") or []:
            is_total = bool(row.get("total"))
            for ci, c in enumerate(row.get("cells") or [], 1):
                text = c.get("text", "")
                # Only columns the whole-column scan deemed numeric write
                # numbers; a sentinel ("N/A") in a numeric column stays text.
                num = cell_number(text) if ci in num_cols else None
                value = num if num is not None else text
                cell = ws.cell(row=r, column=ci, value=value)
                cell.font = Font(bold=is_total or ci == 1, color=INK, size=11)
                cell.border = BORDER
                cell.alignment = Alignment(
                    horizontal="right" if num is not None else "left", vertical="center")
                if is_total:
                    cell.fill = TOTAL_FILL
                widths[ci] = max(widths.get(ci, 0), len(str(text)))
            r += 1

        for ci, w in widths.items():
            ws.column_dimensions[get_column_letter(ci)].width = min(60, max(10, w + 3))

    if not wb.sheetnames:
        wb.create_sheet(title="Sheet 1")
    wb.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=int, default=30000)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(args.url, wait_until="networkidle", timeout=args.timeout)
        page.wait_for_timeout(300)
        data = page.evaluate(DOM_WALK_JS)
        browser.close()

    if not data or not data.get("sheets"):
        print("no <table class=\"sheet\"> content found", file=sys.stderr)
        sys.exit(2)

    build(data, args.out)
    print(json.dumps({"ok": True, "sheets": len(data["sheets"]), "out": args.out}))


if __name__ == "__main__":
    main()
