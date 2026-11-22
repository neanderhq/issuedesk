import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownPreview } from '../components/issues/markdown-preview';

for (const value of [
  '<img src=x onerror=alert(1)>',
  '# <script>alert(1)</script>',
  '**<svg onload=alert(1)>**',
  '[click](javascript:alert(1))',
  '[broken](https://?)',
  '[quote](https://example.test/"onclick=alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD4=)',
  '- <img src=x onerror=alert(1)>',
]) {
  const html = renderToStaticMarkup(<MarkdownPreview value={value}/>);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b|href="(?:javascript|data):/i);
}
const valid = renderToStaticMarkup(<MarkdownPreview value="[Documentation](https://example.test/docs)"/>);
assert.match(valid, /href="https:\/\/example.test\/docs"/);
assert.match(valid, /rel="noreferrer"/);
console.log('Markdown treats HTML as text and only creates HTTP(S) links');
