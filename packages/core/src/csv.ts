/**
 * CSV output (RFC 4180) that is safe to open in a spreadsheet, and a parser for CSV that people
 * upload (demand import). Shared by the API and every client; it needs no DOM or Node APIs.
 */

/** A cell that starts with one of these is read as a formula by Excel, Sheets and LibreOffice. */
const FORMULA_START = /^[\t\r]|^\s*[=+\-@]/;

/**
 * Makes text safe to show as a spreadsheet cell: a value that could be read as a formula
 * (starting with `=`, `+`, `-`, `@`, a tab or a carriage return, ignoring leading spaces) gets a
 * single quote in front, which spreadsheets show as plain text and drop from the cell.
 * (OWASP "CSV injection".)
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * One CSV field. Numbers are written as they are (they can't carry a formula); text is
 * neutralised with `neutralizeFormula`, then quoted when it holds a comma, a quote or a line
 * break, with quotes doubled.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = neutralizeFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows to a CSV document: CRLF line endings and a trailing newline, as RFC 4180 describes. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Separators `parseCsv` recognises. Spreadsheets in some locales save with `;`; tab is TSV. */
const SEPARATORS = [",", ";", "\t"] as const;
export type CsvSeparator = (typeof SEPARATORS)[number];

/**
 * The separator a CSV document most likely uses: the one that appears most often in its first
 * line (outside quotes), comma when there is a tie or none.
 */
export function detectCsvSeparator(text: string): CsvSeparator {
  const counts = new Map<string, number>(SEPARATORS.map((s) => [s, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: CsvSeparator = ",";
  for (const s of SEPARATORS) if (counts.get(s)! > counts.get(best)!) best = s;
  return best;
}

/**
 * Parses CSV text (RFC 4180) into records of fields: quoted fields may hold separators, line
 * breaks and doubled quotes; CRLF, LF and CR all end a record; a leading byte-order mark is
 * dropped. The separator is detected from the first line unless given. Records keep their
 * position, so `records[i]` is spreadsheet row `i + 1`; a blank line is a record with one empty
 * field. Lenient where spreadsheets are: a quote inside an unquoted field is kept as text.
 */
export function parseCsv(text: string, separator: CsvSeparator = detectCsvSeparator(text)): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === separator) endField();
    else if (ch === "\r" || ch === "\n") {
      endRecord();
      if (ch === "\r" && input[i + 1] === "\n") i++;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  // The last record, unless the text ended with a line break.
  if (fieldStarted || record.length > 0) endRecord();
  return records;
}
