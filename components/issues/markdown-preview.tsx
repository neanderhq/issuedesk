import React from "react";

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return <>{parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="underline underline-offset-2">{link[1]}</a>;
    return <span key={i}>{part}</span>;
  })}</>;
}

export function MarkdownPreview({ value }: { value: string }) {
  const blocks = value.split(/\n\s*\n/).filter(Boolean);
  return <div className="grid min-w-0 gap-3 break-words text-sm leading-6 [overflow-wrap:anywhere]">{blocks.map((block, index) => {
    const lines = block.split("\n");
    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (heading) return <h3 key={index} className="font-semibold">{heading[2]}</h3>;
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={index} className="list-disc pl-5">{lines.map((line, i) => <li key={i}><InlineMarkdown text={line.replace(/^\s*[-*]\s+/, "")} /></li>)}</ul>;
    return <p key={index} className="whitespace-pre-wrap"><InlineMarkdown text={block} /></p>;
  })}</div>;
}

