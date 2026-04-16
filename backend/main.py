"""
FastAPI 应用主入口。
提供研究 API 端点，包括同步调用和 SSE 流式推送。

端点:
- GET  /health            — 健康检查 (含 LLM 配置信息)
- POST /api/research       — 同步执行研究并返回结果
- POST /api/research/stream — SSE 流式推送各阶段实时状态
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .config import get_settings
from .agent.graph import research_graph

# ============================================================================
# 日志配置
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)-25s | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ============================================================================
# FastAPI 应用初始化
# ============================================================================

app = FastAPI(
    title="LangGraph Multi-Agent Researcher API",
    description="基于 LangGraph 的多智能体深度研究系统 API",
    version="2.0.0",
)

# CORS 中间件
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# 请求/响应模型
# ============================================================================

class ResearchRequest(BaseModel):
    """研究请求"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")


class ResearchResponse(BaseModel):
    """研究结果响应"""
    topic: str
    draft: str
    sources: list[dict]
    phase_events: list[dict]


# ============================================================================
# 端点
# ============================================================================

@app.get("/health")
async def health_check():
    """
    健康检查端点。返回服务状态和 LLM 配置信息。
    """
    return {
        "status": "ok",
        "version": "2.0.0",
        "model": settings.model_name,
        "base_url": settings.openai_base_url,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/research", response_model=ResearchResponse)
async def run_research(request: ResearchRequest):
    """
    同步执行完整研究流程。
    适用于不需要实时状态更新的场景。
    
    注意: 此端点会阻塞直到整个研究流程完成 (可能耗时较长)。
    对于需要实时反馈的前端，建议使用 /api/research/stream。
    """
    logger.info(f"🚀 收到研究请求: {request.topic}")

    try:
        # 初始化状态
        initial_state = {
            "topic": request.topic,
            "user_requirements": request.requirements,
            "sub_tasks": [],
            "research_results": [],
            "draft": "",
            "review_feedback": "",
            "revision_count": 0,
            "current_phase": "initializing",
            "phase_events": [],
            "sources": [],
            "error": "",
        }

        # 执行图 (需要 thread_id 用于 Checkpointer)
        thread_id = str(uuid.uuid4())
        config = {"configurable": {"thread_id": thread_id}}

        final_state = await research_graph.ainvoke(initial_state, config=config)

        logger.info(f"✅ 研究完成: {request.topic}")

        return ResearchResponse(
            topic=final_state.get("topic", request.topic),
            draft=final_state.get("draft", ""),
            sources=final_state.get("sources", []),
            phase_events=final_state.get("phase_events", []),
        )

    except Exception as e:
        logger.error(f"❌ 研究失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"研究过程中发生错误: {str(e)}")


@app.post("/api/research/stream")
async def stream_research(request: ResearchRequest):
    """
    SSE 流式端点。实时推送各阶段状态更新。
    
    前端通过 EventSource 或 fetch + ReadableStream 消费:
    - event: phase     — 阶段变更 (planning/searching/synthesizing/reviewing/done)
    - event: event     — 详细事件日志
    - event: result    — 最终研究结果
    - event: error     — 错误信息
    """
    logger.info(f"🚀 收到流式研究请求: {request.topic}")

    async def event_generator():
        try:
            initial_state = {
                "topic": request.topic,
                "user_requirements": request.requirements,
                "sub_tasks": [],
                "research_results": [],
                "draft": "",
                "current_phase": "initializing",
                "phase_events": [],
                "sources": [],
                "triage_context": "",
                "error": "",
            }

            thread_id = str(uuid.uuid4())
            config = {"configurable": {"thread_id": thread_id}}

            # 发送初始状态
            yield _sse_format("phase", {"phase": "initializing", "message": "正在初始化研究任务..."})

            # 使用 astream 流式执行图，逐节点推送状态
            last_phase = "initializing"

            async for event in research_graph.astream(initial_state, config=config, stream_mode="updates"):
                # event 是 {node_name: state_update} 格式
                for node_name, update in event.items():
                    # 推送阶段变更
                    new_phase = update.get("current_phase", last_phase)
                    if new_phase != last_phase:
                        yield _sse_format("phase", {
                            "phase": new_phase,
                            "node": node_name,
                            "message": _phase_message(new_phase, node_name),
                        })
                        last_phase = new_phase

                    # 推送事件日志
                    events = update.get("phase_events", [])
                    for evt in events:
                        yield _sse_format("event", evt)

                    # 如果有 sub_tasks 更新，推送
                    if "sub_tasks" in update:
                        yield _sse_format("sub_tasks", {
                            "sub_tasks": update["sub_tasks"],
                        })

                    # 如果有 research_results 更新，推送摘要
                    if "research_results" in update:
                        for r in update["research_results"]:
                            yield _sse_format("search_result", {
                                "sub_task": r.get("sub_task"),
                                "source_count": r.get("source_count", 0),
                            })

            # 获取最终状态
            final_state = await research_graph.aget_state(config)
            state_values = final_state.values

            # 推送最终结果
            yield _sse_format("result", {
                "topic": state_values.get("topic", request.topic),
                "draft": state_values.get("draft", ""),
                "sources": state_values.get("sources", []),
            })

            yield _sse_format("phase", {"phase": "done", "message": "研究完成!"})

        except Exception as e:
            logger.error(f"❌ 流式研究失败: {e}", exc_info=True)
            yield _sse_format("error", {"message": f"研究过程中发生错误: {str(e)}"})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 Nginx 缓冲
        },
    )


# ============================================================================
# 辅助函数
# ============================================================================

def _sse_format(event_type: str, data: dict) -> str:
    """格式化 SSE 事件消息"""
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _phase_message(phase: str, node_name: str) -> str:
    """根据阶段生成可读消息"""
    messages = {
        "triage": "🔭 哨兵侦察员正在进行预搜索，获取最新背景情报...",
        "planning": "🧠 规划师正在分析课题并拆解子任务...",
        "searching": "🔍 搜索智能体正在并发执行调研 (含质量审查)...",
        "synthesizing": "📝 撰稿人正在综合分析调研结果...",
        "done": "✅ 研究流程已完成!",
    }
    return messages.get(phase, f"正在执行: {node_name}")


# ============================================================================
# 启动入口
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
