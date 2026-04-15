"""
搜索工具模块。
使用阿里云 DashScope 内置联网搜索 (enable_search) 替代 DuckDuckGo。

核心优势:
- 搜索在阿里云服务器端完成，国内网络零障碍
- search_strategy="max" 使用多源搜索引擎，结果更全面
- forced_search=True 强制联网，确保每次都获取实时数据
- 搜索+LLM理解一体化，一次 API 调用完成搜索和总结
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


async def web_search_llm(
    query: str,
    system_prompt: str = "",
    search_strategy: str = "max",
) -> tuple[str, list[SearchResult]]:
    """
    阿里云 DashScope 联网搜索 + LLM 理解一体化。

    模型在云端执行搜索（国内网络零障碍），然后基于搜索结果生成回复。
    一次 API 调用 = 搜索 + 理解 + 摘要，替代原来的三步流水线。

    Args:
        query: 用户提示词 (可包含搜索关键词和指令)
        system_prompt: 系统提示词 (控制输出格式和风格)
        search_strategy: 搜索策略 ("turbo"=快速 / "max"=全面 / "agent"=多轮)

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
        logger.info(f"🔍 DashScope 联网搜索: {query[:80]}...")

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

        logger.info(f"✅ 联网搜索完成: {query[:50]}... ({len(sources)} 个来源)")
        return content, sources

    except Exception as e:
        logger.error(f"❌ 联网搜索失败: {e}")
        return "", []
