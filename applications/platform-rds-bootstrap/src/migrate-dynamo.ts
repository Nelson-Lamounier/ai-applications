/**
 * @format
 * DynamoDB → PostgreSQL one-shot migration.
 *
 * Migrates: articles, job_applications (kanban), resumes (portfolio CVs).
 *
 * All inserts use ON CONFLICT DO NOTHING — safe to re-run.
 * Connects directly to RDS (not PgBouncer) — same as bootstrap Job.
 *
 * Env vars:
 *   ARTICLES_TABLE         — DynamoDB articles table name
 *   STRATEGIST_TABLE       — DynamoDB strategist table (job_applications + resumes)
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD — RDS direct
 *   AWS_DEFAULT_REGION     — e.g. eu-west-1
 */
import { AttributeValue, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Pool } from 'pg';

const dynamo = new DynamoDBClient({ region: process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1' });

const pool = new Pool({
    host:     process.env['PGHOST'],
    port:     parseInt(process.env['PGPORT'] ?? '5432', 10),
    database: process.env['PGDATABASE'],
    user:     process.env['PGUSER'],
    password: process.env['PGPASSWORD'],
    ssl:      { rejectUnauthorized: false },
    max:      3,
    connectionTimeoutMillis: 10_000,
});

async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;

    do {
        const result = await dynamo.send(new ScanCommand({
            TableName: tableName,
            ExclusiveStartKey: lastKey,
        }));
        for (const raw of result.Items ?? []) {
            items.push(unmarshall(raw));
        }
        lastKey = result.LastEvaluatedKey ?? undefined;
    } while (lastKey);

    return items;
}

async function migrateArticles(): Promise<number> {
    const articlesTable = process.env['ARTICLES_TABLE'];
    if (!articlesTable) { console.warn('ARTICLES_TABLE not set — skipping articles'); return 0; }

    const items = await scanAll(articlesTable);
    const metadata = items.filter(i => i['sk'] === 'METADATA' || !i['sk']);
    let count = 0;

    for (const item of metadata) {
        const slug = (item['slug'] as string | undefined) ?? String(item['pk']).replace('ARTICLE#', '');
        if (!slug || !item['title']) continue;

        await pool.query(
            `INSERT INTO articles
                (slug, title, excerpt, content_md, tags, status, ai_generated, ai_model,
                 published_at, cover_image)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (slug) DO NOTHING`,
            [
                slug,
                item['title'] as string,
                (item['excerpt'] as string | null) ?? null,
                (item['contentMd'] as string | null) ?? (item['content'] as string | null) ?? '',
                (item['tags'] as string[] | null) ?? [],
                (item['status'] as string | null) ?? 'draft',
                (item['aiGenerated'] as boolean | null) ?? false,
                (item['aiModel'] as string | null) ?? null,
                item['publishedAt'] ? new Date(item['publishedAt'] as string) : null,
                (item['coverImage'] as string | null) ?? null,
            ],
        );
        count++;
    }

    console.log(`Articles: migrated ${count}/${metadata.length}`);
    return count;
}

async function migrateApplications(items: Record<string, unknown>[]): Promise<number> {
    const apps = items.filter(i =>
        i['entityType'] === 'APPLICATION' ||
        (!i['entityType'] && i['company'] && i['role'])
    );
    let count = 0;

    for (const item of apps) {
        const id = (item['applicationId'] as string | undefined) ?? (item['pk'] as string).replace('APPLICATION#', '');
        if (!id || !item['company'] || !item['role'] || !item['jobDescription']) continue;

        await pool.query(
            `INSERT INTO job_applications
                (id, company, role, job_url, job_description, kanban_status, applied_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO NOTHING`,
            [
                id,
                item['company'] as string,
                item['role'] as string,
                (item['jobUrl'] as string | null) ?? null,
                item['jobDescription'] as string,
                (item['status'] as string | null) ?? (item['kanbanStatus'] as string | null) ?? 'saved',
                item['appliedAt'] ? new Date(item['appliedAt'] as string) : null,
            ],
        );
        count++;
    }

    console.log(`Applications: migrated ${count}/${apps.length}`);
    return count;
}

async function migrateResumes(items: Record<string, unknown>[]): Promise<number> {
    const resumes = items.filter(i => i['entityType'] === 'RESUME');
    let count = 0;

    for (const item of resumes) {
        const id = (item['resumeId'] as string | undefined) ?? (item['pk'] as string).replace('RESUME#', '');
        if (!id || !item['data']) continue;

        const contentJson = {
            ...(item['data'] as Record<string, unknown>),
            label:     item['label'] ?? '',
            is_active: item['isActive'] ?? false,
        };

        await pool.query(
            `INSERT INTO resumes (id, content_json)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [id, JSON.stringify(contentJson)],
        );
        count++;
    }

    console.log(`Resumes: migrated ${count}/${resumes.length}`);
    return count;
}

async function main(): Promise<void> {
    console.log('DynamoDB → PostgreSQL migration starting...');
    await migrateArticles();

    const strategistTable = process.env['STRATEGIST_TABLE'];
    if (!strategistTable) {
        console.warn('STRATEGIST_TABLE not set — skipping applications and resumes');
    } else {
        const strategistItems = await scanAll(strategistTable);
        await migrateApplications(strategistItems);
        await migrateResumes(strategistItems);
    }

    console.log('Migration complete.');
}

main()
    .catch((err) => { console.error('Migration failed:', err); })
    .finally(() => pool.end())
    .catch(() => process.exit(1));
