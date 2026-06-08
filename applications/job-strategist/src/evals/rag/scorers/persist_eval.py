#!/usr/bin/env python3
"""Persist a Python-harness eval summary to RDS (rag_eval_runs).

Shared by deepeval_harness.py / ragas_harness.py so their runs land on the same
Grafana eval panels as the TS-native run-rag-eval, keyed by `tool`. Tool-specific
metrics (faithfulness, answer_relevancy, etc.) go into `notes` as JSON; the
primary relevance metric maps to mean_relevance_positive so the cross-tool trend
panel works.

Connects with the same RDS_* env as run-rag-eval.ts. No-op (prints a hint) unless
RAG_EVAL_PERSIST=1 is set, so harnesses can call it unconditionally.
"""
from __future__ import annotations

import json
import os


def persist_run(tool: str, query_count: int, relevance: float | None,
                metrics: dict, dataset_version: int | None = None) -> None:
    """Insert one rag_eval_runs row. Requires psycopg (v3) + RAG_EVAL_PERSIST=1."""
    if os.environ.get("RAG_EVAL_PERSIST") != "1":
        print("(set RAG_EVAL_PERSIST=1 + RDS_* env to persist this run to rag_eval_runs)")
        return
    import psycopg  # local import: only needed on the persist path

    conn_kwargs = dict(
        host=os.environ["RDS_HOST"],
        port=int(os.environ.get("RDS_PORT", "5432")),
        dbname=os.environ["RDS_DB_NAME"],
        user=os.environ["RDS_USER"],
        password=os.environ["RDS_PASSWORD"],
    )
    with psycopg.connect(**conn_kwargs) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO rag_eval_runs
              (tool, dataset_version, generate_answers, query_count,
               mean_relevance_positive, notes)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (tool, dataset_version, False, query_count, relevance, json.dumps(metrics)),
        )
        run_id = cur.fetchone()[0]
        conn.commit()
    print(f"==> persisted {tool} eval run {run_id} to rag_eval_runs")
