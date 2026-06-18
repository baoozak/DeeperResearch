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
from .tools import web_search
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
    并优先应用前端传来的临时配置进行覆盖。
    """
    from ..config import temp_api_key, temp_base_url, temp_model, get_settings
    settings = get_settings()
    
    api_key = temp_api_key.get() or settings.openai_api_key
    base_url = temp_base_url.get() or settings.openai_base_url
    model_name = temp_model.get() or settings.model_name

    return ChatOpenAI(
        model=model_name,
        temperature=settings.temperature,
        api_key=api_key,
        base_url=base_url,
        timeout=300,  # 增加 5 分钟超时，确保长研报顺利生成完成
        max_retries=0,  # 超时直接断开并不进行二次重试，防止浪费重复等待时间
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


def _parse_structured_json(content: str) -> dict:
    """
    稳健的结构化 JSON 提取器。
    支持 ```json ... ``` 块包裹、``` ... ``` 包裹、以及直接定位第一个 '{' 和最后一个 '}' 匹配块。
    """
    content = content.strip()
    if "```json" in content:
        try:
            content_part = content.split("```json", 1)[1].split("```", 1)[0].strip()
            return json.loads(content_part)
        except Exception:
            pass
    elif "```" in content:
        try:
            content_part = content.split("```", 1)[1].split("```", 1)[0].strip()
            return json.loads(content_part)
        except Exception:
            pass
            
    # 尝试寻找首个 { 和最末个 } 匹配包裹
    start_idx = content.find("{")
    end_idx = content.rfind("}")
    if start_idx != -1 and end_idx != -1:
        try:
            return json.loads(content[start_idx:end_idx + 1])
        except Exception:
            pass
            
    return json.loads(content)


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

    # 一次 API 调用 = 搜索 + 理解 + 摘要 (根据用户选择的搜索引擎分发)
    search_engine = state.get("search_engine", "domestic")
    triage_context, sources = await web_search(
        query=TRIAGE_USER.format(topic=topic),
        system_prompt=TRIAGE_SYSTEM,
        search_engine=search_engine,
        search_strategy="max",
        search_keywords=topic,  # DDG 用纯关键词而非完整 prompt
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

    all_sources = [
        {"title": s.title, "url": s.url, "snippet": s.snippet}
        for s in sources if s.url
    ]

    return {
        "triage_context": triage_context,
        "current_phase": "triage",
        "sources": all_sources,
        "phase_events": [
            _make_event("triage", f"哨兵侦察完成: 获取到 {len(all_sources)} 条最新情报"),
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
    from ..config import temp_max_sub_tasks
    settings = get_settings()
    llm = _get_llm()
    topic = state.get("topic", "")

    logger.info(f"📋 Orchestrator 开始规划: {topic}")

    max_sub = temp_max_sub_tasks.get() or settings.max_sub_tasks
    system_prompt = ORCHESTRATOR_SYSTEM.format(max_sub_tasks=max_sub)

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

    # 构建用户上传材料块
    uploaded_context = state.get("uploaded_context", "")
    uploaded_block = ""
    if uploaded_context:
        uploaded_block = f"\n## 用户上传的参考材料:\n{uploaded_context}\n\n请参考以上用户提供的材料，在拆解子任务时侧重分析材料中的内容 and 主题。\n"

    user_prompt = ORCHESTRATOR_USER_INITIAL.format(
        topic=topic,
        max_sub_tasks=max_sub,
        requirements_block=requirements_block,
    ) + context_block + uploaded_block

    try:
        structured_llm = llm.with_structured_output(PlanOutput)
        result: PlanOutput = await structured_llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
        sub_tasks = result.sub_tasks[:max_sub]
        reasoning = result.reasoning
    except Exception as e:
        logger.warning(f"结构化输出失败，回退到文本解析: {e}")
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
    from ..config import temp_max_search_review_retries
    settings = get_settings()
    llm = _get_llm()
    sub_task = state.get("sub_task", "")
    topic = state.get("topic", "")
    max_retries = temp_max_search_review_retries.get() or settings.max_search_review_retries


    logger.info(f"🔍 Search Agent 启动: {sub_task}")

    current_query = sub_task
    tombstones: list[dict] = []  # 局部认知墓碑列表，记录当前任务下的失败历史
    all_events: list[dict] = []
    all_sources: list[dict] = []
    summary = ""

    for attempt in range(max_retries + 1):  # 首次 + 重试次数
        # 组装失败路径墓碑，注入给总结大模型做避障防踩坑指示
        tombstones_prompt = ""
        if tombstones:
            tombstones_prompt = "\n\n## 避障防踩坑指示 (已探明的失败历史轨迹/Tombstones):\n"
            for idx, tb in enumerate(tombstones):
                tombstones_prompt += f"### 失败轨迹 {idx+1}:\n"
                tombstones_prompt += f"- **已尝试的检索词/方向**: {tb['query']}\n"
                tombstones_prompt += f"- **被审查驳回的原因**: {tb['reason']}\n"
                tombstones_prompt += f"- **先前获取的总结(被判无效)**:\n{tb['summary'][:300]}...\n\n"
            tombstones_prompt += "⚠️ 请严格保证：本次回答必须采用与上述失败轨迹截然不同的角度或新增更有深度的数据，解决被拒理由。不要重复之前已判无效的内容或空话！\n"

        # ===== Step 1: 搜索 + 总结 (一体化) =====
        # 一次 API 调用完成: 云端搜索 → 模型理解 → 结构化总结
        user_prompt = SEARCH_SUMMARIZER_USER.format(
            sub_task=current_query,
            topic=topic,
        )
        if tombstones_prompt:
            user_prompt += tombstones_prompt

        summary, sources_extracted = await web_search(
            query=user_prompt,
            system_prompt=SEARCH_SUMMARIZER_SYSTEM,
            search_engine=state.get("search_engine", "domestic"),
            search_strategy="max",
            search_keywords=current_query,  # DDG 用纯关键词而非完整 prompt
        )

        if not summary:
            logger.warning(f"⚠️ 搜索无结果 (尝试 {attempt + 1}): {current_query}")
            all_events.append(_make_event("searching", f"搜索无结果 (尝试 {attempt + 1}): {current_query}"))
            if attempt < max_retries:
                # 记录这次的空搜索墓碑
                tombstones.append({
                    "query": current_query,
                    "reason": "网页检索无结果或内容全空",
                    "summary": "未获得任何实质性网页信息。"
                })
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
            tombstones_review_prompt = ""
            if tombstones:
                tombstones_review_prompt = "\n\n## 历史被拒轨迹对比 (Tombstones):\n"
                for idx, tb in enumerate(tombstones):
                    tombstones_review_prompt += f"### 失败记录 {idx+1}:\n"
                    tombstones_review_prompt += f"- **检索方向**: {tb['query']}\n"
                    tombstones_review_prompt += f"- **先前被驳回原因**: {tb['reason']}\n"
                    tombstones_review_prompt += f"- **先前版本的总结草案**:\n{tb['summary'][:200]}...\n\n"
                tombstones_review_prompt += "\n⚠️ 【质量核对指示】：请将当前新总结与上述历史被拒记录进行比对。如果发现新总结内容大同小异、并未切实解决之前的被拒原因（如仍然缺乏数据证据、依然空洞等），请继续判定 verdict = 'FAIL'，并务必提供一个方向全新、具有强烈差异化特征的新搜索关键词！\n"

            try:
                structured_review = llm.with_structured_output(SearchReviewOutput)
                review: SearchReviewOutput = await structured_review.ainvoke([
                    SystemMessage(content=SEARCH_REVIEW_SYSTEM),
                    HumanMessage(content=SEARCH_REVIEW_USER.format(
                        sub_task=sub_task,
                        topic=topic,
                        summary=summary,
                    ) + tombstones_review_prompt),
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
                        ) + tombstones_review_prompt),
                    ])
                    data = _parse_structured_json(review_response.content)
                    verdict = data.get("verdict", "PASS").upper()
                    reason = data.get("reason", "")
                    refined_query = data.get("refined_query", "")
                except Exception as ex:
                    raw_content = review_response.content if 'review_response' in locals() else "无"
                    logger.warning(f"终极审查解析失败: {ex}, 原文: {raw_content}")
                    verdict = "PASS"  # 审查失败时默认通过
                    reason = "审查解析失败，默认通过"
                    refined_query = ""

            if verdict == "PASS":
                logger.info(f"✅ Search Agent 审查通过: {sub_task}")
                all_events.append(_make_event("searching", f"质量审查 [{verdict}]: {reason}"))
                break
            else:
                # 审查失败，记录墓碑并使用优化后的关键词重搜
                tombstones.append({
                    "query": current_query,
                    "reason": reason,
                    "summary": summary
                })
                current_query = refined_query if refined_query else f"{sub_task} 最新数据"
                logger.info(f"🔄 Search Agent 审查不通过，重搜 (第 {attempt + 2} 次): {current_query}")
                # 清洗理由末尾多余的句号，解决双句号连击问题
                clean_reason = reason.rstrip("。").rstrip(".")
                all_events.append(_make_event(
                    "searching",
                    f"质量审查 [FAIL]: {clean_reason}。已建立认知墓碑 🪦 避障，尝试第 {attempt + 2} 次重搜，关键词: {current_query}"
                ))
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

    # 构建用户上传材料块
    uploaded_context = state.get("uploaded_context", "")
    uploaded_block = ""
    if uploaded_context:
        uploaded_block = f"\n## 用户上传的参考材料:\n{uploaded_context}\n\n请在报告中充分参考和引用以上用户提供的材料内容。\n"

    messages = [
        SystemMessage(content=SYNTHESIZER_SYSTEM),
        HumanMessage(content=SYNTHESIZER_USER.format(
            topic=topic,
            content_blocks=content_blocks,
            requirements_block=requirements_block,
        ) + uploaded_block),
    ]

    try:
        logger.info("📝 Synthesizer 模型调用...")
        response = await llm.ainvoke(messages)
        draft = response.content
        
        # 对大模型可能生成的带语法瑕疵的 Mermaid 图表进行后端自动纠错清洗，防止前端渲染报错
        try:
            logger.info("🛠️ 正在检查并自动修复研报中的 Mermaid 图表语法...")
            draft = repair_all_mermaids_in_text(draft)
            logger.info("✅ Mermaid 图表语法自动修复完成！")
        except Exception as ex_m:
            logger.error(f"⚠️ Mermaid 语法自动修复抛出异常 (已忽略): {ex_m}")
                
    except Exception as e:
        logger.error(f"❌ 报告撰写失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        draft = f"# {topic}\n\n> ⚠️ 报告生成过程中发生错误: {str(e)}\n\n## 原始调研资料\n\n{content_blocks}"


    logger.info(f"📝 Synthesizer 完成: 报告长度 {len(draft)} 字符")

    return {
        "draft": draft,
        "current_phase": "synthesizing",
        "phase_events": [
            _make_event("synthesizing", f"报告撰写完成 (长度: {len(draft)} 字符)"),
        ],
    }


def repair_mermaid(mermaid_code: str) -> str:
    """
    对大模型生成的 Mermaid 图表代码进行自动语法修复。
    解决最常见的几种 Mermaid 语法崩溃问题：
    1. 连线两端的节点 ID 包含空格或特殊字符 (例如: Claude Fable 5 --> Opus 4.8)。
    2. 节点内的文本包含特殊符号 (如冒号、问号、括号、斜杠等) 且未被双引号包裹。
    3. 连线箭头写错 (如 -> 代替 -->，或 => 代替 ==>)。
    """
    import re
    lines = mermaid_code.split("\n")
    cleaned_lines = []
    
    # 已声明/已处理的合规节点ID集合
    declared_ids = set()
    
    def sanitize_id(raw_id: str) -> str:
        raw_id = raw_id.strip()
        if not raw_id:
            return ""
        # 移除任何可能误加的引号
        clean = re.sub(r'[^a-zA-Z0-9_\u4e00-\u9fff-]', '_', raw_id)
        clean = re.sub(r'_+', '_', clean).strip('_')
        return clean if clean else "node"

    for line in lines:
        stripped = line.strip()
        if not stripped or any(stripped.startswith(x) for x in ["graph ", "flowchart ", "subgraph ", "end ", "%%"]):
            if stripped in ["graph TD", "graph LR", "flowchart TD", "flowchart LR"]:
                cleaned_lines.append(stripped)
            else:
                cleaned_lines.append(line)
            continue
            
        # 1. 临时保护连线上的描述文字，形如 -->|文字|
        labels = []
        def label_repl(match):
            labels.append(match.group(0))
            return f"__LABEL_HOLDER_{len(labels)-1}__"
        
        temp_line = re.sub(r'\|[^|]+\|', label_repl, stripped)
        
        # 保护 -- 文字 --> 这种形式，统一转换为 -->__LABEL_HOLDER_X__
        def edge_repl(match):
            text = match.group(1)
            labels.append(f"|{text}|")
            return f"-->__LABEL_HOLDER_{len(labels)-1}__"
        temp_line = re.sub(r'--\s*([^-<>]+?)\s*-->', edge_repl, temp_line)

        # 2. 规范化其他的连接符
        temp_line = re.sub(r'(?<!-)->(?!>)', '-->', temp_line)
        temp_line = re.sub(r'(?<!=)=>(?!>)', '==>', temp_line)

        # 3. 按照连接符号拆分
        connection_pattern = r'(\-\-\>__LABEL_HOLDER_\d+__|==\>__LABEL_HOLDER_\d+__|\-\.\-\>__LABEL_HOLDER_\d+__|\-\-\>|==\>|\-\.\-\>)'
        parts = re.split(connection_pattern, temp_line)
        
        new_parts = []
        for i, part in enumerate(parts):
            part_strip = part.strip()
            if i % 2 == 0:  # 节点部分
                if not part_strip:
                    new_parts.append(part)
                    continue
                
                # 寻找括号描述，形如 A[文字] 或 A((文字)) 等，支持多重嵌套括号与内部小括号
                first_bracket = -1
                bracket_type = ""
                for b in ['((', '([', '[[', '[(', '[', '(', '{', '{{']:
                    idx = part_strip.find(b)
                    if idx != -1 and (first_bracket == -1 or idx < first_bracket):
                        first_bracket = idx
                        bracket_type = b
                
                if first_bracket != -1:
                    node_id = part_strip[:first_bracket].strip()
                    clean_id = sanitize_id(node_id)
                    closing_map = {
                        '((': '))',
                        '([': '])',
                        '[[': ']]',
                        '[(': ')]',
                        '[': ']',
                        '(': ')',
                        '{': '}',
                        '{{': '}}'
                    }
                    close_bracket = closing_map[bracket_type]
                    content_start = first_bracket + len(bracket_type)
                    content_end = part_strip.rfind(close_bracket)
                    
                    if content_end != -1:
                        node_text = part_strip[content_start:content_end].strip()
                        if not (node_text.startswith('"') and node_text.endswith('"')):
                            node_text = node_text.replace('"', '\\"')
                            node_text = f'"{node_text}"'
                        new_parts.append(f'{clean_id}{bracket_type}{node_text}{close_bracket}')
                        declared_ids.add(clean_id)
                    else:
                        new_parts.append(part_strip)
                else:
                    # 纯节点 ID，可能包含空格或特殊字符
                    if not part_strip.isalnum() and part_strip not in declared_ids:
                        clean_id = sanitize_id(part_strip)
                        if clean_id not in declared_ids:
                            # 回填 label 占位符供展示
                            display_text = part_strip
                            for l_idx, lbl in enumerate(labels):
                                display_text = display_text.replace(f"__LABEL_HOLDER_{l_idx}__", lbl)
                            new_parts.append(f'{clean_id}["{display_text}"]')
                            declared_ids.add(clean_id)
                        else:
                            new_parts.append(clean_id)
                    else:
                        new_parts.append(sanitize_id(part_strip))
            else:  # 连线符号部分，回填 label
                connection = part_strip
                for l_idx, lbl in enumerate(labels):
                    connection = connection.replace(f"__LABEL_HOLDER_{l_idx}__", lbl)
                new_parts.append(connection)
                
        # 还原缩进，默认加 4 空格
        leading_spaces = len(line) - len(line.lstrip())
        indent = " " * leading_spaces if leading_spaces > 0 else "    "
        cleaned_lines.append(indent + "".join(new_parts))
                
    return "\n".join(cleaned_lines)


def repair_all_mermaids_in_text(text: str) -> str:
    """
    抓取文本中所有的 ```mermaid 代码块，并进行语法修复
    """
    import re
    def repl(match):
        code = match.group(1)
        repaired = repair_mermaid(code)
        return f"```mermaid\n{repaired}\n```"
        
    return re.sub(r'```mermaid(.*?)```', repl, text, flags=re.DOTALL)

