"use client";

import { useRef, useState } from "react";
import { Download, FileUp, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadIssueCsv, importIssueCsv, issueCsvExportUrl, previewIssueCsv, type IssueCsvImportResult, type IssueCsvPreview } from "./issue-api";

export function IssueCsvActions({ filters, onImported }: { filters: Record<string, string | undefined>; onImported: () => Promise<void> }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<IssueCsvPreview | null>(null);
  const [result, setResult] = useState<IssueCsvImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");

  async function exportCsv() {
    setExportError("");
    try {
      const blob = await downloadIssueCsv(issueCsvExportUrl(filters));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "linear-issues.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Issues could not be exported.");
    }
  }

  async function createPreview() {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setPreview(await previewIssueCsv(file));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "The CSV could not be checked.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const imported = await importIssueCsv(file);
      setResult(imported);
      await onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The CSV could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  function changeFile(selected: File | null) {
    setFile(selected);
    setPreview(null);
    setResult(null);
    setError("");
  }

  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" onClick={() => void exportCsv()}><Download />Export CSV</Button>
      <Button type="button" variant="outline" onClick={() => { setOpen(true); setError(""); }}><FileUp />Import CSV</Button>
      {exportError && <p className="basis-full text-sm text-destructive" role="alert">{exportError}</p>}
    </div>

    <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) { setError(""); setResult(null); } }}>
      <DialogContent className="max-h-[90dvh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import issues from CSV</DialogTitle>
          <DialogDescription>Choose a CSV file up to 1 MB and 500 rows. Review every row and its errors before importing.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              onChange={(event) => changeFile(event.target.files?.[0] ?? null)}
              className="max-w-md"
            />
            <Button type="button" variant="outline" disabled={!file || busy} onClick={() => void createPreview()}>
              {busy && !result ? <LoaderCircle className="animate-spin" /> : null}Preview file
            </Button>
          </div>
          {file && <p className="text-sm text-muted-foreground">Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)</p>}
          {error && <Alert variant="destructive"><AlertTitle>CSV needs attention</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {result && <Alert>
            <AlertTitle>Import finished</AlertTitle>
            <AlertDescription>Imported {result.importedCount} {result.importedCount === 1 ? "issue" : "issues"}; skipped {result.skippedCount} {result.skippedCount === 1 ? "row" : "rows"}.</AlertDescription>
          </Alert>}
          {result?.skippedRows.length ? <div className="grid gap-1 text-sm text-destructive" aria-label="Skipped row errors">
            {result.skippedRows.map(({ rowNumber, errors }) => <p key={rowNumber}>Row {rowNumber}: {errors.map(({ column, message }) => `${column}: ${message}`).join("; ")}</p>)}
          </div> : null}

          {preview && <>
            <p className="text-sm" aria-live="polite">{preview.validCount} ready to import; {preview.skippedCount} will be skipped.</p>
            {preview.warnings.length ? <Alert className="border-warning/50 bg-warning/10">
              <AlertTitle className="text-warning">Unsupported CSV columns</AlertTitle>
              <AlertDescription>{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}</AlertDescription>
            </Alert> : null}
            <div className="max-h-[48dvh] overflow-auto rounded-md border">
              <Table className="min-w-[1900px]">
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Row</TableHead>
                    {preview.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}
                    <TableHead className="min-w-72">Errors</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => <TableRow key={row.rowNumber}>
                    <TableCell>{row.rowNumber}</TableCell>
                    {preview.columns.map((column) => <TableCell key={column} className="max-w-64 truncate" title={row.values[column] ?? ""}>{row.values[column] ?? ""}</TableCell>)}
                    <TableCell className="max-w-96 whitespace-normal text-destructive">
                      {row.errors.length ? row.errors.map(({ column, message }) => <p key={`${column}:${message}`}><span className="font-medium">{column}:</span> {message}</p>) : "—"}
                    </TableCell>
                  </TableRow>)}
                  {!preview.rows.length && <TableRow><TableCell colSpan={preview.columns.length + 2} className="text-center text-muted-foreground">No data rows found.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          </>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button>
          <Button type="button" disabled={!preview || preview.validCount === 0 || busy || Boolean(result)} onClick={() => void confirmImport()}>
            {busy && result === null && preview ? <LoaderCircle className="animate-spin" /> : null}Import {preview?.validCount ?? 0} valid rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
