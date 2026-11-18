export const issueCsvHeaders = [
  "identifier",
  "title",
  "description",
  "status",
  "priority",
  "assignee email",
  "labels",
  "project",
  "milestone",
  "cycle",
  "due date",
  "estimate",
  "parent identifier",
  "created",
  "updated",
] as const;

export function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new Error("Unexpected text after a quoted CSV field.");
    }
    if (character === '"') {
      if (field.length || afterQuote) throw new Error("Unexpected quote in a CSV field.");
      quoted = true;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      afterQuote = false;
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      afterQuote = false;
      continue;
    }
    field += character;
  }

  if (quoted) throw new Error("A quoted CSV field was not closed.");
  if (field.length || row.length || afterQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>) {
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}
