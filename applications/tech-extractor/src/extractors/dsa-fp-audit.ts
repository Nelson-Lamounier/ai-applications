/** @format */
// Usage: node dist/extractors/dsa-fp-audit.js <repoDir> [<repoDir> ...]
// Prints: repo,file:line,signal,raw_name,confidence  + a TOTAL line.
// MERGE GATE (manual): run over >=5 real repos, hand-inspect every match, require FP <= 5%.
import { promises as fs } from 'fs';
import * as path from 'path';
import { detectDsaPatterns, dsaLangForExt } from './DsaPatternExtractor.js';

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

async function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) { console.error('pass >=1 repo dir'); process.exit(1); }
  let total = 0;
  console.log('repo,location,signal,raw_name,confidence');
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      if (!dsaLangForExt(path.extname(file))) continue;
      const lang = dsaLangForExt(path.extname(file))!;
      const src = await fs.readFile(file, 'utf-8').catch(() => '');
      for (const m of detectDsaPatterns(src, lang, path.relative(dir, file))) {
        total++;
        console.log(`${path.basename(dir)},${m.file_path}:${m.line_start},${m.signal},${m.raw_name},${m.confidence}`);
      }
    }
  }
  console.error(`TOTAL matches: ${total}`);
}
void main();
