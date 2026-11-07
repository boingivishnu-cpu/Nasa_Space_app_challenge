import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from backend.app.core.config import Settings
from backend.app.main import app
from backend.app.models.ai import AiChatRequest
from backend.app.services.gemini import (
    GeminiRateLimitError,
    GeminiProviderError,
    GeminiUnavailableError,
    generate_gemini_answer,
)


class FakeGeminiResponse:
    def __init__(self, status_code: int, body: dict[str, object]):
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, object]:
        return self._body


class FakeGeminiClient:
    def __init__(
        self,
        response: FakeGeminiResponse | None = None,
        error: Exception | None = None,
    ):
        self.response = response
        self.error = error
        self.request: tuple[str, dict[str, str], dict[str, object]] | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def post(
        self,
        url: str,
        headers: dict[str, str],
        json: dict[str, object],
    ) -> FakeGeminiResponse:
        if self.error:
            raise self.error
        self.request = (url, headers, json)
        assert self.response is not None
        return self.response


class GeminiServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_server_key_and_returns_generated_text(self) -> None:
        settings = Settings(
            gemini_api_key=SecretStr("test-server-secret"),
            gemini_model="gemini-2.5-flash",
        )
        client = FakeGeminiClient(
            FakeGeminiResponse(
                200,
                {"candidates": [{"content": {"parts": [{"text": "A concise answer."}]}}]},
            )
        )
        with (
            patch("backend.app.services.gemini.get_settings", return_value=settings),
            patch("backend.app.services.gemini.httpx.AsyncClient", return_value=client),
        ):
            answer, model = await generate_gemini_answer(
                AiChatRequest(
                    question="Explain the selected route.",
                    context="Selected route: safest, 1000 m.",
                )
            )

        self.assertEqual(answer, "A concise answer.")
        self.assertEqual(model, "gemini-2.5-flash")
        self.assertIsNotNone(client.request)
        url, headers, body = client.request
        self.assertEqual(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        )
        self.assertEqual(headers["x-goog-api-key"], "test-server-secret")
        self.assertIn("systemInstruction", body)
        contents = body["contents"]
        self.assertIn("CURRENT MARSWAY APP CONTEXT", contents[-1]["parts"][0]["text"])

    async def test_provider_rate_limit_is_reported(self) -> None:
        settings = Settings(gemini_api_key=SecretStr("test-server-secret"))
        client = FakeGeminiClient(FakeGeminiResponse(429, {}))
        with (
            patch("backend.app.services.gemini.get_settings", return_value=settings),
            patch("backend.app.services.gemini.httpx.AsyncClient", return_value=client),
        ):
            with self.assertRaises(GeminiRateLimitError):
                await generate_gemini_answer(AiChatRequest(question="Explain the map."))

    async def test_malformed_provider_response_is_reported(self) -> None:
        settings = Settings(gemini_api_key=SecretStr("test-server-secret"))
        client = FakeGeminiClient(FakeGeminiResponse(200, {"candidates": []}))
        with (
            patch("backend.app.services.gemini.get_settings", return_value=settings),
            patch("backend.app.services.gemini.httpx.AsyncClient", return_value=client),
        ):
            with self.assertRaises(GeminiProviderError):
                await generate_gemini_answer(AiChatRequest(question="Explain the map."))

    async def test_provider_timeout_is_reported(self) -> None:
        settings = Settings(gemini_api_key=SecretStr("test-server-secret"))
        client = FakeGeminiClient(error=httpx.ReadTimeout("request timed out"))
        with (
            patch("backend.app.services.gemini.get_settings", return_value=settings),
            patch("backend.app.services.gemini.httpx.AsyncClient", return_value=client),
        ):
            with self.assertRaises(GeminiUnavailableError):
                await generate_gemini_answer(AiChatRequest(question="Explain the map."))


class GeminiApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_status_never_exposes_api_key(self) -> None:
        settings = Settings(
            gemini_api_key=SecretStr("must-not-be-returned"),
            gemini_model="gemini-2.5-flash",
        )
        with patch("backend.app.routers.ai.get_settings", return_value=settings):
            response = self.client.get("/ai/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"provider": "gemini", "model": "gemini-2.5-flash", "configured": True},
        )
        self.assertNotIn("must-not-be-returned", response.text)

    def test_chat_returns_explicit_setup_error_when_unconfigured(self) -> None:
        with patch("backend.app.routers.ai.gemini_is_configured", return_value=False):
            response = self.client.post("/ai/chat", json={"question": "Explain the route."})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "gemini_not_configured")

    def test_chat_returns_answer_and_model(self) -> None:
        with (
            patch("backend.app.routers.ai.gemini_is_configured", return_value=True),
            patch(
                "backend.app.routers.ai.generate_gemini_answer",
                new=AsyncMock(return_value=("Route explanation.", "gemini-2.5-flash")),
            ),
        ):
            response = self.client.post(
                "/ai/chat",
                json={
                    "question": "Explain this route.",
                    "context": "Selected route: safest",
                    "history": [{"role": "user", "text": "Hello"}],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"answer": "Route explanation.", "model": "gemini-2.5-flash"},
        )

    def test_chat_validates_question_length(self) -> None:
        response = self.client.post("/ai/chat", json={"question": ""})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "validation_error")


if __name__ == "__main__":
    unittest.main()
