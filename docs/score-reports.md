# Student score reports

Class Analytics provides **Print report** and **Download PDF** alongside **Edit scores**. Reports cover the selected section and term. An active student search is included in the report heading. Each export reads the complete active roster, rather than the current 25-row table page, and fetches quiz results in authorized batches of 25 students.

The landscape A4 layout repeats the official school seal, school name, section, term, school year, teacher, generation time (UTC+08), column headings, score legend, and page numbering. Student names and long headings wrap. Lesson and quiz results continue onto additional pages as necessary. Zero scores are retained; missing values and pending grades remain explicit. Failed or canceled reads do not produce a partial report. Changing the section, term, or signed-in account cancels an in-progress export.

The original user-supplied school logo is saved unchanged as `assets/school-logo.png`. Its circular seal is clipped during document layout to exclude the screenshot controls outside the seal. The app does not regenerate the logo.

PDF and print use the same measured page layout. PDF generation runs locally in the browser. The PDF libraries and Noto Sans fonts are bundled with the site and load on demand; student data is not sent to an external document service. Library and font notices are in `assets/licenses/`.

Vendored browser distributions:

- pdf-lib 1.17.1: https://github.com/Hopding/pdf-lib
- @pdf-lib/fontkit 1.1.1: https://github.com/Hopding/fontkit (bundled with pako 1.0.11)
- Noto Sans regular/bold: https://github.com/notofonts/noto-fonts

Run `node scripts/preview-score-report.mjs` to generate synthetic PDF/print samples in `tmp/pdfs/`. No real student records are included in this preview.
