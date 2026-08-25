"""Small persistent store for research jobs and replayable SSE events."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TERMINAL_STATUSES = {"completed", "failed", "cancelled", "waiting_approval"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ResearchJobStore:
    """SQLite-backed job metadata and append-only event log.

    The store is intentionally small. It gives one process durable history and
    SSE replay without adding a service dependency; a multi-process deployment
    can later replace this class with Redis/Postgres behind the same methods.
    """

    def __init__(self, db_path: str | None = None) -> None:
        default_path = Path(__file__).resolve().parent / "data" / "research.sqlite3"
        configured_path = db_path or os.getenv("RESEARCH_DB_PATH", str(default_path))
        self.db_path = Path(configured_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS research_jobs (
                    id TEXT PRIMARY KEY,
                    topic TEXT NOT NULL,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    result_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS research_events (
                    job_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (job_id, sequence),
                    FOREIGN KEY (job_id) REFERENCES research_jobs(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS research_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    research_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    sources_json TEXT NOT NULL,
                    research_results_json TEXT NOT NULL,
                    report TEXT NOT NULL,
                    parameters_json TEXT NOT NULL,
                    parent_version INTEGER,
                    created_at TEXT NOT NULL,
                    UNIQUE (research_id, version),
                    FOREIGN KEY (research_id) REFERENCES research_jobs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_research_versions_research_id
                    ON research_versions (research_id, version DESC);
                """
            )
        self._backfill_legacy_versions()

    def _backfill_legacy_versions(self) -> None:
        """Create v1 snapshots for jobs persisted before versioning existed."""
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT j.id, j.topic, j.payload_json, j.result_json
                FROM research_jobs AS j
                LEFT JOIN research_versions AS v ON v.research_id = j.id
                WHERE v.research_id IS NULL AND j.result_json IS NOT NULL
                """
            ).fetchall()
            for row in rows:
                try:
                    result = json.loads(row["result_json"] or "{}")
                    payload = json.loads(row["payload_json"] or "{}")
                    parameters = dict(payload) if isinstance(payload, dict) else {}
                    parameters["triage_context"] = result.get("triage_context", "")
                    connection.execute(
                        """
                        INSERT INTO research_versions
                            (research_id, version, kind, topic, plan_json, sources_json,
                             research_results_json, report, parameters_json, created_at)
                        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            row["id"],
                            "report" if result.get("draft") else "plan",
                            result.get("topic", row["topic"]),
                            json.dumps(result.get("sub_tasks", []), ensure_ascii=False),
                            json.dumps(result.get("sources", []), ensure_ascii=False),
                            json.dumps(result.get("research_results", []), ensure_ascii=False),
                            result.get("draft", ""),
                            json.dumps(parameters, ensure_ascii=False),
                            _utc_now(),
                        ),
                    )
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue

    def create_job(self, topic: str, payload: dict[str, Any], job_id: str | None = None) -> str:
        job_id = job_id or str(uuid.uuid4())
        now = _utc_now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO research_jobs
                    (id, topic, status, phase, payload_json, created_at, updated_at)
                VALUES (?, ?, 'queued', 'initializing', ?, ?, ?)
                """,
                (job_id, topic, json.dumps(payload, ensure_ascii=False), now, now),
            )
        return job_id

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        phase: str | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        clear_error: bool = False,
    ) -> None:
        assignments = ["updated_at = ?"]
        values: list[Any] = [_utc_now()]
        if status is not None:
            assignments.append("status = ?")
            values.append(status)
        if phase is not None:
            assignments.append("phase = ?")
            values.append(phase)
        if result is not None:
            assignments.append("result_json = ?")
            values.append(json.dumps(result, ensure_ascii=False))
        if error is not None:
            assignments.append("error = ?")
            values.append(error)
        elif clear_error:
            assignments.append("error = NULL")
        values.append(job_id)
        with self._connect() as connection:
            connection.execute(
                f"UPDATE research_jobs SET {', '.join(assignments)} WHERE id = ?",
                values,
            )

    def create_version(
        self,
        research_id: str,
        *,
        kind: str,
        topic: str,
        plan: list[str],
        sources: list[dict[str, Any]],
        research_results: list[dict[str, Any]],
        report: str,
        parameters: dict[str, Any],
        parent_version: int | None = None,
    ) -> int:
        """Store an immutable snapshot of one research plan/report version."""
        now = _utc_now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM research_versions WHERE research_id = ?",
                (research_id,),
            ).fetchone()
            version = int(row["next_version"])
            if parent_version is None and version > 1:
                parent_row = connection.execute(
                    "SELECT MAX(version) AS latest_version FROM research_versions WHERE research_id = ?",
                    (research_id,),
                ).fetchone()
                parent_version = int(parent_row["latest_version"] or 0) or None
            connection.execute(
                """
                INSERT INTO research_versions
                    (research_id, version, kind, topic, plan_json, sources_json,
                     research_results_json, report, parameters_json, parent_version, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    research_id,
                    version,
                    kind,
                    topic,
                    json.dumps(plan, ensure_ascii=False),
                    json.dumps(sources, ensure_ascii=False),
                    json.dumps(research_results, ensure_ascii=False),
                    report,
                    json.dumps(parameters, ensure_ascii=False),
                    parent_version,
                    now,
                ),
            )
        return version

    @staticmethod
    def _decode_version(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["plan"] = json.loads(result.pop("plan_json"))
        result["sources"] = json.loads(result.pop("sources_json"))
        result["research_results"] = json.loads(result.pop("research_results_json"))
        result["parameters"] = json.loads(result.pop("parameters_json"))
        return result

    def list_versions(self, research_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, research_id, version, kind, topic, plan_json, sources_json,
                       research_results_json, report, parameters_json, parent_version, created_at
                FROM research_versions
                WHERE research_id = ?
                ORDER BY version DESC
                LIMIT ?
                """,
                (research_id, max(1, min(limit, 200))),
            ).fetchall()
        versions = []
        for row in rows:
            version = self._decode_version(row)
            version["report_preview"] = version["report"][:240]
            version.pop("report", None)
            version.pop("parameters", None)
            version.pop("research_results", None)
            versions.append(version)
        return versions

    def get_version(self, research_id: str, version: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, research_id, version, kind, topic, plan_json, sources_json,
                       research_results_json, report, parameters_json, parent_version, created_at
                FROM research_versions
                WHERE research_id = ? AND version = ?
                """,
                (research_id, version),
            ).fetchone()
        return self._decode_version(row) if row is not None else None

    def list_jobs(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT j.id, j.topic, j.status, j.phase, j.error, j.created_at, j.updated_at,
                       v.version AS latest_version, v.kind AS latest_kind,
                       v.plan_json, v.sources_json, v.report, v.created_at AS version_created_at
                FROM research_jobs AS j
                LEFT JOIN research_versions AS v
                  ON v.research_id = j.id
                 AND v.version = (
                    SELECT MAX(v2.version) FROM research_versions AS v2 WHERE v2.research_id = j.id
                 )
                ORDER BY j.updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (max(1, min(limit, 200)), max(0, offset)),
            ).fetchall()
        history = []
        for row in rows:
            item = dict(row)
            latest_version = item.pop("latest_version")
            item["latest_version"] = (
                {
                    "version": latest_version,
                    "kind": item.pop("latest_kind"),
                    "plan_count": len(json.loads(item.pop("plan_json") or "[]")),
                    "source_count": len(json.loads(item.pop("sources_json") or "[]")),
                    "has_report": bool(item.pop("report") or ""),
                    "created_at": item.pop("version_created_at"),
                }
                if latest_version is not None
                else None
            )
            if latest_version is None:
                for key in ("latest_kind", "plan_json", "sources_json", "report", "version_created_at"):
                    item.pop(key, None)
            history.append(item)
        return history

    def append_event(self, job_id: str, event_type: str, data: dict[str, Any]) -> int:
        now = _utc_now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM research_events WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            sequence = int(row["next_sequence"])
            connection.execute(
                """
                INSERT INTO research_events (job_id, sequence, event_type, data_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (job_id, sequence, event_type, json.dumps(data, ensure_ascii=False), now),
            )
            connection.execute(
                "UPDATE research_jobs SET updated_at = ? WHERE id = ?",
                (now, job_id),
            )
        return sequence

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM research_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["payload"] = json.loads(result.pop("payload_json"))
        result["result"] = json.loads(result.pop("result_json")) if result.get("result_json") else None
        result.pop("result_json", None)
        return result

    def get_events(self, job_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT sequence, event_type, data_json, created_at
                FROM research_events
                WHERE job_id = ? AND sequence > ?
                ORDER BY sequence ASC
                """,
                (job_id, after_sequence),
            ).fetchall()
        return [
            {
                "sequence": int(row["sequence"]),
                "event_type": row["event_type"],
                "data": json.loads(row["data_json"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def mark_running_jobs_failed(self) -> None:
        """Mark jobs interrupted by a process restart as failed."""
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE research_jobs
                SET status = 'failed', error = '服务重启导致任务中断', updated_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (_utc_now(),),
            )


job_store = ResearchJobStore()


async def acreate_job(topic: str, payload: dict[str, Any], job_id: str | None = None) -> str:
    return await asyncio.to_thread(job_store.create_job, topic, payload, job_id)


async def aupdate_job(job_id: str, **kwargs: Any) -> None:
    await asyncio.to_thread(job_store.update_job, job_id, **kwargs)


async def acreate_version(research_id: str, **kwargs: Any) -> int:
    return await asyncio.to_thread(job_store.create_version, research_id, **kwargs)


async def alist_versions(research_id: str, limit: int = 50) -> list[dict[str, Any]]:
    return await asyncio.to_thread(job_store.list_versions, research_id, limit)


async def aget_version(research_id: str, version: int) -> dict[str, Any] | None:
    return await asyncio.to_thread(job_store.get_version, research_id, version)


async def alist_jobs(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    return await asyncio.to_thread(job_store.list_jobs, limit, offset)


async def aappend_event(job_id: str, event_type: str, data: dict[str, Any]) -> int:
    return await asyncio.to_thread(job_store.append_event, job_id, event_type, data)


async def aget_job(job_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(job_store.get_job, job_id)


async def aget_events(job_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
    return await asyncio.to_thread(job_store.get_events, job_id, after_sequence)
