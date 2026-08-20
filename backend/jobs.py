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
                """
            )

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
        values.append(job_id)
        with self._connect() as connection:
            connection.execute(
                f"UPDATE research_jobs SET {', '.join(assignments)} WHERE id = ?",
                values,
            )

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


async def aappend_event(job_id: str, event_type: str, data: dict[str, Any]) -> int:
    return await asyncio.to_thread(job_store.append_event, job_id, event_type, data)


async def aget_job(job_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(job_store.get_job, job_id)


async def aget_events(job_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
    return await asyncio.to_thread(job_store.get_events, job_id, after_sequence)
