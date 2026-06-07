"""
集中配置管理模块。
通过 Pydantic BaseSettings 从 .env 文件和环境变量中读取配置，
确保所有组件使用统一的配置源。
"""

import os
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用全局配置"""

    # ===== LLM 配置 =====
    openai_api_key: str = "sk-placeholder"
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model_name: str = "qwen3.6-plus"
    temperature: float = 0.3

    # ===== 搜索引擎配置 =====
    anysearch_api_key: str = ""

    # ===== 研究参数 =====
    max_sub_tasks: int = 5          # Orchestrator 拆解出的最大子任务数
    max_search_review_retries: int = 2  # 每个 Search Worker 内部审查不通过时的最大重搜次数
    max_search_results: int = 5     # 每次搜索返回的最大结果数
    search_retry_count: int = 3     # 搜索失败重试次数

    # ===== 服务配置 =====
    cors_origins: list[str] = ["*"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # 忽略 .env 中未定义的字段
    )


@lru_cache()
def get_settings() -> Settings:
    """
    获取全局配置单例 (使用 lru_cache 确保只初始化一次)。
    """
    return Settings()


# ===== 请求级临时配置上下文 =====
# 协程隔离的配置上下文，用于在当前请求中临时暂存个人用户的自定义配置
import contextvars
temp_api_key = contextvars.ContextVar("temp_api_key", default="")
temp_base_url = contextvars.ContextVar("temp_base_url", default="")
temp_model = contextvars.ContextVar("temp_model", default="")
temp_anysearch_key = contextvars.ContextVar("temp_anysearch_key", default="")

temp_max_sub_tasks = contextvars.ContextVar("temp_max_sub_tasks", default=0)
temp_max_search_results = contextvars.ContextVar("temp_max_search_results", default=0)
temp_max_search_review_retries = contextvars.ContextVar("temp_max_search_review_retries", default=0)


