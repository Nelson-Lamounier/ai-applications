/** @format */
import { parse as parseToml } from 'smol-toml';

/** One ecosystem's manifest handling: how to recognise the file, parse direct
 *  dependency names from it, and normalise a name for comparison against syft's
 *  raw_name. `syftEcosystems` are the syft artifact `type` strings this covers. */
export interface ParserSpec {
    readonly id: string;
    readonly syftEcosystems: string[];
    matches(path: string): boolean;
    parse(content: string): string[];
    normalise(name: string): string;
}

const basename = (p: string): string => p.split('/').pop() ?? p;

/** Default normalisation: lowercase + trim. npm/go/rust/ruby/php names compare
 *  as-is (lowercased); go module paths are case-sensitive but lowercase is safe
 *  for the registry hosts we see and avoids false misses. */
export function normaliseDefault(name: string): string {
    return name.trim().toLowerCase();
}

/** PEP 503 normalisation: lowercase, collapse runs of -, _ or . to a single -. */
export function normalisePython(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Safe JSON parse returning {} on error (fail-open: empty deps -> no narrowing). */
function safeJson(content: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(content);
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

const npm: ParserSpec = {
    id: 'npm',
    syftEcosystems: ['npm'],
    matches: (p) => basename(p) === 'package.json',
    parse: (content) => {
        const j = safeJson(content);
        const maps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const names = new Set<string>();
        for (const m of maps) {
            const map = j[m];
            if (map && typeof map === 'object') for (const k of Object.keys(map)) names.add(k);
        }
        return [...names];
    },
    normalise: normaliseDefault,
};

const go: ParserSpec = {
    id: 'go',
    syftEcosystems: ['go-module'],
    matches: (p) => basename(p) === 'go.mod',
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (line.includes('// indirect')) continue;
            // `require path version` or, inside a require(...) block, `path version`
            const m = line.match(/^(?:require\s+)?([a-z0-9.\-/]+\.[a-z0-9.\-/]+)\s+v\d/i);
            if (m) names.push(m[1]);
        }
        return names;
    },
    normalise: normaliseDefault,
};

const php: ParserSpec = {
    id: 'php',
    syftEcosystems: ['php-composer'],
    matches: (p) => basename(p) === 'composer.json',
    parse: (content) => {
        const j = safeJson(content);
        const names = new Set<string>();
        for (const m of ['require', 'require-dev']) {
            const map = j[m];
            if (map && typeof map === 'object') {
                for (const k of Object.keys(map)) {
                    if (k === 'php' || k.startsWith('ext-') || k.startsWith('lib-')) continue;
                    names.add(k);
                }
            }
        }
        return [...names];
    },
    normalise: normaliseDefault,
};

const ruby: ParserSpec = {
    id: 'ruby',
    syftEcosystems: ['gem'],
    matches: (p) => basename(p) === 'Gemfile',
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('#')) continue;
            const m = line.match(/^gem\s+['"]([^'"]+)['"]/);
            if (m) names.push(m[1]);
        }
        return names;
    },
    normalise: normaliseDefault,
};

const pythonRequirements: ParserSpec = {
    id: 'python-requirements',
    syftEcosystems: ['python'],
    matches: (p) => /(^|\/)requirements[\w.-]*\.txt$/.test(p),
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith('-')) continue;
            // strip extras [..], version specifiers, and env markers (; ...)
            const m = line.split(';')[0].match(/^([A-Za-z0-9._-]+)/);
            if (m) names.push(normalisePython(m[1]));
        }
        return names;
    },
    normalise: normalisePython,
};

/** Safe TOML parse returning {} on error (fail-open). */
function safeToml(content: string): Record<string, unknown> {
    try {
        return parseToml(content) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** First identifier of a PEP 508 requirement string ("Django>=4.2" -> "Django"). */
function pep508Name(req: string): string | null {
    const m = req.trim().match(/^([A-Za-z0-9._-]+)/);
    return m ? m[1] : null;
}

/** Add PEP 508 dep-array entries into `out`, normalised. */
function addPep508Array(arr: unknown, out: Set<string>): void {
    if (!Array.isArray(arr)) return;
    for (const d of arr) {
        if (typeof d === 'string') { const n = pep508Name(d); if (n) out.add(normalisePython(n)); }
    }
}

/** Add PEP 621 [project] deps (direct + optional groups) into `out`. */
function addPep621(project: Record<string, unknown> | undefined, out: Set<string>): void {
    if (!project) return;
    addPep508Array(project['dependencies'], out);
    const optional = project['optional-dependencies'];
    if (optional && typeof optional === 'object') {
        for (const group of Object.values(optional as Record<string, unknown>)) addPep508Array(group, out);
    }
}

/** Add [tool.poetry.dependencies] keys (excluding the python version pin) into `out`. */
function addPoetryDeps(tool: Record<string, unknown> | undefined, out: Set<string>): void {
    const poetry = tool?.['poetry'] as Record<string, unknown> | undefined;
    const deps = poetry?.['dependencies'] as Record<string, unknown> | undefined;
    if (!deps || typeof deps !== 'object') return;
    for (const k of Object.keys(deps)) if (k.toLowerCase() !== 'python') out.add(normalisePython(k));
}

const pythonPyproject: ParserSpec = {
    id: 'python-pyproject',
    syftEcosystems: ['python'],
    matches: (p) => basename(p) === 'pyproject.toml',
    parse: (content) => {
        const t = safeToml(content);
        const names = new Set<string>();
        addPep621(t['project'] as Record<string, unknown> | undefined, names);
        addPoetryDeps(t['tool'] as Record<string, unknown> | undefined, names);
        return [...names];
    },
    normalise: normalisePython,
};

const rust: ParserSpec = {
    id: 'rust',
    syftEcosystems: ['rust-crate'],
    matches: (p) => basename(p) === 'Cargo.toml',
    parse: (content) => {
        const t = safeToml(content);
        const names = new Set<string>();
        for (const table of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
            const map = t[table];
            if (map && typeof map === 'object') for (const k of Object.keys(map)) names.add(k);
        }
        return [...names];
    },
    normalise: normaliseDefault,
};

/** Registry. Task 2 appends python-pyproject + rust. */
export const PARSER_SPECS: ParserSpec[] = [npm, go, php, ruby, pythonRequirements, pythonPyproject, rust];
