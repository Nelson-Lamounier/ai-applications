/** @format */

/**
 * loadPypiTop.ts — refresh-time generator for `pypi-top-5k.json`.
 *
 * This module is NOT on the runtime hot path. It is run manually (or from CI)
 * to regenerate the committed `pypi-top-5k.json` seed list. At runtime the
 * `PypiBigQuerySource` reads the committed JSON; it never touches BigQuery.
 *
 * Auth: the BigQuery client uses Application Default Credentials. Provide
 * credentials via one of:
 *   - `GOOGLE_APPLICATION_CREDENTIALS` — path to a service-account key file, OR
 *   - `GCP_SA_JSON` — the service-account key JSON inline (written to a temp
 *     file by this loader before constructing the client).
 *
 * Run:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *     yarn workspace @bedrock/ontology-importer ts-node src/sources/data/loadPypiTop.ts
 *   # or, after build:
 *   node dist/sources/data/loadPypiTop.js
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BigQuery } from '@google-cloud/bigquery';

/**
 * Top `limit` PyPI projects by 30-day download count, from the public
 * `bigquery-public-data.pypi.file_downloads` dataset. Returns lowercased
 * project names.
 *
 * NOTE: this query scans a large public table — it bills the *querying*
 * project. Keep `limit` reasonable and run sparingly.
 */
export async function loadPypiTopPackages(limit = 5000): Promise<string[]> {
    // If credentials are supplied inline, materialise them to a temp file so the
    // BigQuery client (which reads GOOGLE_APPLICATION_CREDENTIALS) can pick them up.
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_SA_JSON) {
        const dir = mkdtempSync(path.join(tmpdir(), 'gcp-sa-'));
        const keyPath = path.join(dir, 'sa.json');
        writeFileSync(keyPath, process.env.GCP_SA_JSON, 'utf-8');
        process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    }

    const bq = new BigQuery();

    // Top projects by download count over the trailing 30 days.
    const sql = /* sql */ `
        SELECT
          LOWER(file.project) AS project,
          COUNT(*)            AS downloads
        FROM \`bigquery-public-data.pypi.file_downloads\`
        WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
        GROUP BY project
        ORDER BY downloads DESC
        LIMIT @limit
    `;

    const [rows] = await bq.query({ query: sql, params: { limit } });
    return (rows as { project: string }[])
        .map((r) => r.project)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

async function main(): Promise<void> {
    const limit = Number(process.env.PYPI_TOP_LIMIT ?? 5000);
    const packages = await loadPypiTopPackages(limit);
    const out = path.join(__dirname, 'pypi-top-5k.json');
    writeFileSync(out, `${JSON.stringify(packages, null, 2)}\n`, 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`Wrote ${packages.length} packages to ${out}`);
}

if (require.main === module) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
    });
}
