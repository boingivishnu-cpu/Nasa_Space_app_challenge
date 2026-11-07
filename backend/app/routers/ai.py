import logging

from fastapi import APIRouter, HTTPException, status

from backend.app.core.config import get_settings
from backend.app.models.ai import AiChatRequest, AiChatResponse, AiStatusResponse
from backend.app.services.gemini import (
    GeminiProviderError,
    GeminiRateLimitError,
    GeminiUnavailableError,
    generate_gemini_answer,
    gemini_is_configured,
)


logger = logging.getLogger("marsway.ai")
router = APIRouter(prefix="/ai", tags=["AI"])


@router.get("/status", response_model=AiStatusResponse, summary="Check Gemini assistant configuration")
async def ai_status() -> AiStatusResponse:
    settings = get_settings()
    return AiStatusResponse(
        model=settings.gemini_model,
        configured=gemini_is_configured(settings),
    )


@router.post("/chat", response_model=AiChatResponse, summary="Ask the Gemini Marswalk assistant")
async def ai_chat(request: AiChatRequest) -> AiChatResponse:
    if not gemini_is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "gemini_not_configured",
                "message": "Gemini is not configured. Set MARSWAY_GEMINI_API_KEY in the backend .env and restart the API.",
            },
        )

    try:
        answer, model = await generate_gemini_answer(request)
    except GeminiUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "gemini_unavailable", "message": str(error)},
        ) from error
    except GeminiRateLimitError as error:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "gemini_rate_limited", "message": str(error)},
        ) from error
    except GeminiProviderError as error:
        logger.warning("Gemini response failed: %s", error)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "gemini_provider_error", "message": str(error)},
        ) from error

    return AiChatResponse(answer=answer, model=model)
