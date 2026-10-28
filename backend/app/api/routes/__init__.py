from fastapi import APIRouter

from app.api.routes import (
    audit_router,
    analytics_router,
    auth_router,
    camera_router,
    notification_router,
    snapshot_router,
    system_router,
    user_router,
    visit_router,
    workspace_router,
)
from app.core.config import config

# Everything hangs off the versioned API prefix.
router = APIRouter(prefix=config.app_api_prefix)

router.include_router(auth_router.router)
router.include_router(user_router.router)
router.include_router(workspace_router.router)
router.include_router(camera_router.router)
router.include_router(visit_router.router)
router.include_router(snapshot_router.router)
router.include_router(system_router.router)
router.include_router(analytics_router.router)
router.include_router(notification_router.router)
router.include_router(audit_router.router)
