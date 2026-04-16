"""
Agent 节点模块。
定义了研究图中所有 Agent 节点的核心逻辑:
- triage_node: 哨兵侦察员 — 预搜索获取时效性上下文
- orchestrator_node: 规划师 — 将课题拆解为子任务
- search_worker_node: 自纠错搜索智能体 — 搜索→审查→重搜循环
- synthesizer_node: 综合撰稿人 — 汇总结果撰写报告

设计特点:
- 全部异步节点，兼容 LangGraph 的 ainvoke
- 使用结构化输出 (JSON) 替代自由文本解析
- Search Worker 内嵌质量审查循环，即时纠错
- 完善的异常处理和日志记录
- 每个节点都会记录阶段事件 (phase_events)，供前端实时展示
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from ..config import get_settings
from .state import ResearchState, SearchWorkerInput
from .tools import web_search_llm
from .prompts import (
    TRIAGE_SYSTEM,
    TRIAGE_USER,
    ORCHESTRATOR_SYSTEM,
    ORCHESTRATOR_USER_INITIAL,
    SEARCH_SUMMARIZER_SYSTEM,
    SEARCH_SUMMARIZER_USER,
    SYNTHESIZER_SYSTEM,
    SYNTHESIZER_USER,
    SEARCH_REVIEW_SYSTEM,
    SEARCH_REVIEW_USER,
)

logger = logging.getLogger(__name__)


# ============================================================================
# LLM 工厂函数 (延迟初始化，避免模块加载时崩溃)
# ============================================================================

def _get_llm() -> ChatOpenAI:
    """
    创建 LLM 实例。使用工厂函数而非全局变量，
    确保在配置加载完成后才初始化。
    """
    settings = get_settings()
    return ChatOpenAI(
        model=settings.model_name,
        temperature=settings.temperature,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )


def _make_event(phase: str, message: str) -> dict:
    """创建阶段事件日志条目"""
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "phase": phase,
        "message": message,
    }


# ============================================================================
# 结构化输出模型 (用于 LLM 的 JSON 输出解析)
# ============================================================================

class PlanOutput(BaseModel):
    """Orchestrator 的结构化输出"""
    reasoning: str = Field(description="规划思路和拆解逻辑")
    sub_tasks: list[str] = Field(description="3-5 个具体的子研究任务")


class SearchReviewOutput(BaseModel):
    """搜索结果质量审查的结构化输出"""
    verdict: str = Field(description="审查结论: PASS 或 FAIL")
    reason: str = Field(description="一句话判定理由")
    refined_query: str = Field(default="", description="如果 FAIL，优化后的搜索关键词")


# ============================================================================
# TRIAGE NODE (哨兵/破冰侦察员)
# ============================================================================

async def triage_node(state: ResearchState) -> dict[str, Any]:
    """
    哨兵 Agent:
    - 作为图的第一个节点，在 Orchestrator 之前执行
    - 使用 DashScope enable_search 一次调用完成搜索 + 时效性摘要提炼
    - 将摘要写入 triage_context，供 Orchestrator 参考
    
    目的: 消除 LLM 因知识截断导致的规划幻觉
    """
    topic = state.get("topic", "")

    logger.info(f"🔭 Triage 哨兵启动: 预搜索 '{topic}'")

    # 一次 API 调用 = 搜索 + 理解 + 摘要 (阿里云云端搜索，国内零网络问题)
    triage_context, sources = await web_search_llm(
        query=TRIAGE_USER.format(topic=topic),
        system_prompt=TRIAGE_SYSTEM,
        search_strategy="max",
    )

    if not triage_context:
        logger.warning("⚠️ Triage 联网搜索无结果，跳过上下文注入")
        return {
            "triage_context": "",
            "current_phase": "triage",
            "phase_events": [
                _make_event("triage", "哨兵预搜索未获取到结果，将直接进入规划阶段"),
            ],
        }

    logger.info(f"🔭 Triage 完成: 提炼出 {len(triage_context)} 字的背景摘要 ({len(sources)} 个来源)")

    return {
        "triage_context": triage_context,
        "current_phase": "triage",
        "phase_events": [
            _make_event("triage", f"哨兵侦察完成: 获取到 {len(sources)} 条最新情报"),
        ],
    }


# ============================================================================
# ORCHESTRATOR NODE (规划师)
# ============================================================================

async def orchestrator_node(state: ResearchState) -> dict[str, Any]:
    """
    规划师 Agent:
    将宽泛课题拆解为 3-5 个子研究任务。
    首次规划时注入哨兵收集的时效性上下文，避免幻觉。
    """
    settings = get_settings()
    llm = _get_llm()
    topic = state.get("topic", "")

    logger.info(f"📋 Orchestrator 开始规划: {topic}")

    system_prompt = ORCHESTRATOR_SYSTEM.format(max_sub_tasks=settings.max_sub_tasks)

    # 注入哨兵收集的时效性上下文
    triage_context = state.get("triage_context", "")
    context_block = ""
    if triage_context:
        context_block = f"\n\n## 最新背景情报 (由哨兵侦察员提供):\n{triage_context}\n\n请务必参考以上最新情报来制定调研计划，避免基于过时信息做出错误判断。"
    
    # 构建用户要求块
    user_requirements = state.get("user_requirements", "")
    requirements_block = ""
    if user_requirements:
        requirements_block = f"\n## 用户的详细要求:\n{user_requirements}\n\n请务必根据以上用户要求来侧重拆解子任务的方向和内容。\n"
    else:
        requirements_block = "\n"

    user_prompt = ORCHESTRATOR_USER_INITIAL.format(
        topic=topic,
        max_sub_tasks=settings.max_sub_tasks,
        requirements_block=requirements_block,
    ) + context_block

    try:
        structured_llm = llm.with_structured_output(PlanOutput)
        result: PlanOutput = await structured_llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
        sub_tasks = result.sub_tasks[:settings.max_sub_tasks]
        reasoning = result.reasoning
    except Exception as e:
        logger.warning(f"结构化输出失败，回退到文本解析: {e}")
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

    logger.info(f"📋 Orchestrator 生成 {len(sub_tasks)} 个子任务: {sub_tasks}")

    return {
        "sub_tasks": sub_tasks,
        "current_phase": "planning",
        "phase_events": [
            _make_event("planning", f"规划完成: 生成 {len(sub_tasks)} 个子任务 ({reasoning})"),
        ],
    }


# ============================================================================
# SEARCH WORKER NODE (搜索专员)
# ============================================================================

async def search_worker_node(state: SearchWorkerInput) -> dict[str, Any]:
    """
    自纠错搜索智能体:
    - 通过 Send() 并行派发，每个实例处理一个子任务
    - 使用 DashScope enable_search 一次调用完成搜索 + 总结
    - 内部循环: 搜索+总结(一体化) → 审查质量 → (不合格则优化关键词重搜)
    - 最多重试 max_search_review_retries 次
    
    输入: SearchWorkerInput (由 Send 传入)
    输出: 累加到 ResearchState.research_results 和 sources
    """
    settings = get_settings()
    llm = _get_llm()
    sub_task = state.get("sub_task", "")
    topic = state.get("topic", "")
    max_retries = settings.max_search_review_retries

    logger.info(f"🔍 Search Agent 启动: {sub_task}")

    current_query = sub_task
    all_events: list[dict] = []
    all_sources: list[dict] = []
    summary = ""

    for attempt in range(max_retries + 1):  # 首次 + 重试次数
        # ===== Step 1: 搜索 + 总结 (一体化) =====
        # 一次 API 调用完成: 云端搜索 → 模型理解 → 结构化总结
        user_prompt = SEARCH_SUMMARIZER_USER.format(
            sub_task=current_query,
            topic=topic,
        )
        summary, sources_extracted = await web_search_llm(
            query=user_prompt,
            system_prompt=SEARCH_SUMMARIZER_SYSTEM,
            search_strategy="max",
        )

        if not summary:
            logger.warning(f"⚠️ 搜索无结果 (尝试 {attempt + 1}): {current_query}")
            all_events.append(_make_event("searching", f"搜索无结果 (尝试 {attempt + 1}): {current_query}"))
            if attempt < max_retries:
                current_query = f"{topic} {sub_task}"
                continue
            else:
                return {
                    "research_results": [{
                        "sub_task": sub_task,
                        "content": f"搜索未找到关于 '{sub_task}' 的相关结果。",
                        "source_count": 0,
                    }],
                    "sources": [],
                    "phase_events": all_events + [_make_event("searching", f"搜索最终无结果: {sub_task}")],
                }

        # 收集来源
        all_sources = [
            {"title": s.title, "url": s.url, "snippet": s.snippet}
            for s in sources_extracted
            if s.url
        ]

        all_events.append(_make_event("searching", f"搜索+总结完成 (尝试 {attempt + 1}): {current_query} ({len(all_sources)} 个来源)"))

        # ===== Step 2: 内部质量审查 =====
        if attempt < max_retries:  # 最后一次跳过审查，直接使用
            try:
                structured_review = llm.with_structured_output(SearchReviewOutput)
                review: SearchReviewOutput = await structured_review.ainvoke([
                    SystemMessage(content=SEARCH_REVIEW_SYSTEM),
                    HumanMessage(content=SEARCH_REVIEW_USER.format(
                        sub_task=sub_task,
                        topic=topic,
                        summary=summary,
                    )),
                ])
                verdict = review.verdict.upper()
                reason = review.reason
                refined_query = review.refined_query
            except Exception as e:
                logger.warning(f"审查结构化输出失败，回退到文本解析: {e}")
                try:
                    review_response = await llm.ainvoke([
                        SystemMessage(content=SEARCH_REVIEW_SYSTEM),
                        HumanMessage(content=SEARCH_REVIEW_USER.format(
                            sub_task=sub_task,
                            topic=topic,
                            summary=summary,
                        )),
                    ])
                    data = json.loads(review_response.content)
                    verdict = data.get("verdict", "PASS").upper()
                    reason = data.get("reason", "")
                    refined_query = data.get("refined_query", "")
                except Exception:
                    verdict = "PASS"  # 审查失败时默认通过
                    reason = "审查解析失败，默认通过"
                    refined_query = ""

            all_events.append(_make_event("searching", f"质量审查 [{verdict}]: {reason}"))

            if verdict == "PASS":
                logger.info(f"✅ Search Agent 审查通过: {sub_task}")
                break
            else:
                # 审查失败，使用优化后的关键词重搜
                current_query = refined_query if refined_query else f"{sub_task} 最新数据"
                logger.info(f"🔄 Search Agent 审查不通过，重搜 (第 {attempt + 2} 次): {current_query}")
                all_events.append(_make_event("searching", f"重搜关键词: {current_query}"))
                continue

    logger.info(f"✅ Search Agent 完成: {sub_task} ({len(all_sources)} 个来源)")

    return {
        "research_results": [{
            "sub_task": sub_task,
            "content": summary,
            "source_count": len(all_sources),
        }],
        "sources": all_sources,
        "phase_events": all_events,
    }


# ============================================================================
# SYNTHESIZER NODE (综合撰稿人)
# ============================================================================

async def synthesizer_node(state: ResearchState) -> dict[str, Any]:
    """
    综合撰稿人 Agent:
    - 等待所有 Search Worker 完成后汇总结果
    - 使用结构化报告模板撰写深度研究报告
    """
    llm = _get_llm()
    topic = state.get("topic", "")
    results = state.get("research_results", [])
    sources = state.get("sources", [])

    logger.info(f"📝 Synthesizer 开始撰写报告: {topic} ({len(results)} 条调研结果)")

    if not results:
        return {
            "draft": f"# {topic}\n\n> ⚠️ 未获取到任何调研资料，无法生成报告。",
            "current_phase": "synthesizing",
            "phase_events": [
                _make_event("synthesizing", "调研结果为空，无法撰写报告"),
            ],
        }

    # 组装调研资料
    content_blocks = "\n\n---\n\n".join([
        f"### 子任务: {r['sub_task']}\n\n{r['content']}"
        for r in results
    ])

    # 附加来源列表供撰稿人引用
    if sources:
        source_list = "\n".join([
            f"- [{s.get('title', '未知来源')}]({s.get('url', '')})"
            for s in sources
        ])
        content_blocks += f"\n\n---\n\n### 所有来源汇总\n{source_list}"

    # 构建用户要求块
    user_requirements = state.get("user_requirements", "")
    requirements_block = ""
    if user_requirements:
        requirements_block = f"\n## 用户的详细要求 (必须严格遵守):\n{user_requirements}\n\n"
    else:
        requirements_block = "\n"

    try:
        response = await llm.ainvoke([
            SystemMessage(content=SYNTHESIZER_SYSTEM),
            HumanMessage(content=SYNTHESIZER_USER.format(
                topic=topic,
                content_blocks=content_blocks,
                requirements_block=requirements_block,
            )),
        ])
        draft = response.content
    except Exception as e:
        logger.error(f"❌ 报告撰写失败: {e}")
        draft = f"# {topic}\n\n> ⚠️ 报告生成过程中发生错误: {str(e)}\n\n## 原始调研资料\n\n{content_blocks}"

    logger.info(f"📝 Synthesizer 完成: 报告长度 {len(draft)} 字符")

    return {
        "draft": draft,
        "current_phase": "synthesizing",
        "phase_events": [
            _make_event("synthesizing", f"报告撰写完成 (长度: {len(draft)} 字符)"),
        ],
    }
