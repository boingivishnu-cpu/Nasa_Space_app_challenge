from typing import Literal

from pydantic import Field

from backend.app.models.terrain import ApiModel


class AiHistoryMessage(ApiModel):
    role: Literal["user", "model"]
    text: str = Field(min_length=1, max_length=1_000)


class AiChatRequest(ApiModel):
    question: str = Field(min_length=1, max_length=500)
    context: str = Field(default="", max_length=8_000)
    history: list[AiHistoryMessage] = Field(default_factory=list, max_length=8)


class AiChatResponse(ApiModel):
    answer: str
    model: str


class AiStatusResponse(ApiModel):
    provider: Literal["gemini"] = "gemini"
    model: str
    configured: bool
