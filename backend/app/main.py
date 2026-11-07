import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.core.config import get_settings
from backend.app.routers.ai import router as ai_router
from backend.app.routers.terrain import router as terrain_router
from backend.app.services.terrain import TerrainDataUnavailable


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("marsway.api")
settings = get_settings()
app = FastAPI(
    title="MARSWAY API",
    description="Backend services for Marswalk planning.",
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(terrain_router)
app.include_router(ai_router)


@app.exception_handler(TerrainDataUnavailable)
async def terrain_data_unavailable(
    request: Request, error: TerrainDataUnavailable
) -> JSONResponse:
    logger.error("Terrain unavailable for %s: %s", request.url.path, error)
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "terrain_data_unavailable",
                "message": str(error),
            }
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
    detail = error.detail
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        code = str(detail["code"])
        message = str(detail["message"])
    else:
        code = "http_error"
        message = str(detail)
    return JSONResponse(
        status_code=error.status_code,
        headers=error.headers,
        content={"error": {"code": code, "message": message}},
    )


@app.exception_handler(RequestValidationError)
async def request_validation_error(
    request: Request, error: RequestValidationError
) -> JSONResponse:
    messages = "; ".join(
        str(item["msg"]) for item in error.errors() if item.get("msg")
    )
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "validation_error",
                "message": messages or "Request validation failed.",
            }
        },
    )


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
