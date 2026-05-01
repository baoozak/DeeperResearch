"""
搜索工具模块。
支持两种搜索引擎:
1. DashScope 联网搜索 (domestic) — 国内网络零障碍，搜索+LLM理解一体化
2. DuckDuckGo 搜索 (international) — 国际搜索引擎，需要代理/TUN

通过统一入口 web_search() 屏蔽差异，上层节点无需关心具体实现。
"""

import asyncio
import logging
import re
from typing import Optional

from openai import AsyncOpenAI
from pydantic import BaseModel

from ..config import get_settings

logger = logging.getLogger(__name__)


class SearchResult(BaseModel):
    """结构化搜索来源 (从模型响应文本中提取)"""
    title: str = ""
    snippet: str = ""
    url: str = ""


def _extract_sources_from_text(text: str) -> list[SearchResult]:
    """
    从模型响应文本中提取来源 URL。
    匹配三种常见模式:
    1. Markdown 链接: [标题](URL)
    2. 裸 URL: https://example.com/...
    3. 脚注引用: [^1]: URL
    """
    results = []
    seen_urls: set[str] = set()

    def _add_source(title: str, url: str, context: str = ""):
        """去重添加来源"""
        # 清理 URL 尾部常见杂字符
        url = url.rstrip(')],，。；、》」')
        if url and url not in seen_urls and url.startswith("http"):
            seen_urls.add(url)
            results.append(SearchResult(
                title=title or url.split("/")[2],  # 用域名作为默认标题
                snippet=context[:200] if context else "",
                url=url,
            ))

    # 模式 1: Markdown 链接 [标题](URL)
    for match in re.finditer(r'\[([^\]]+)\]\((https?://[^\s\)]+)\)', text):
        title, url = match.group(1), match.group(2)
        start = max(0, match.start() - 60)
        end = min(len(text), match.end() + 60)
        _add_source(title, url, text[start:end].strip())

    # 模式 2: 脚注格式 [^N]: URL
    for match in re.finditer(r'\[\^?\d+\]:\s*(https?://\S+)', text):
        _add_source("", match.group(1))

    # 模式 3: 裸 URL（不被 Markdown 链接包裹的）
    for match in re.finditer(r'(?<!\()(https?://[^\s\)>\]，。；]+)', text):
        url = match.group(1)
        start = max(0, match.start() - 60)
        end = min(len(text), match.end() + 60)
        _add_source("", url, text[start:end].strip())

    # 过滤: 移除"知识库"类内部参考（DashScope enable_search 的副作用）
    results = [r for r in results if not re.search(r'知识库[《]', r.title + r.snippet)]

    return results


def _get_search_client() -> AsyncOpenAI:
    """获取用于联网搜索的 AsyncOpenAI 客户端"""
    settings = get_settings()
    return AsyncOpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )


# ============================================================================
# DashScope 联网搜索 (国内) — 搜索+LLM理解一体化
# ============================================================================

async def _web_search_dashscope(
    query: str,
    system_prompt: str = "",
    search_strategy: str = "max",
) -> tuple[str, list[SearchResult]]:
    """
    阿里云 DashScope 联网搜索 + LLM 理解一体化。
    一次 API 调用 = 搜索 + 理解 + 摘要。

    Args:
        query: 用户提示词
        system_prompt: 系统提示词
        search_strategy: 搜索策略 ("turbo"=快速 / "max"=全面)

    Returns:
        (model_response_text, extracted_sources)
    """
    settings = get_settings()
    client = _get_search_client()

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": query})

    try:
        logger.info(f"🔍 [DashScope] 联网搜索: {query[:80]}...")

        response = await client.chat.completions.create(
            model=settings.model_name,
            messages=messages,
            temperature=settings.temperature,
            extra_body={
                "enable_search": True,
                "search_options": {
                    "forced_search": True,
                    "search_strategy": search_strategy,
                },
            },
        )

        content = response.choices[0].message.content or ""
        sources = _extract_sources_from_text(content)

        logger.info(f"✅ [DashScope] 搜索完成: {query[:50]}... ({len(sources)} 个来源)")
        return content, sources

    except Exception as e:
        logger.error(f"❌ [DashScope] 搜索失败: {e}")
        return "", []


# ============================================================================
# DuckDuckGo 搜索 (国际) — 关键词翻译 + 搜索 + LLM 总结 三步式
# ============================================================================

async def _translate_keywords_to_english(keywords: str) -> str:
    """
    轻量级关键词翻译: 中文 → 英文搜索关键词。
    用于确保 DDG 国际搜索能命中英文/国际来源。
    如果关键词已经是英文则直接返回。
    """
    # 快速检测: 如果没有中文字符，直接返回
    import re as _re
    if not _re.search(r'[\u4e00-\u9fff]', keywords):
        return keywords

    try:
        settings = get_settings()
        client = _get_search_client()
        response = await client.chat.completions.create(
            model=settings.model_name,
            messages=[
                {"role": "system", "content": "You are a search keyword translator. Translate the given Chinese search keywords into concise English search keywords. Output ONLY the English keywords, nothing else. Keep technical terms, product names, and proper nouns as-is."},
                {"role": "user", "content": keywords},
            ],
            temperature=0.1,
            max_tokens=100,
        )
        en = (response.choices[0].message.content or "").strip()
        return en if en else keywords
    except Exception as e:
        logger.warning(f"⚠️ 关键词翻译失败，使用原始关键词: {e}")
        return keywords

async def _web_search_duckduckgo(
    query: str,
    system_prompt: str = "",
    search_keywords: str = "",
    max_results: int = 5,
) -> tuple[str, list[SearchResult]]:
    """
    DuckDuckGo 搜索 + LLM 总结 (两步式)。
    Step 1: 调用 DuckDuckGo API 获取原始搜索结果 (使用 search_keywords)
    Step 2: 将结果喂给 LLM 做结构化总结 (使用 query 作为 LLM prompt)

    ⚠️ 需要能访问国际互联网 (代理/TUN)。

    Args:
        query: LLM 总结阶段的用户提示词 (完整的 prompt)
        system_prompt: LLM 总结的系统提示词
        search_keywords: DDG 实际搜索的关键词 (简短)，若为空则从 query 中提取
        max_results: 最大搜索结果数

    Returns:
        (llm_summary_text, extracted_sources)
    """
    from ddgs import DDGS

    settings = get_settings()
    sources: list[SearchResult] = []

    try:
        # ===== Step 0: 关键词翻译 (中文 → 英文) =====
        # 国际搜索的核心: 用英文关键词搜索，才能获取国际来源
        actual_keywords = search_keywords or query
        en_keywords = await _translate_keywords_to_english(actual_keywords)
        logger.info(f"🔍 [DuckDuckGo] 原始关键词: {actual_keywords[:60]} → 英文: {en_keywords[:60]}")

        # ===== Step 1: DuckDuckGo 搜索 =====
        # region='wt-wt' 表示全球无地区偏好
        loop = asyncio.get_event_loop()
        ddg_results = await loop.run_in_executor(
            None,
            lambda: DDGS().text(en_keywords, region='wt-wt', max_results=max_results)
        )

        if not ddg_results:
            logger.warning(f"⚠️ [DuckDuckGo] 搜索无结果: {en_keywords}")
            return "", []

        # 提取结构化来源
        sources = [
            SearchResult(
                title=r.get("title", ""),
                snippet=r.get("body", "")[:200],
                url=r.get("href", ""),
            )
            for r in ddg_results
            if r.get("href")
        ]

        # ===== Step 2: 将搜索结果喂给 LLM 做总结 =====
        # 拼装搜索结果为上下文
        search_context = "\n\n".join([
            f"### 来源 {i+1}: [{r.get('title', '未知')}]({r.get('href', '')})\n{r.get('body', '')}"
            for i, r in enumerate(ddg_results)
        ])

        llm_prompt = f"""以下是关于"{query}"的搜索结果，请基于这些搜索结果进行分析和总结。

## 搜索结果:
{search_context}

请基于以上搜索结果进行分析。⚠️ 每条要点后必须附上来源链接 URL。"""

        client = _get_search_client()
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": llm_prompt})

        response = await client.chat.completions.create(
            model=settings.model_name,
            messages=messages,
            temperature=settings.temperature,
        )

        content = response.choices[0].message.content or ""

        # 从 LLM 响应中额外提取来源（可能有 LLM 自己补充的）
        text_sources = _extract_sources_from_text(content)
        # 合并去重: DDG 原始来源 + LLM 响应中的来源
        seen_urls = {s.url for s in sources}
        for ts in text_sources:
            if ts.url not in seen_urls:
                sources.append(ts)
                seen_urls.add(ts.url)

        logger.info(f"✅ [DuckDuckGo] 搜索+总结完成: {query[:50]}... ({len(sources)} 个来源)")
        return content, sources

    except Exception as e:
        logger.error(f"❌ [DuckDuckGo] 搜索失败: {e}")
        return "", []


# ============================================================================
# 统一搜索入口
# ============================================================================

async def web_search(
    query: str,
    system_prompt: str = "",
    search_engine: str = "domestic",
    search_strategy: str = "max",
    search_keywords: str = "",
    max_results: int = 5,
) -> tuple[str, list[SearchResult]]:
    """
    统一搜索入口。根据 search_engine 分发到不同实现。

    Args:
        query: 搜索关键词/提示词 (对 DashScope 直接使用，对 DDG 作为 LLM 总结 prompt)
        system_prompt: 系统提示词
        search_engine: "domestic" (DashScope) 或 "international" (DuckDuckGo)
        search_strategy: DashScope 专用搜索策略
        search_keywords: DDG 专用的简短搜索关键词，若为空自动从 query 中使用
        max_results: DuckDuckGo 专用最大结果数

    Returns:
        (summary_text, extracted_sources)
    """
    if search_engine == "international":
        return await _web_search_duckduckgo(query, system_prompt, search_keywords, max_results)
    else:
        return await _web_search_dashscope(query, system_prompt, search_strategy)


# 保留旧函数名作为别名，避免其他地方的直接引用报错
web_search_llm = _web_search_dashscope
