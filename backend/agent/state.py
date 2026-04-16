"""
LangGraph 状态定义模块。
定义了研究图的全局状态 (ResearchState) 和子任务独立状态 (SearchWorkerInput)。

核心设计:
- 使用 Annotated[list, operator.add] 实现并行节点结果的自动累加
- 使用 phase_events 记录各阶段事件日志，供前端实时展示
- SearchWorkerInput 是 Send() 派发给 Search Worker 的独立输入
"""

from typing import TypedDict, Annotated, Literal
import operator


class ResearchState(TypedDict):
    """
    研究图的全局状态。
    所有节点通过读写此状态进行通信。
    """
    # ===== 核心业务字段 =====
    topic: str                                          # 用户输入的研究课题
    sub_tasks: list[str]                                # Orchestrator 拆解出的子任务列表
    research_results: Annotated[list[dict], operator.add]  # 并发搜索结果 (自动累加合并)
    draft: str                                          # Synthesizer 生成的 Markdown 报告草稿

    # ===== 实时状态追踪 =====
    current_phase: str                                  # 当前执行阶段: planning/searching/synthesizing/reviewing/done
    phase_events: Annotated[list[dict], operator.add]   # 各阶段事件日志 [{timestamp, phase, message}]

    # ===== 来源管理 =====
    sources: Annotated[list[dict], operator.add]        # 收集的来源 [{title, url, snippet}]

    # ===== 哨兵侦察上下文 =====
    triage_context: str                                 # 哨兵节点预搜索收集的时效性上下文摘要

    # ===== 用户自定义要求 =====
    user_requirements: str                              # 用户提供的详细要求 (影响规划和撰稿)

    # ===== 错误处理 =====
    error: str                                          # 错误信息 (空字符串=正常)


class SearchWorkerInput(TypedDict):
    """
    通过 Send() 派发给 Search Worker 的独立输入。
    每个 Search Worker 接收单独的子任务和主题上下文。
    """
    sub_task: str          # 当前需要搜索的具体子任务
    topic: str             # 原始研究课题 (提供上下文，帮助搜索聚焦)
    user_requirements: str # 用户自定义要求 (透传，不影响搜索逻辑)
