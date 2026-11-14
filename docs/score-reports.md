# Student score reports

Class Analytics provides **Print analytics** and **Download full PDF** alongside **Edit scores**, using the same blue print/download controls as Teacher Manual. **Print analytics** opens the browser print dialog directly, just like **Print Guide**. It prints the currently displayed student table page, with that page's scope clearly marked, school branding, repeated headings, and separate panels for wide lesson and quiz columns. Browser print shortcuts use the same preparation and cleanup. No PDF generation or score refetch is needed for printing.

**Download full PDF** covers the entire selected section and term. An active student search is included in the report heading. Each download reads the complete active roster, rather than the current 25-row table page, and fetches quiz results in authorized batches of 25 students.

The landscape A4 layout repeats the official school seal, school name, section, term, school year, teacher, generation time (UTC+08), column headings, score legend, and page numbering. Student names and long headings wrap. Lesson and quiz results continue onto additional pages as necessary. Zero scores are retained; missing values and pending grades remain explicit. Failed or canceled reads do not produce a partial report. Changing the section, term, or signed-in account cancels an in-progress export.

The original user-supplied school logo is saved unchanged as `assets/school-logo.png`. Its circular seal is clipped during document layout to exclude the screenshot controls outside the seal. The app does not regenerate the logo.

PDF generation runs locally in the browser. The PDF libraries and Noto Sans fonts are bundled with the site and load on demand; student data is not sent to an external document service. Library and font notices are in `assets/licenses/`.

Hovering or focusing Download full PDF prepares the public PDF tools, logo, and fonts. These resources are reused within the tab; student scores are still fetched afresh for each download. School-year lookup overlaps roster loading, quiz requests run in groups of at most three (25 students each), and PDF downloads skip print HTML. Native printing uses the displayed analytics values and skips PDF encoding.

Vendored browser distributions:

- pdf-lib 1.17.1: https://github.com/Hopding/pdf-lib
- @pdf-lib/fontkit 1.1.1: https://github.com/Hopding/fontkit (bundled with pako 1.0.11)
- Noto Sans regular/bold: https://github.com/notofonts/noto-fonts

Run `node scripts/preview-score-report.mjs` to generate synthetic PDF/print samples in `tmp/pdfs/`. No real student records are included in this preview.
