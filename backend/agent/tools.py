"""
搜索工具模块。
支持两种网络检索引擎（统一由 AnySearch API 驱动，国内环境无需科学上网代理）：
1. 国内搜索 (domestic) — 聚焦中文优质数据源
2. 国际搜索 (international) — 聚焦英文/全球前沿文献（支持检索词自动翻译优化）

通过统一入口 web_search() 屏蔽差异，上层节点无需关心具体实现。
"""

import asyncio
import logging
import re
from typing import Optional

import httpx
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
    from ..config import temp_api_key, temp_base_url, get_settings
    settings = get_settings()
    return AsyncOpenAI(
        api_key=temp_api_key.get() or settings.openai_api_key,
        base_url=temp_base_url.get() or settings.openai_base_url,
    )

# ============================================================================
# AnySearch 统一网络检索底座
# ============================================================================

async def _call_anysearch_api(
    query: str,
    max_results: int = 5,
    zone: Optional[str] = None,
    language: Optional[str] = None
) -> list[SearchResult]:
    """
    底层调用 AnySearch API 进行检索并返回 SearchResult 列表。
    """
    from ..config import temp_anysearch_key, get_settings
    settings = get_settings()
    api_key = temp_anysearch_key.get() or settings.anysearch_api_key

    headers = {
        "Content-Type": "application/json"
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "query": query,
        "max_results": max_results
    }
    if zone:
        payload["zone"] = zone
    if language:
        payload["language"] = language

    try:
        logger.info(f"🌐 [AnySearch] 发起检索: {query[:60]}... (zone={zone}, lang={language})")
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post("https://api.anysearch.com/v1/search", json=payload, headers=headers)
            if response.status_code == 200:
                resp_json = response.json()
                # 兼容 AnySearch 官方带 "data" 包装与不带包装的响应结构
                data_payload = resp_json.get("data") if isinstance(resp_json.get("data"), dict) else resp_json
                results = []
                for item in data_payload.get("results", []):
                    results.append(SearchResult(
                        title=item.get("title") or item.get("name") or "",
                        snippet=item.get("snippet") or item.get("body") or "",
                        url=item.get("url") or item.get("href") or ""
                    ))
                logger.info(f"✅ [AnySearch] 检索完成，共获取 {len(results)} 条记录")
                return results
            else:
                logger.error(f"❌ [AnySearch] API 请求失败，状态码: {response.status_code}, 响应: {response.text}")
                return []
    except Exception as e:
        logger.error(f"❌ [AnySearch] 异常: {e}")
        return []


async def _translate_keywords_to_english(keywords: str) -> str:
    """
    轻量级关键词翻译: 中文 → 英文搜索关键词。
    用于确保国际搜索能命中英文/国际来源。
    如果关键词已经是英文则直接返回。
    """
    # 快速检测: 如果没有中文字符，直接返回
    import re as _re
    if not _re.search(r'[\u4e00-\u9fff]', keywords):
        return keywords

    try:
        from ..config import temp_model
        settings = get_settings()
        client = _get_search_client()
        model_name = temp_model.get() or settings.model_name
        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert search keyword translator. Your only task is to translate Chinese search queries or keywords into concise, effective English search keywords for search engines. "
                        "All Chinese words must be translated into English. Proper nouns (like product names, brand names, e.g., 'Claude', 'Fable') should be kept in English. "
                        "Do not explain, do not add conversational text, do not repeat the Chinese characters. Output ONLY the English search keywords.\n\n"
                        "Examples:\n"
                        "Input: 'claude fable 5有哪些重大升级'\n"
                        "Output: 'Claude Fable 5 key upgrades major improvements new features'\n"
                        "Input: 'Claude Fable 5 上下文窗口和最大输出长度升级细节'\n"
                        "Output: 'Claude Fable 5 context window max output length upgrade details'\n"
                        "Input: 'Claude Fable 5 视觉能力改进与新功能'\n"
                        "Output: 'Claude Fable 5 vision capabilities improvements new features'\n"
                        "Input: 'Claude Fable 5 安全路由和多云部署变化'\n"
                        "Output: 'Claude Fable 5 secure routing multi-cloud deployment changes'"
                    )
                },
                {"role": "user", "content": keywords},
            ],
            temperature=0.1,
            max_tokens=100,
        )
        en = (response.choices[0].message.content or "").strip()
        # 剥离可能生成的引号
        en = en.strip('\'"')
        return en if en else keywords
    except Exception as e:
        logger.warning(f"⚠️ 关键词翻译失败，使用原始关键词: {e}")
        return keywords



async def _web_search_unified(
    query: str,
    system_prompt: str = "",
    search_keywords: str = "",
    max_results: int = 5,
    region: str = "wt-wt"
) -> tuple[str, list[SearchResult]]:
    """
    通过 AnySearch 搜索，并结合用户配置的大模型做内容提炼与总结。
    """
    settings = get_settings()
    actual_keywords = search_keywords or query

    # 确定 AnySearch 的 zone 与 language 参数
    if region == "cn":
        zone = "cn"
        language = "zh-CN"
    else:
        zone = "intl"
        language = "en"

    # 如果是国际搜索，则进行英文翻译
    if region == "wt-wt":
        actual_keywords = await _translate_keywords_to_english(actual_keywords)
        logger.info(f"🔍 [AnySearch] 国际检索关键词转换: {query[:50]} -> 英文: {actual_keywords[:50]}")

    # Step 1: 调用 AnySearch 获取网页检索结果
    sources = await _call_anysearch_api(actual_keywords, max_results=max_results, zone=zone, language=language)
    if not sources:
        logger.warning(f"⚠️ [AnySearch] 检索无结果: {actual_keywords}")
        return "", []

    # Step 2: 拼装搜索结果为上下文喂给 LLM 做总结
    search_context = "\n\n".join([
        f"### 来源 {i+1}: [{item.title}]({item.url})\n{item.snippet}"
        for i, item in enumerate(sources)
    ])

    llm_prompt = f"""以下是关于"{query}"的网页检索结果，请基于这些检索结果进行结构化的总结分析。

## 检索结果:
{search_context}

请基于以上检索结果进行分析。⚠️ 每条关键要点后必须附上对应的来源链接 Markdown 格式，例如 [来源 1](URL)。"""

    try:
        client = _get_search_client()
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": llm_prompt})

        from ..config import temp_model
        model_name = temp_model.get() or settings.model_name

        response = await client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=settings.temperature,
        )

        content = response.choices[0].message.content or ""

        # 从大模型提炼出的文字中补充提取可能遗漏的来源
        text_sources = _extract_sources_from_text(content)
        seen_urls = {s.url for s in sources}
        for ts in text_sources:
            if ts.url not in seen_urls:
                sources.append(ts)
                seen_urls.add(ts.url)

        return content, sources

    except Exception as e:
        logger.error(f"❌ [LLM 总结提炼] 失败: {e}")
        # 降级处理：如果没有大模型提炼，直接将来源拼接输出
        fallback_content = "### 网页搜索快照:\n\n" + search_context
        return fallback_content, sources


# ============================================================================
# 统一搜索入口
# ============================================================================

async def web_search(
    query: str,
    system_prompt: str = "",
    search_engine: str = "domestic",
    search_strategy: str = "max",
    search_keywords: str = "",
    max_results: int = None,
) -> tuple[str, list[SearchResult]]:
    """
    统一搜索入口。根据 search_engine 分发国内和国际搜索。

    Args:
        query: 检索关键词或总结 Prompt
        system_prompt: 系统提示词
        search_engine: "domestic" (国内搜索) 或 "international" (国际搜索)
        search_strategy: 搜索策略（AnySearch 下兼容忽略）
        search_keywords: 专用的简短检索词，若为空则直接从 query 提取
        max_results: 最大搜索条数
    """
    if max_results is None:
        from ..config import temp_max_search_results, get_settings
        settings = get_settings()
        max_results = temp_max_search_results.get() or settings.max_search_results

    if search_engine == "international":
        # 国际搜索：指定 region="wt-wt" (全球区)
        return await _web_search_unified(
            query=query,
            system_prompt=system_prompt,
            search_keywords=search_keywords,
            max_results=max_results,
            region="wt-wt"
        )
    else:
        # 国内搜索：指定 region="cn" (中文/中国区)
        return await _web_search_unified(
            query=query,
            system_prompt=system_prompt,
            search_keywords=search_keywords,
            max_results=max_results,
            region="cn"
        )



# 别名兼容，避免其他文件调用报错
web_search_llm = web_search
_web_search_dashscope = web_search
_web_search_duckduckgo = web_search
