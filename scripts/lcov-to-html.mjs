// Convert `.coverage/lcov.info` (produced by `bun test --coverage`) into
// a static HTML report under `.coverage/html/`. Pure Node, no deps.
//
// Reads the lcov.info file, walks each `SF / DA / FNF / FNH / LF / LH`
// record, and emits:
//   - .coverage/html/index.html — summary table of every file with
//     coloured % bars for both function and line coverage
//   - .coverage/html/<flattened-path>.html — per-file source listing
//     with each line tinted green (covered), red (uncovered), or
//     plain (non-executable / not instrumented)
//
// Run after `bun test --coverage --coverage-reporter=lcov`. Wired up
// from the `test:coverage` package.json script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const lcovPath = '.coverage/lcov.info';
const outDir = '.coverage/html';

if (!existsSync(lcovPath)) {
    console.error(`Missing ${lcovPath}; run \`bun run test:coverage\` first.`);
    process.exit(1);
}

const lcov = readFileSync(lcovPath, 'utf8');

const records = [];
for (const block of lcov.split('end_of_record')) {
    if (!block.trim()) continue;
    const rec = { sf: null, lines: new Map(), fnf: 0, fnh: 0, lf: 0, lh: 0 };
    for (const line of block.split('\n')) {
        if (line.startsWith('SF:')) rec.sf = line.slice(3).trim();
        else if (line.startsWith('DA:')) {
            const [n, hits] = line.slice(3).split(',').map(Number);
            rec.lines.set(n, hits);
        } else if (line.startsWith('FNF:')) rec.fnf = Number(line.slice(4));
        else if (line.startsWith('FNH:')) rec.fnh = Number(line.slice(4));
        else if (line.startsWith('LF:')) rec.lf = Number(line.slice(3));
        else if (line.startsWith('LH:')) rec.lh = Number(line.slice(3));
    }
    if (rec.sf) records.push(rec);
}

records.sort((a, b) => a.sf.localeCompare(b.sf));

mkdirSync(outDir, { recursive: true });

const totals = records.reduce(
    (acc, r) => {
        acc.fnf += r.fnf; acc.fnh += r.fnh;
        acc.lf += r.lf; acc.lh += r.lh;
        return acc;
    },
    { fnf: 0, fnh: 0, lf: 0, lh: 0 },
);

const pct = (h, f) => (f === 0 ? 100 : (h / f) * 100);
const fmt = (h, f) => `${pct(h, f).toFixed(2)}% (${h}/${f})`;

function barCellHtml(h, f) {
    const p = pct(h, f);
    const cls = p >= 90 ? 'hi' : p >= 50 ? 'mid' : 'lo';
    return [
        '<div class="cell">',
        `  <div class="bar"><div class="bar-fill ${cls}" style="width: ${p.toFixed(2)}%"></div></div>`,
        `  <div class="num">${fmt(h, f)}</div>`,
        '</div>',
    ].join('\n');
}

function safeName(path) {
    return path.replaceAll(/[/.]/g, '_');
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

const SHARED_CSS = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2em; color: #222; }
h1 { margin-top: 0; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.5em 1em; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f5f5f5; }
tr.summary { font-weight: 600; background: #eef; }
.cell { display: flex; align-items: center; gap: 0.75em; }
.bar { height: 8px; background: #eee; border-radius: 4px; overflow: hidden; width: 200px; flex: none; }
.bar-fill { height: 100%; background: #28a745; }
.bar-fill.lo { background: #d73a49; }
.bar-fill.mid { background: #f9c513; }
.bar-fill.hi { background: #28a745; }
.num { font-variant-numeric: tabular-nums; min-width: 12em; }
`;

const indexHtml = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>kv-fs coverage</title>',
    `<style>${SHARED_CSS}</style>`,
    '</head>',
    '<body>',
    '<h1>kv-fs coverage</h1>',
    '<table>',
    '<thead><tr><th>File</th><th>% Functions</th><th>% Lines</th></tr></thead>',
    '<tbody>',
    `<tr class="summary"><td>All files</td><td>${barCellHtml(totals.fnh, totals.fnf)}</td><td>${barCellHtml(totals.lh, totals.lf)}</td></tr>`,
    ...records.map((r) => [
        '<tr>',
        `  <td><a href="${escapeHtml(safeName(r.sf))}.html">${escapeHtml(r.sf)}</a></td>`,
        `  <td>${barCellHtml(r.fnh, r.fnf)}</td>`,
        `  <td>${barCellHtml(r.lh, r.lf)}</td>`,
        '</tr>',
    ].join('\n')),
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
].join('\n');

writeFileSync(resolve(outDir, 'index.html'), indexHtml);

const FILE_CSS = `${SHARED_CSS}
.src { font-family: SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; }
.src table { width: 100%; }
.src td { padding: 0 0.5em; border: none; vertical-align: top; }
.src .ln, .src .hit { text-align: right; color: #999; user-select: none; min-width: 3em; }
.src .hit { color: #555; }
.src pre { margin: 0; }
.src tr.miss { background: #ffe5e7; }
.src tr.miss .hit { color: #b00020; }
.src tr.hit-line { background: #ecffe9; }
`;

for (const rec of records) {
    const sourcePath = resolve(rec.sf);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, 'utf8').split('\n');
    const rows = source.map((line, i) => {
        const ln = i + 1;
        const hits = rec.lines.get(ln);
        const cls = hits === undefined ? '' : hits === 0 ? 'miss' : 'hit-line';
        return [
            `<tr class="${cls}">`,
            `  <td class="ln">${ln}</td>`,
            `  <td class="hit">${hits === undefined ? '' : hits}</td>`,
            `  <td><pre>${escapeHtml(line)}</pre></td>`,
            '</tr>',
        ].join('');
    });
    const html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        `<title>${escapeHtml(rec.sf)} — coverage</title>`,
        `<style>${FILE_CSS}</style>`,
        '</head>',
        '<body>',
        '<p><a href="index.html">← back to index</a></p>',
        `<h1>${escapeHtml(rec.sf)}</h1>`,
        `<p>Functions: ${fmt(rec.fnh, rec.fnf)} · Lines: ${fmt(rec.lh, rec.lf)}</p>`,
        '<div class="src">',
        '<table>',
        ...rows,
        '</table>',
        '</div>',
        '</body>',
        '</html>',
    ].join('\n');
    writeFileSync(resolve(outDir, `${safeName(rec.sf)}.html`), html);
}

console.log(`HTML coverage report → ${outDir}/index.html`);
