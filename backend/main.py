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

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .config import get_settings
from .agent.graph import research_graph, execute_graph
from .agent.nodes import triage_node, orchestrator_node, _make_event, _get_llm, PlanOutput, _parse_structured_json
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

from fastapi.staticfiles import StaticFiles
import os
os.makedirs("backend/static/charts", exist_ok=True)
app.mount("/static", StaticFiles(directory="backend/static"), name="static")


# ============================================================================
# 请求级临时配置中间件
# ============================================================================
from fastapi import Request
from .config import (
    temp_api_key,
    temp_base_url,
    temp_model,
    temp_anysearch_key,
    temp_max_sub_tasks,
    temp_max_search_results,
    temp_max_search_review_retries
)

@app.middleware("http")
async def temp_config_middleware(request: Request, call_next):
    def _parse_int(val) -> int:
        try:
            return int(val) if val else 0
        except ValueError:
            return 0

    # 提取前端发来的配置 Header
    t1 = temp_api_key.set(request.headers.get("x-llm-api-key", ""))
    t2 = temp_base_url.set(request.headers.get("x-llm-base-url", ""))
    t3 = temp_model.set(request.headers.get("x-llm-model", ""))
    t4 = temp_anysearch_key.set(request.headers.get("x-anysearch-api-key", ""))
    
    t5 = temp_max_sub_tasks.set(_parse_int(request.headers.get("x-max-sub-tasks", "")))
    t6 = temp_max_search_results.set(_parse_int(request.headers.get("x-max-search-results", "")))
    t7 = temp_max_search_review_retries.set(_parse_int(request.headers.get("x-max-search-review-retries", "")))
    
    try:
        response = await call_next(request)
        return response
    finally:
        # 重置上下文以防泄露
        temp_api_key.reset(t1)
        temp_base_url.reset(t2)
        temp_model.reset(t3)
        temp_anysearch_key.reset(t4)
        temp_max_sub_tasks.reset(t5)
        temp_max_search_results.reset(t6)
        temp_max_search_review_retries.reset(t7)




# ============================================================================
# 请求/响应模型
# ============================================================================

class ResearchRequest(BaseModel):
    """研究请求"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")
    search_engine: str = Field(default="domestic", description="搜索引擎: domestic(国内DashScope) / international(DuckDuckGo)")
    uploaded_context: str = Field(default="", max_length=50000, description="用户上传文件转换后的 Markdown 内容")


class PlanRequest(BaseModel):
    """规划阶段请求"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")
    feedback: str = Field(default="", max_length=5000, description="用户对上一版方案的反馈意见")
    previous_plan: list[str] = Field(default_factory=list, description="上一版子任务列表")
    search_engine: str = Field(default="domestic", description="搜索引擎: domestic / international")
    uploaded_context: str = Field(default="", max_length=50000, description="用户上传文件转换后的 Markdown 内容")


class ExecuteRequest(BaseModel):
    """执行阶段请求 (用户审批通过后)"""
    topic: str = Field(..., min_length=2, max_length=500, description="研究课题")
    sub_tasks: list[str] = Field(..., description="已审批的子任务列表")
    requirements: str = Field(default="", max_length=10000, description="用户的详细要求 (可选)")
    triage_context: str = Field(default="", max_length=20000, description="哨兵收集的上下文")
    search_engine: str = Field(default="domestic", description="搜索引擎: domestic / international")
    uploaded_context: str = Field(default="", max_length=50000, description="用户上传文件转换后的 Markdown 内容")


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
        "version": "2.1.0",
        "model": settings.model_name,
        "base_url": settings.openai_base_url,
        "has_global_key": settings.openai_api_key != "sk-placeholder" and bool(settings.openai_api_key),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }



# ============================================================================
# 文件上传端点 (MarkItDown 转换)
# ============================================================================

# 支持的文件扩展名
_ALLOWED_EXTENSIONS = {
    '.md', '.txt', '.csv', '.json', '.xml', '.html', '.htm',
    '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
    '.epub', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.wav', '.mp3',
}
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    文件上传端点。使用 MarkItDown 将各种格式文件转换为 Markdown 文本。
    支持: PDF, Word, PowerPoint, Excel, Markdown, TXT, CSV, JSON, XML, HTML 等。
    """
    import os
    from markitdown import MarkItDown

    # 校验文件扩展名
    ext = os.path.splitext(file.filename or '')[1].lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件格式: {ext}。支持的格式: {', '.join(sorted(_ALLOWED_EXTENSIONS))}"
        )

    # 读取文件内容并校验大小
    content_bytes = await file.read()
    if len(content_bytes) > _MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"文件过大，最大支持 10MB")

    try:
        # .md / .txt 直接读取
        if ext in {'.md', '.txt'}:
            markdown_content = content_bytes.decode('utf-8', errors='replace')
        else:
            # 其他格式通过 MarkItDown 转换
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(content_bytes)
                tmp_path = tmp.name
            try:
                md = MarkItDown()
                result = md.convert(tmp_path)
                markdown_content = result.text_content
            finally:
                os.unlink(tmp_path)

        # 截断过长内容
        max_chars = 15000
        truncated = len(markdown_content) > max_chars
        if truncated:
            markdown_content = markdown_content[:max_chars] + "\n\n... (内容已截断，原文过长)"

        logger.info(f"📄 文件上传成功: {file.filename} ({len(content_bytes)} bytes → {len(markdown_content)} chars Markdown)")

        return {
            "filename": file.filename,
            "markdown": markdown_content,
            "char_count": len(markdown_content),
            "truncated": truncated,
        }

    except Exception as e:
        logger.error(f"❌ 文件转换失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"文件转换失败: {str(e)}")


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
            "search_engine": request.search_engine,
            "uploaded_context": request.uploaded_context,
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
                "search_engine": request.search_engine,
                "uploaded_context": request.uploaded_context,
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
                "search_engine": request.search_engine,
                "uploaded_context": request.uploaded_context,
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
                for src in triage_result.get("sources", []):
                    yield _sse_format("new_source", src)
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

            # 获取动态最大子任务数
            max_sub = temp_max_sub_tasks.get() or settings.max_sub_tasks

            if is_replan:
                # 使用重规划 Prompt
                previous_plan_text = "\n".join([f"{i+1}. {t}" for i, t in enumerate(request.previous_plan)])
                user_prompt = ORCHESTRATOR_USER_REPLAN.format(
                    topic=request.topic,
                    previous_plan=previous_plan_text,
                    feedback=request.feedback,
                    max_sub_tasks=max_sub,
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
                    max_sub_tasks=max_sub,
                    requirements_block=requirements_block,
                ) + context_block

            system_prompt = ORCHESTRATOR_SYSTEM.format(max_sub_tasks=max_sub)

            # 调用 LLM 获取结构化规划
            try:
                from langchain_core.messages import HumanMessage, SystemMessage
                structured_llm = llm.with_structured_output(PlanOutput)
                result = await structured_llm.ainvoke([
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt),
                ])
                sub_tasks = result.sub_tasks[:max_sub]
                reasoning = result.reasoning
            except Exception as e:
                logger.warning(f"结构化输出失败，回退到文本解析: {e}")
                from langchain_core.messages import HumanMessage, SystemMessage
                response = await llm.ainvoke([
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt),
                ])
                try:
                    data = _parse_structured_json(response.content)
                    sub_tasks = data.get("sub_tasks", [])[:max_sub]
                    reasoning = data.get("reasoning", "")
                    if not isinstance(sub_tasks, list) or not sub_tasks:
                        raise ValueError("Parsed sub_tasks is empty or not a list")
                except Exception as ex:
                    logger.warning(f"结构化文本解析失败: {ex}，降级为行拆分解析")
                    sub_tasks = [
                        line.strip().lstrip("0123456789.-) ")
                        for line in response.content.split("\n")
                        if line.strip() and len(line.strip()) > 5
                    ][:max_sub]
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
                "search_engine": request.search_engine,
                "uploaded_context": request.uploaded_context,
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

                    if "sources" in update:
                        for s in update["sources"]:
                            yield _sse_format("new_source", s)

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
# Obsidian 本地归档端点 (使用 npx 启动官方 @modelcontextprotocol/server-filesystem MCP)
# ============================================================================
class ArchiveRequest(BaseModel):
    obsidian_vault_path: str = Field(..., description="Obsidian 库绝对路径")
    topic: str = Field(..., description="研究课题名")
    draft: str = Field(..., description="报告 Markdown 内容")

@app.post("/api/research/archive")
async def archive_to_obsidian(request: ArchiveRequest):
    """
    一键将报告同步到用户的 Obsidian 库中：
    1. 通过 npx 启动官方 @modelcontextprotocol/server-filesystem MCP
    2. 对报告内的 Base64 图片进行提取、解码并转存至 Obsidian attachments/ 目录中
    3. 将原 Base64 图片引用转换为 Obsidian 的本地相对路径语法
    4. 调用 MCP 工具将最终 Markdown 报告写入 DeeperResearch 文件夹下
    """
    from langchain_mcp_adapters.client import MultiServerMCPClient
    import base64
    import re
    import hashlib
    import os
    import asyncio
    
    vault_path = request.obsidian_vault_path.strip()
    if not vault_path:
        raise HTTPException(status_code=400, detail="Obsidian 库路径不能为空")
    
    # 清理路径，将 windows 反斜杠统一转换为正斜杠
    vault_path = vault_path.replace("\\", "/")
    
    # 1. 初始化并连接本地 MCP (通过 npx 后台 stdio 通道)
    logger.info(f"📂 [MCP 归档] 正在通过 npx 启动 filesystem MCP, 路径: {vault_path}")
    mcp_client = MultiServerMCPClient({
        "obsidian_vault": {
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", vault_path]
        }
    })
    
    try:
        # 获取 MCP 暴露出的标准文件操作工具
        tools = await mcp_client.get_tools()
        
        # 寻找 write_file 工具
        write_file_tool = next((t for t in tools if "write_file" in t.name), None)
        if not write_file_tool:
            raise Exception("未能从 @modelcontextprotocol/server-filesystem 检索到 write_file 工具")
            
        # 2. 图像资产提取与转换为相对路径
        content = request.draft
        
        # 查找所有形如 `data:image/png;base64,...` 的图片数据
        # 匹配模式: ![描述](data:image/png;base64,编码内容)
        img_pattern = r'!\[([^\]]*)\]\(data:image/([a-zA-Z]+);base64,([a-zA-Z0-9\+/=\s]+)\)'
        
        for match in re.finditer(img_pattern, content):
            alt_text = match.group(1) or "chart"
            ext = match.group(2) or "png"
            b64_data = match.group(3).strip()
            
            try:
                # 字节解码
                img_bytes = base64.b64decode(b64_data)
                
                # 基于内容 MD5 作为唯一文件名，防止重复拷贝
                md5_hash = hashlib.md5(img_bytes).hexdigest()
                filename = f"chart_{md5_hash}.{ext}"
                
                # 安全物理写入到 Obsidian attachments
                attachments_dir = os.path.join(vault_path, "attachments")
                os.makedirs(attachments_dir, exist_ok=True)
                dest_path = os.path.join(attachments_dir, filename)
                
                with open(dest_path, "wb") as f:
                    f.write(img_bytes)
                
                # 替换链接为 Obsidian 的本地相对路径，如 `./attachments/filename.png`
                old_ref = match.group(0)
                new_ref = f"![{alt_text}](./attachments/{filename})"
                content = content.replace(old_ref, new_ref)
                
                logger.info(f"💾 [MCP 归档] 成功解码并拷贝图表: attachments/{filename}")
                
            except Exception as e_img:
                logger.warning(f"⚠️ 提取图片 Base64 失败: {e_img}")
                
        # 3. 使用 MCP 工具写盘 Markdown 研报
        # 确保 DeeperResearch 归档目录存在
        target_dir = os.path.abspath(os.path.join(vault_path, "DeeperResearch"))
        os.makedirs(target_dir, exist_ok=True)
        
        # 规避文件名中的非法字符
        safe_topic = re.sub(r'[\/\\\:\*\?\"\<\>\|]', '_', request.topic)
        
        # 生成绝对路径并防御路径穿越
        archive_file_path = os.path.abspath(os.path.join(target_dir, f"{safe_topic}.md"))
        
        # 路径规范化校验，确保不会穿透到 target_dir 之外
        target_dir_str = target_dir.replace("\\", "/")
        archive_file_path_str = archive_file_path.replace("\\", "/")
        if not archive_file_path_str.startswith(target_dir_str):
            raise HTTPException(status_code=400, detail="非法的归档路径：检测到潜在的路径穿越尝试")
            
        logger.info(f"💾 [MCP 归档] 正在调用 MCP write_file 写入绝对路径: {archive_file_path_str}")
        res = await write_file_tool.ainvoke({
            "path": archive_file_path_str,
            "content": content
        })
        
        # 解析 MCP 返回值，强校验是否发生权限拒绝或写入错误
        if isinstance(res, list) and len(res) > 0:
            res_text = res[0].get("text", "")
            if "Access denied" in res_text or "error" in res_text.lower():
                raise Exception(f"MCP 服务端拒绝写入: {res_text}")
            elif "Successfully wrote" not in res_text:
                logger.warning(f"MCP write_file 提示未知结果: {res_text}")
        
        logger.info(f"🎉 [MCP 归档] 归档完成: {archive_file_path_str}")
        return {"status": "success", "file_path": archive_file_path_str}
        
    except Exception as e:
        logger.error(f"❌ [MCP 归档] 异常: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Obsidian 归档失败: {str(e)}")
        
    finally:
        # 释放 MCP 管道资源，防止僵尸 Node.js 进程堆积
        try:
            if hasattr(mcp_client, "aclose"):
                await mcp_client.aclose()
            elif hasattr(mcp_client, "close"):
                if asyncio.iscoroutinefunction(mcp_client.close):
                    await mcp_client.close()
                else:
                    mcp_client.close()
        except Exception as e_close:
            logger.warning(f"⚠️ 关闭 MCP 客户端资源失败: {e_close}")


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
