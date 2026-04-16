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
from .agent.graph import research_graph, execute_graph
from .agent.nodes import triage_node, orchestrator_node, _make_event, _get_llm, PlanOutput
from .agent.prompts import (
    ORCHESTRATOR_SYSTEM,
    ORCHESTRATOR_USER_INITIAL,
    ORCHESTRATOR_USER_REPLAN,
)

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


class PlanRequest(BaseModel):
    """规划阶段请求"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")
    feedback: str = Field(default="", max_length=5000, description="用户对上一版方案的反馈意见")
    previous_plan: list[str] = Field(default_factory=list, description="上一版子任务列表")


class ExecuteRequest(BaseModel):
    """执行阶段请求 (用户审批通过后)"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    sub_tasks: list[str] = Field(..., description="已审批的子任务列表")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")
    triage_context: str = Field(default="", max_length=20000, description="哨兵收集的上下文")


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


def _merge_state(state: dict, update: dict):
    """手动合并节点输出到状态 (模拟 LangGraph 的 Reducer 行为)"""
    additive_keys = {"phase_events", "research_results", "sources"}
    for key, value in update.items():
        if key in additive_keys and isinstance(value, list):
            state[key] = state.get(key, []) + value
        else:
            state[key] = value


# ============================================================================
# 规划阶段端点 (Human-in-the-Loop: 哨兵 + 规划师 → 等待用户审批)
# ============================================================================

@app.post("/api/research/plan")
async def plan_research(request: PlanRequest):
    """
    SSE 流式端点 — 规划阶段。
    执行哨兵预搜 + 规划师拆解子任务，然后暂停等待用户审批。
    如果携带 feedback，则跳过哨兵直接重新规划。
    """
    is_replan = bool(request.feedback and request.previous_plan)
    logger.info(f"📋 收到{'重规划' if is_replan else '规划'}请求: {request.topic}")

    async def plan_generator():
        try:
            state = {
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

            yield _sse_format("phase", {"phase": "initializing", "message": "正在初始化研究任务..."})

            # ===== 哨兵阶段 (重规划时跳过) =====
            if not is_replan:
                yield _sse_format("phase", {"phase": "triage", "message": "🔭 哨兵侦察员正在进行预搜索..."})
                triage_result = await triage_node(state)
                _merge_state(state, triage_result)
                for evt in triage_result.get("phase_events", []):
                    yield _sse_format("event", evt)
            else:
                yield _sse_format("event", _make_event("planning", "跳过哨兵预搜 (复用上一轮情报)，直接重新规划..."))

            # ===== 规划师阶段 =====
            yield _sse_format("phase", {"phase": "planning", "message": "🧠 规划师正在拆解子任务..."})

            settings = get_settings()
            llm = _get_llm()

            # 构建用户要求块
            user_requirements = request.requirements
            requirements_block = ""
            if user_requirements:
                requirements_block = f"\n## 用户的详细要求:\n{user_requirements}\n\n请务必根据以上用户要求来侧重拆解子任务的方向和内容。\n"
            else:
                requirements_block = "\n"

            if is_replan:
                # 使用重规划 Prompt
                previous_plan_text = "\n".join([f"{i+1}. {t}" for i, t in enumerate(request.previous_plan)])
                user_prompt = ORCHESTRATOR_USER_REPLAN.format(
                    topic=request.topic,
                    previous_plan=previous_plan_text,
                    feedback=request.feedback,
                    max_sub_tasks=settings.max_sub_tasks,
                    requirements_block=requirements_block,
                )
            else:
                # 注入哨兵上下文
                triage_context = state.get("triage_context", "")
                context_block = ""
                if triage_context:
                    context_block = f"\n\n## 最新背景情报 (由哨兵侦察员提供):\n{triage_context}\n\n请务必参考以上最新情报来制定调研计划。"

                user_prompt = ORCHESTRATOR_USER_INITIAL.format(
                    topic=request.topic,
                    max_sub_tasks=settings.max_sub_tasks,
                    requirements_block=requirements_block,
                ) + context_block

            system_prompt = ORCHESTRATOR_SYSTEM.format(max_sub_tasks=settings.max_sub_tasks)

            # 调用 LLM 获取结构化规划
            try:
                from langchain_core.messages import HumanMessage, SystemMessage
                structured_llm = llm.with_structured_output(PlanOutput)
                result = await structured_llm.ainvoke([
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt),
                ])
                sub_tasks = result.sub_tasks[:settings.max_sub_tasks]
                reasoning = result.reasoning
            except Exception as e:
                logger.warning(f"结构化输出失败，回退到文本解析: {e}")
                from langchain_core.messages import HumanMessage, SystemMessage
                response = await llm.ainvoke([
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt),
                ])
                try:
                    data = json.loads(response.content)
                    sub_tasks = data.get("sub_tasks", [])[:settings.max_sub_tasks]
                    reasoning = data.get("reasoning", "")
                except json.JSONDecodeError:
                    sub_tasks = [
                        line.strip().lstrip("0123456789.-) ")
                        for line in response.content.split("\n")
                        if line.strip() and len(line.strip()) > 5
                    ][:settings.max_sub_tasks]
                    reasoning = "降级文本解析"

            yield _sse_format("event", _make_event("planning", f"规划完成: 生成 {len(sub_tasks)} 个子任务 ({reasoning})"))
            yield _sse_format("sub_tasks", {"sub_tasks": sub_tasks})

            # 发送 plan_ready 事件，携带子任务和哨兵上下文供前端保存
            yield _sse_format("plan_ready", {
                "sub_tasks": sub_tasks,
                "triage_context": state.get("triage_context", ""),
                "reasoning": reasoning,
            })

            yield _sse_format("phase", {"phase": "plan_review", "message": "调研方案已生成，等待确认..."})

        except Exception as e:
            logger.error(f"❌ 规划失败: {e}", exc_info=True)
            yield _sse_format("error", {"message": f"规划过程中发生错误: {str(e)}"})

    return StreamingResponse(
        plan_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================================
# 执行阶段端点 (用户审批通过后: 并发搜索 + 综合撰稿)
# ============================================================================

@app.post("/api/research/execute")
async def execute_research(request: ExecuteRequest):
    """
    SSE 流式端点 — 执行阶段。
    接收用户审批通过的子任务列表，执行搜索+撰稿。
    """
    logger.info(f"🚀 收到执行请求: {request.topic} ({len(request.sub_tasks)} 个子任务)")

    async def execute_generator():
        try:
            initial_state = {
                "topic": request.topic,
                "user_requirements": request.requirements,
                "sub_tasks": request.sub_tasks,
                "research_results": [],
                "draft": "",
                "current_phase": "searching",
                "phase_events": [],
                "sources": [],
                "triage_context": request.triage_context,
                "error": "",
            }

            thread_id = str(uuid.uuid4())
            config = {"configurable": {"thread_id": thread_id}}

            yield _sse_format("phase", {"phase": "searching", "message": "🔍 搜索智能体正在并发执行调研..."})

            last_phase = "searching"

            async for event in execute_graph.astream(initial_state, config=config, stream_mode="updates"):
                for node_name, update in event.items():
                    new_phase = update.get("current_phase", last_phase)
                    if new_phase != last_phase:
                        yield _sse_format("phase", {
                            "phase": new_phase,
                            "node": node_name,
                            "message": _phase_message(new_phase, node_name),
                        })
                        last_phase = new_phase

                    events = update.get("phase_events", [])
                    for evt in events:
                        yield _sse_format("event", evt)

                    if "research_results" in update:
                        for r in update["research_results"]:
                            yield _sse_format("search_result", {
                                "sub_task": r.get("sub_task"),
                                "source_count": r.get("source_count", 0),
                            })

            # 获取最终状态
            final_state = await execute_graph.aget_state(config)
            state_values = final_state.values

            yield _sse_format("result", {
                "topic": state_values.get("topic", request.topic),
                "draft": state_values.get("draft", ""),
                "sources": state_values.get("sources", []),
            })

            yield _sse_format("phase", {"phase": "done", "message": "研究完成!"})

        except Exception as e:
            logger.error(f"❌ 执行失败: {e}", exc_info=True)
            yield _sse_format("error", {"message": f"执行过程中发生错误: {str(e)}"})

    return StreamingResponse(
        execute_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
