"""
LangGraph 工作流构建模块。
组装所有节点和边，构建完整的多 Agent 研究图。

核心特性:
- Send() API 实现并行 Map-Reduce 搜索
- 每个 Search Worker 内嵌质量审查循环，即时自纠错
- MemorySaver Checkpointer 支持状态持久化和时间旅行
- 线性流程: 哨兵 → 规划 → 并发搜索(含审查) → 综合撰稿 → 完成
"""

import logging

from langgraph.graph import StateGraph, START, END
from langgraph.constants import Send
from langgraph.checkpoint.memory import MemorySaver

from .state import ResearchState, SearchWorkerInput
from .nodes import (
    triage_node,
    orchestrator_node,
    search_worker_node,
    synthesizer_node,
)

logger = logging.getLogger(__name__)


# ============================================================================
# 阶段标记节点 (极速节点，瞬间推送状态给前端，避免 LLM 耗时造成界面滞后)
# ============================================================================

def mark_triage(state: ResearchState) -> dict: return {"current_phase": "triage"}
def mark_planning(state: ResearchState) -> dict: return {"current_phase": "planning"}
def mark_searching(state: ResearchState) -> dict: 
    return {"current_phase": "searching", "phase_events": [{"timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "phase": "searching", "message": f"开始派发 {len(state.get('sub_tasks', []))} 个并发搜索 (每个搜索含内部质量审查)..."}]}
def mark_synthesizing(state: ResearchState) -> dict: return {"current_phase": "synthesizing"}


# ============================================================================
# 条件边函数
# ============================================================================

def initiate_parallel_search(state: ResearchState) -> list[Send]:
    """
    Map 操作: 根据 sub_tasks 列表，通过 Send() 启动并行 Search Worker。
    每个 Worker 内部包含自纠错循环（搜索→审查→重搜）。
    """
    sub_tasks = state.get("sub_tasks", [])
    topic = state.get("topic", "")

    logger.info(f"🚀 并行派发 {len(sub_tasks)} 个自纠错搜索任务")

    return [
        Send("search_worker", {"sub_task": task, "topic": topic})
        for task in sub_tasks
    ]


# ============================================================================
# 图构建
# ============================================================================

def create_research_graph():
    """
    构建完整的 LangGraph 研究工作流。

    图结构 (线性，审查内嵌于搜索):
        START
          ↓
        mark_triage → triage (哨兵: 预搜索获取时效性上下文)
          ↓
        mark_planning → orchestrator (规划师: 拆解子任务)
          ↓
        mark_searching → search_worker ×N (并发自纠错搜索智能体)
          ↓ (全部完成后)
        mark_synthesizing → synthesizer (综合撰稿人)
          ↓
        END
    """
    builder = StateGraph(ResearchState)

    # ===== 添加核心节点 =====
    builder.add_node("triage", triage_node)
    builder.add_node("orchestrator", orchestrator_node)
    builder.add_node("search_worker", search_worker_node)
    builder.add_node("synthesizer", synthesizer_node)

    # ===== 添加标记节点 =====
    builder.add_node("mark_triage", mark_triage)
    builder.add_node("mark_planning", mark_planning)
    builder.add_node("mark_searching", mark_searching)
    builder.add_node("mark_synthesizing", mark_synthesizing)

    # ===== 构建边 =====

    builder.add_edge(START, "mark_triage")
    builder.add_edge("mark_triage", "triage")

    builder.add_edge("triage", "mark_planning")
    builder.add_edge("mark_planning", "orchestrator")

    builder.add_edge("orchestrator", "mark_searching")

    # 并发派发自纠错搜索智能体
    builder.add_conditional_edges("mark_searching", initiate_parallel_search, ["search_worker"])

    # 所有搜索完成后汇聚到综合撰稿
    builder.add_edge("search_worker", "mark_synthesizing")
    builder.add_edge("mark_synthesizing", "synthesizer")

    # 撰稿完成 → 结束
    builder.add_edge("synthesizer", END)

    # ===== 编译图 =====
    memory = MemorySaver()
    graph = builder.compile(checkpointer=memory)

    logger.info("✅ LangGraph 研究工作流编译完成 (v3.0 — 审查前置化)")
    return graph


# 导出编译好的图实例
research_graph = create_research_graph()
