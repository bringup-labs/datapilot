from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
import asyncio
import json
import logging
import re
import uuid
from typing import List, Optional
import aiosqlite
from pathlib import Path

from app.agent.turn_store import turn_store
from app.db_sqlite import get_db, AsyncSessionLocal
from app.models import ChatMessageRecord, SessionCostRecord, SessionRecord
from app.config import settings
from app.schemas import (
    SessionCreate, SessionResponse, TimelineEvent, TopicInfo, LogItem,
    KGraphResponse, ReplayResponse, AnomalyItem,
)
from app.services.parser import ingestion_parser, scope_log_ids
from app.services.embeddings import embedding_service
from app.services.neo4j_client import neo4j_client
from app.services.causal_rules import causal_rules_evaluator, log_time_to_seconds
from app.services.kgraph_builder import build_kgraph, attach_session_root

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])

_CHECKPOINTS_DB = Path(settings.datapilot_data_dir) / "agent_checkpoints.sqlite"

# Vector search over-fetch factor (issue #78). `db.index.vector.queryNodes`
# returns only the top-k neighbours, so applying the severity filter / SKIP /
# LIMIT *after* truncation can starve the result set when the nearest hits are
# the wrong severity. Pull a multiple of (limit + offset) candidates so the
# post-filter has room to work. k-NN + offset pagination is still approximate.
VECTOR_OVERFETCH_FACTOR = 5

# Lucene special characters that must be escaped before a user string is handed
# to `db.index.fulltext.queryNodes` (issue #67) — an unescaped `+`/`-`/`(` etc.
# can throw or be abused for an expensive query.
_LUCENE_SPECIAL = r'+-&|!(){}[]^"~*?:\/'


def _escape_lucene(q: str) -> str:
    """Backslash-escape Lucene query syntax so a raw user string is treated as
    literal text rather than a query expression (issue #67)."""
    out = []
    for ch in q:
        if ch in _LUCENE_SPECIAL:
            out.append("\\")
        out.append(ch)
    return "".join(out)


async def _clear_checkpoints_for_session(session_id: str) -> None:
    """Remove LangGraph checkpoint rows for a single session."""
    try:
        if not _CHECKPOINTS_DB.exists():
            return
        async with aiosqlite.connect(str(_CHECKPOINTS_DB)) as db:
            await db.execute("DELETE FROM checkpoints WHERE thread_id = ?", (session_id,))
            await db.execute("DELETE FROM checkpoint_writes WHERE thread_id = ?", (session_id,))
            await db.commit()
    except Exception as e:
        logger.warning("could not clear checkpoints for %s: %s", session_id, e)


async def _clear_all_checkpoints() -> None:
    """Truncate all LangGraph checkpoint data."""
    try:
        if not _CHECKPOINTS_DB.exists():
            return
        async with aiosqlite.connect(str(_CHECKPOINTS_DB)) as db:
            await db.execute("DELETE FROM checkpoints")
            await db.execute("DELETE FROM checkpoint_writes")
            await db.commit()
    except Exception as e:
        logger.warning("could not clear all checkpoints: %s", e)


def _basename(filepath: str) -> str:
    """Cross-platform basename — splits on both `/` and `\\` so Windows paths
    render the filename rather than the full absolute path. Mirrors the
    rendererside helper in `src/renderer/App.tsx`."""
    parts = re.split(r"[/\\]", filepath)
    return parts[-1] if parts else filepath

async def run_ingestion(session_id: str, filepath: str):
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
        record = res.scalar_one_or_none()
        if not record:
            return
        
        try:
            # 1. Parse ROS telemetry (via mcap-parser service, falls back to inline CDR parser)
            parsed = await ingestion_parser.parse_bag(filepath)

            # Make Log ids globally unique by scoping them to this session, so a
            # second ingestion can't collide ids across sessions and corrupt
            # causal/citation edges (issue #68). Also remaps anomaly source ids.
            scope_log_ids(session_id, parsed)

            # Stamp an absolute numeric timestamp on every log so retrieval can
            # sort chronologically instead of lexicographically on the display
            # string (issue #70).
            for l in parsed.get("logs", []):
                l["t_sec"] = log_time_to_seconds(l.get("t", "0"))

            # 2. Vectorize log lines (DEBUG logs stored without embedding to
            # save cost — they're rarely useful for diagnosis).
            logs = parsed.get("logs", [])
            non_debug_logs = [l for l in logs if l.get("sev", "").upper() != "DEBUG"]
            log_texts = [embedding_service.format_log_text(l) for l in non_debug_logs]

            embeddings = embedding_service.embed_texts(log_texts)

            emb_idx = 0
            for l in logs:
                if l.get("sev", "").upper() != "DEBUG":
                    l["embedding"] = embeddings[emb_idx]
                    emb_idx += 1
                else:
                    l["embedding"] = None

            # Initialize Neo4j Indexes
            dim = embedding_service.get_embedding_dimension()
            neo4j_client.init_indexes(embedding_dim=dim)
            
            # Clear Neo4j entries for this session ID
            neo4j_client.clear_session(session_id)
            
            # Create main session node
            neo4j_client.create_session_node(
                session_id=session_id,
                filename=parsed["filename"],
                robot_id=parsed.get("robot_name", "robot"),
                duration_s=parsed.get("duration_seconds", 0.0),
                started_at=parsed.get("start_time", "")
            )
            
            # Write components into Neo4j Graph
            neo4j_client.write_logs(session_id, logs)
            neo4j_client.write_topics(session_id, parsed.get("topics", []))
            neo4j_client.write_frames(session_id, parsed.get("frames", []))
            
            # Write sensors and diagnostics
            neo4j_client.write_sensors(session_id, parsed.get("sensors", []))
            neo4j_client.write_diagnostics(session_id, parsed.get("diagnostics", []))

            # 3. Anomalies (Phase 3 seeds these from parsed timeline events;
            # Phase 5 AnomalyDetector worker will write more via the same shape).
            anomalies = parsed.get("anomalies", [])
            neo4j_client.write_anomalies(session_id, anomalies)

            # 4. Evaluate Causal Rules
            edges = causal_rules_evaluator.evaluate(logs)
            neo4j_client.write_edges(edges)

            # 5. Build knowledge graph from ingested data
            kgraph = build_kgraph(
                sensors=parsed.get("sensors", []),
                anomalies=anomalies,
                logs=logs,
                causal_edges=edges,
                topics=parsed.get("topics", []),
                session_id=session_id,
                session_label=record.filename,
            )

            # 6. Save metadata caches to SQLite Record
            record.status = "ready"
            record.robot_name = parsed.get("robot_name")
            record.ros_version = parsed.get("ros_version")
            record.duration_seconds = parsed.get("duration_seconds")
            record.start_time = parsed.get("start_time")
            record.end_time = parsed.get("end_time")
            record.total_messages = parsed.get("total_messages", 0) or len(logs)
            record.topics_list = json.dumps([t["name"] for t in parsed.get("topics", [])])
            record.timeline_json = json.dumps(parsed.get("timeline_events", []))
            record.topics_json = json.dumps(parsed.get("topics", []))
            # Prefer the kgraph built from real ingested data; fall back to
            # whatever the parser produced (e.g. the mock test fixtures).
            parsed_kgraph = parsed.get("kgraph", {"nodes": [], "edges": []})
            if kgraph["nodes"]:
                record.kgraph_json = json.dumps(kgraph)
            else:
                record.kgraph_json = json.dumps(parsed_kgraph)
            record.replay_json = json.dumps(parsed.get("replay", []))
            record.anomalies_json = json.dumps(anomalies)
            
            await db.commit()
        except Exception as e:
            # Never persist the raw exception: it is returned to the client via
            # SessionResponse.error_message, and exception text routinely embeds
            # bolt URIs with credentials and absolute host paths (issue #63).
            # Mirror internal_error_handler — a fixed message plus a correlation
            # id, with the full detail logged server-side only.
            correlation_id = uuid.uuid4().hex
            record.status = "error"
            record.error_message = f"Ingestion failed (ref: {correlation_id})"
            await db.commit()
            logger.error(
                "ingestion failed [%s] for session %s: %r",
                correlation_id, session_id, e, exc_info=True,
            )

@router.post("/create", status_code=202)
async def create_session(
    payload: SessionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    session_id = str(uuid.uuid4())
    filename = _basename(payload.filepath)
    
    # Store initial record in SQLite
    new_record = SessionRecord(
        id=session_id,
        filename=filename,
        filepath=payload.filepath,
        status="processing"
    )
    db.add(new_record)
    await db.commit()
    
    # Start ingestion background task
    background_tasks.add_task(run_ingestion, session_id, payload.filepath)
    
    return {
        "session_id": session_id,
        "filepath": payload.filepath,
        "status": "processing"
    }

@router.get("", response_model=List[SessionResponse])
async def list_sessions(db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(SessionRecord)
        .options(selectinload(SessionRecord.messages))
        .order_by(SessionRecord.created_at.desc())
    )
    records = res.scalars().unique().all()
    response = []
    for record in records:
        topics = []
        if record.topics_list:
            try:
                topics = json.loads(record.topics_list)
            except Exception:
                topics = []
        response.append(SessionResponse(
            id=record.id,
            filename=record.filename,
            filepath=record.filepath,
            robot_name=record.robot_name,
            ros_version=record.ros_version,
            duration_seconds=record.duration_seconds,
            start_time=record.start_time,
            end_time=record.end_time,
            total_messages=record.total_messages,
            topics_list=topics,
            status=record.status,
            error_message=record.error_message,
            created_at=record.created_at,
            updated_at=max([m.created_at for m in record.messages], default=record.created_at) if record.messages else record.created_at
        ))
    return response

@router.delete("/{session_id}")
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        neo4j_client.clear_session(session_id)
    except Exception as e:
        logger.warning("error clearing neo4j for session %s: %s", session_id, e)

    await _clear_checkpoints_for_session(session_id)
    turn_store.discard_session(session_id)
    await db.delete(record)
    await db.commit()
    return {"status": "success", "message": f"Session {session_id} deleted"}

@router.delete("")
async def delete_all_sessions(db: AsyncSession = Depends(get_db)):
    try:
        neo4j_client.run_query("MATCH (n) DETACH DELETE n")
    except Exception as e:
        logger.warning("error clearing neo4j: %s", e)

    await _clear_all_checkpoints()
    turn_store.clear()
    # Bulk deletes skip the ORM cascade and SQLite FKs are off, so clear the
    # child tables explicitly before the sessions.
    await db.execute(delete(ChatMessageRecord))
    await db.execute(delete(SessionCostRecord))
    await db.execute(delete(SessionRecord))
    await db.commit()
    return {"status": "success", "message": "All sessions cleared"}

@router.get("/{session_id}", response_model=SessionResponse)

async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Map topics_list field back to array
    topics = []
    if record.topics_list:
        topics = json.loads(record.topics_list)
        
    return SessionResponse(
        id=record.id,
        filename=record.filename,
        filepath=record.filepath,
        robot_name=record.robot_name,
        ros_version=record.ros_version,
        duration_seconds=record.duration_seconds,
        start_time=record.start_time,
        end_time=record.end_time,
        total_messages=record.total_messages,
        topics_list=topics,
        status=record.status,
        error_message=record.error_message,
        created_at=record.created_at
    )

@router.get("/{session_id}/timeline", response_model=List[TimelineEvent])
async def get_timeline(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        return []
    return json.loads(record.timeline_json or "[]")

@router.get("/{session_id}/topics", response_model=List[TopicInfo])
async def get_topics(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        return []
    return json.loads(record.topics_json or "[]")

@router.get("/{session_id}/logs", response_model=List[LogItem])
async def get_logs(
    session_id: str,
    q: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db)
):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
        
    # Search or query nodes in Neo4j
    if q:
        # Perform semantic vector query if embeddings ready, else full-text query
        try:
            dim = embedding_service.get_embedding_dimension()
            query_vector = embedding_service.embed_texts([q])[0]

            # Pagination: pull `limit + offset` from the vector index, then
            # apply SKIP/LIMIT to honor the caller's offset. The vector index
            # itself has no concept of offset.
            cypher = """
            MATCH (s:Session {id: $session_id})
            CALL db.index.vector.queryNodes('log_embedding_idx', $vector_limit, $query_vector)
            YIELD node, score
            MATCH (s)-[:HAS_LOG]->(node)
            WHERE ($severity IS NULL OR node.severity = $severity)
            RETURN node.ts as t, node.node as node, node.severity as sev, node.msg as text, node.id as id
            SKIP $offset LIMIT $limit
            """
            params = {
                "session_id": session_id,
                "query_vector": query_vector,
                "severity": severity.upper() if severity else None,
                # Over-fetch candidates so the post-filter (severity) + SKIP/LIMIT
                # don't starve on wrong-severity nearest neighbours (issue #78).
                "vector_limit": (limit + offset) * VECTOR_OVERFETCH_FACTOR,
                "offset": offset,
                "limit": limit,
            }
            # neo4j_client is synchronous — keep it off the event loop (issue #77).
            results = await asyncio.to_thread(neo4j_client.run_query, cypher, params)
            return [LogItem(**r) for r in results]
        except Exception:
            # Vector search may be unavailable (no index yet, dim mismatch, etc.)
            # — fall back to the lexical fulltext query. Log via the module
            # logger (not print) and never echo the raw error (issue #67).
            logger.warning("vector search failed for session %s; using fulltext", session_id)
            cypher = """
            MATCH (s:Session {id: $session_id})
            CALL db.index.fulltext.queryNodes('log_msg_fulltext', $q)
            YIELD node, score
            MATCH (s)-[:HAS_LOG]->(node)
            WHERE ($severity IS NULL OR node.severity = $severity)
            RETURN node.ts as t, node.node as node, node.severity as sev, node.msg as text, node.id as id
            ORDER BY score DESC
            SKIP $offset LIMIT $limit
            """
            params = {
                "session_id": session_id,
                "q": _escape_lucene(q),
                "severity": severity.upper() if severity else None,
                "offset": offset,
                "limit": limit
            }
            results = await asyncio.to_thread(neo4j_client.run_query, cypher, params)
            return [LogItem(**r) for r in results]
    else:
        # Standard retrieve sorted by timestamp
        cypher = """
        MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
        WHERE ($severity IS NULL OR l.severity = $severity)
        RETURN l.ts as t, l.node as node, l.severity as sev, l.msg as text, l.id as id
        ORDER BY l.t_sec ASC, l.ts ASC
        SKIP $offset LIMIT $limit
        """
        params = {
            "session_id": session_id,
            "severity": severity.upper() if severity else None,
            "offset": offset,
            "limit": limit
        }
        results = await asyncio.to_thread(neo4j_client.run_query, cypher, params)
        return [LogItem(**r) for r in results]

@router.get("/{session_id}/kgraph", response_model=KGraphResponse)
async def get_kgraph(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        return KGraphResponse(nodes=[], edges=[])
    base = json.loads(record.kgraph_json or '{"nodes": [], "edges": []}')

    # Merge in conversation facts persisted live in Neo4j. Best-effort: a Neo4j
    # hiccup falls back to the cached structural graph.
    try:
        # Neo4j I/O is synchronous — run it off the event loop.
        facts = await asyncio.to_thread(neo4j_client.get_facts_graph, session_id)
        node_ids = {n["id"] for n in base.get("nodes", [])}
        for fn in facts.get("nodes", []):
            if fn["id"] not in node_ids:
                base.setdefault("nodes", []).append(fn)
                node_ids.add(fn["id"])
        # Keep only fact edges that point at an existing structural/fact node.
        for e in facts.get("edges", []):
            if e[0] in node_ids and e[1] in node_ids:
                base.setdefault("edges", []).append(e)
    except Exception:
        logger.exception("failed to merge conversation facts into kgraph")

    # Anchor every node (incl. facts and any legacy cache without a root) to a
    # single Session hub node so the graph is one connected component.
    attach_session_root(base, session_id, record.filename)

    return KGraphResponse(**base)

@router.get("/{session_id}/causal-chain", response_model=List[LogItem])
async def get_causal_chain(
    session_id: str,
    event_id: str = Query(...),
    db: AsyncSession = Depends(get_db)
):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
        
    # Traverse upstream CAUSED/TRIGGERED relations
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(target:Log {id: $event_id})
    MATCH path = (source:Log)-[:CAUSED|TRIGGERED*0..5]->(target)
    UNWIND nodes(path) as n
    RETURN DISTINCT n.id as id, n.ts as t, n.node as node, n.severity as sev, n.msg as text
    """
    results = await asyncio.to_thread(
        neo4j_client.run_query, cypher, {"session_id": session_id, "event_id": event_id}
    )
    # Sort by numeric seconds, not by string — `"10:00:00"` would otherwise
    # sort BEFORE `"2:00:00"` for unpadded hours, and beyond 99h the lexical
    # order silently diverges from chronological order.
    results.sort(key=lambda x: log_time_to_seconds(x.get("t", "0")))
    return [LogItem(**r) for r in results]

@router.get("/{session_id}/replay", response_model=ReplayResponse)
async def get_replay(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        return ReplayResponse(frames=[])
    return ReplayResponse(frames=json.loads(record.replay_json or "[]"))


@router.get("/{session_id}/anomalies", response_model=List[AnomalyItem])
async def get_anomalies(session_id: str, db: AsyncSession = Depends(get_db)):
    """
    Returns the anomalies detected for this session.

    Phase 3 seeds these from `timeline_events[type=='anomaly']` during ingestion.
    Phase 5's AnomalyDetector worker will append richer entries with proper
    statistical/signature `kind` values.
    """
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        return []
    return json.loads(record.anomalies_json or "[]")
