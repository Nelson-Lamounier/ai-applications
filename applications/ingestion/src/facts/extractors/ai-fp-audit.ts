/** @format */
// Usage: node dist/extractors/ai-fp-audit.js <repoDir> [<repoDir> ...]
// Prints: repo,location,signal,raw_name,confidence  + a TOTAL line.
// MERGE GATE (manual): run over >=5 real repos, hand-inspect every match, require FP <= 5%.
// If exceeded, drop the weakest signal first — grounding or cost (both confidence 0.70).
import { promises as fs } from 'fs';
import * as path from 'path';
import { detectAiPatterns, aiLangForExt } from './AiPatternExtractor.js';

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
      const ext = path.extname(file);
      const lang = aiLangForExt(ext);
      if (!lang && ext !== '.json') continue;
      const src = await fs.readFile(file, 'utf-8').catch(() => '');
      for (const m of detectAiPatterns(src, lang, path.relative(dir, file))) {
        total++;
        console.log(`${path.basename(dir)},${m.file_path}:${m.line_start},${m.signal},${m.raw_name},${m.confidence}`);
      }
    }
  }
  console.error(`TOTAL matches: ${total}`);
}
void main();
