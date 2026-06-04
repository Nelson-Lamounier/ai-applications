# tucaken-smoke MCP
AI-driven E2E smoke testing against the dev account (771826808455 / eu-west-1 / db tucaken).
Build: `yarn --cwd mcp-servers/tucaken-smoke build`. Wired via repo-root `.mcp.json`.
Tools: smoke_auth, smoke_admin_api, smoke_sql, smoke_wait_pipeline, smoke_job_logs, smoke_cleanup,
smoke_run_strategist, smoke_run_coach, smoke_seed_project_evidence, smoke_assert_system_design.
Safety: dev-pinned, SELECT-only sql, confirm-on-spend, auto-cleanup. Logs: logs/ (JSON-lines, retain 20).
Prereq for AWS Labs MCPs: `uv`/`uvx` installed (brew install uv).
