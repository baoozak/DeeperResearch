"""诊断脚本：检查 enable_search 是否实际联网，以及模型是否输出 URL"""
import asyncio
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

from openai import AsyncOpenAI
from backend.config import get_settings


async def test():
    s = get_settings()
    client = AsyncOpenAI(api_key=s.openai_api_key, base_url=s.openai_base_url)

    resp = await client.chat.completions.create(
        model=s.model_name,
        messages=[{"role": "user", "content": "2026年4月AI领域有哪些最新大事件？请列出来源链接。"}],
        temperature=0.3,
        extra_body={
            "enable_search": True,
            "search_options": {
                "forced_search": True,
                "search_strategy": "max",
            },
        },
    )

    txt = resp.choices[0].message.content or ""
    print(f"=== 响应长度: {len(txt)} 字符 ===")
    print()

    # 检查 URL
    urls = re.findall(r"https?://[^\s)>\]，。；]+", txt)
    md_links = re.findall(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", txt)

    print(f"裸 URL 数量: {len(urls)}")
    print(f"Markdown 链接数量: {len(md_links)}")
    print()

    if md_links:
        print("=== Markdown 链接 ===")
        for title, url in md_links[:5]:
            print(f"  [{title}]({url})")
    elif urls:
        print("=== 裸 URL ===")
        for u in urls[:5]:
            print(f"  {u}")
    else:
        print("!!! 模型响应中没有任何 URL !!!")

    print()
    print("=== 响应内容 (前 600 字) ===")
    print(txt[:600])
    print()

    # 检查 usage 中是否有 search 插件信息
    usage = resp.usage
    print(f"=== Token 消耗 ===")
    print(f"  prompt_tokens: {usage.prompt_tokens}")
    print(f"  completion_tokens: {usage.completion_tokens}")
    print(f"  total_tokens: {usage.total_tokens}")


asyncio.run(test())
