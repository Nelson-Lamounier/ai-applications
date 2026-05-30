/** @format */
import { CleanupRegistry } from '../cleanup-registry';

describe('CleanupRegistry', () => {
  it('records and lists targets in insertion order', () => {
    const r = new CleanupRegistry();
    r.register({ flow: 'ingestion', s3Keys: [] });
    r.register({ flow: 'article-pipeline', pipelineRunId: 'p1', s3Keys: ['smoke/p1/a.md'] });
    expect(r.list().map(t => t.flow)).toEqual(['ingestion', 'article-pipeline']);
    expect(r.list()[1].pipelineRunId).toBe('p1');
  });

  it('isEmpty reflects state', () => {
    const r = new CleanupRegistry();
    expect(r.isEmpty()).toBe(true);
    r.register({ flow: 'chatbots', s3Keys: [] });
    expect(r.isEmpty()).toBe(false);
  });
});
