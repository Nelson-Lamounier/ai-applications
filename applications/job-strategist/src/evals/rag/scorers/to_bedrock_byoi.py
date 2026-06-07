#!/usr/bin/env python3
"""Convert the RAG eval JSONL to a Bedrock Evaluations BYOI dataset + create a job.

Track 2 (periodic deeper audit). Bedrock RAG Evaluation in "bring your own
inference responses" mode scores YOUR retrieved contexts + generated answers —
no managed Knowledge Base required, which is exactly our RDS-pgvector + custom
ConverseCommand setup.

This converts run-rag-eval.ts output into Bedrock's conversationTurns dataset
format. With `answer` present (RAG_EVAL_GENERATE=1) it emits a Retrieve-and-
Generate record (enables faithfulness / correctness / citation precision +
coverage); without it, a retrieval-only record.

NOTE: the Bedrock dataset schema and create-evaluation-job API evolve — verify the
emitted shape + job config against current AWS docs before a production run.

Usage:
    # 1) convert only (writes /tmp/rag-eval.bedrock.jsonl):
    python to_bedrock_byoi.py /tmp/rag-eval.jsonl
    # 2) convert + upload + create job:
    python to_bedrock_byoi.py /tmp/rag-eval.jsonl \\
        --bucket my-evals --prefix rag/2026-06-07 \\
        --role-arn arn:aws:iam::ACCT:role/BedrockEvalRole \\
        --judge-model anthropic.claude-sonnet-4-... --region eu-west-1
"""
from __future__ import annotations

import argparse
import json
import sys


def to_turn(row: dict) -> dict:
    passages = [
        {"content": {"text": c["snippet"]}, "metadata": {"source": c.get("source", "")}}
        for c in row.get("contexts", [])
    ]
    output: dict = {"knowledgeBaseIdentifier": "byoi-rds-pgvector",
                    "retrievedPassages": {"retrievalResults": passages}}
    if row.get("answer"):
        output["text"] = row["answer"]
    return {
        "conversationTurns": [
            {"prompt": {"content": [{"text": row["query"]}]}, "output": output}
        ]
    }


def convert(in_path: str, out_path: str) -> int:
    n = 0
    with open(in_path, encoding="utf-8") as src, open(out_path, "w", encoding="utf-8") as dst:
        for line in src:
            if not line.strip():
                continue
            dst.write(json.dumps(to_turn(json.loads(line))) + "\n")
            n += 1
    print(f"==> wrote {n} Bedrock BYOI records to {out_path}")
    return n


def create_job(args, dataset_key: str) -> None:
    import boto3  # local import: only needed for the upload/create path
    s3 = boto3.client("s3", region_name=args.region)
    s3.upload_file(args.out, args.bucket, dataset_key)
    dataset_uri = f"s3://{args.bucket}/{dataset_key}"
    print(f"==> uploaded dataset to {dataset_uri}")
    print(
        "Create the evaluation job with the current API, e.g.:\n"
        f"  aws bedrock create-evaluation-job --region {args.region} \\\n"
        f"    --job-name rag-byoi-$(date +%s) --role-arn {args.role_arn} \\\n"
        "    --evaluation-config '{...RAG retrieve-and-generate metrics...}' \\\n"
        f"    --inference-config '{{\"models\":[{{\"bedrockModel\":{{\"modelIdentifier\":\"{args.judge_model}\"}}}}]}}' \\\n"
        f"    --output-data-config '{{\"s3Uri\":\"s3://{args.bucket}/{args.prefix}/out/\"}}'\n"
        "(Confirm the evaluation-config metric set + dataset wiring against current docs.)"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", default="/tmp/rag-eval.bedrock.jsonl")
    ap.add_argument("--bucket"); ap.add_argument("--prefix", default="rag-eval")
    ap.add_argument("--role-arn"); ap.add_argument("--judge-model", default="")
    ap.add_argument("--region", default="eu-west-1")
    args = ap.parse_args()

    convert(args.input, args.out)
    if args.bucket and args.role_arn:
        create_job(args, f"{args.prefix}/dataset.jsonl")
    else:
        print("Pass --bucket + --role-arn to upload + scaffold the create-evaluation-job command.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
