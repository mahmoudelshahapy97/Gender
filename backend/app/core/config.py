# app/core/config.py
"""Central application configuration loaded from environment variables and .env."""

from typing import Dict, List, Literal

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()


class Settings(BaseSettings):
    """
    Central application configuration.
    Loaded from:
    - Environment variables
    - .env
    - Defaults below
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # =========================================================================
    # APPLICATION
    # =========================================================================
    app_name: str = "Gender Analytics API"
    app_description: str = "Gender-aware people counting: unique visits and occupancy by male, female and child"
    app_version: str = "1.0.0"
    app_api_prefix: str = "/api/v1"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    environment: Literal["development", "staging", "production"] = "development"

    # =========================================================================
    # CORS
    # =========================================================================
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8000"]
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    cors_allow_headers: List[str] = ["Content-Type", "Authorization", "X-Request-ID", "X-Workspace-Id"]

    # =========================================================================
    # AUTH
    # =========================================================================
    # No default: pydantic-settings refuses to build Settings without this set,
    # which is the right failure mode for a signing key. Generate one with:
    #   python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Sent alongside the bearer token so <img src="..."> endpoints (camera
    # snapshots, occupancy frames) can authenticate without a
    # header. Never accepted on a route that changes state -- see
    # app/api/deps.py.
    auth_cookie_name: str = "gd_access"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: str = "lax"

    # There is no public signup. If app_user is empty at startup, one admin is
    # created from these three values -- see ensure_bootstrap_admin() in
    # app/services/user_service.py. Change the password immediately after.
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_email: str = "admin@insighteye.local"
    bootstrap_admin_password: str = "ChangeMe!123"

    # "Forgot your password?": a one-time code mailed to the account's email
    # (app/services/otp_service.py). Off while SMTP_HOST is empty.
    otp_ttl_seconds: int = 600
    otp_resend_seconds: int = 60
    otp_max_attempts: int = 5

    # =========================================================================
    # EMAIL (SMTP)
    # =========================================================================
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "Gender Analytics <no-reply@insighteye.local>"
    smtp_starttls: bool = True   # STARTTLS on smtp_port (587)
    smtp_ssl: bool = False       # implicit TLS instead (465)
    smtp_timeout_seconds: float = 20.0

    @property
    def password_reset_enabled(self) -> bool:
        return bool(self.smtp_host)

    # =========================================================================
    # LOGGING
    # =========================================================================
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    log_file_path: str = "logs/gender.log"

    # =========================================================================
    # DATABASE
    # =========================================================================
    postgres_db: str = "gender_db"
    postgres_user: str = "gender"
    postgres_password: str = "gender_pass"
    db_host: str = "db"
    db_port: int = 5432

    db_min_pool_size: int = 2
    db_max_pool_size: int = 10
    db_timeout: float = 30.0
    db_command_timeout: float = 60.0
    db_max_retries: int = 10
    db_retry_delay_base: int = 2
    db_retry_delay_max: int = 30

    # database/migrations, mounted read-only by docker-compose.yml. When this
    # path is missing (a checkout run outside Docker) the repo's own folder is
    # used -- see app/core/migrations.py.
    migrations_dir: str = "/app/migrations"

    @property
    def database_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.db_host}:{self.db_port}/{self.postgres_db}"
        )

    # =========================================================================
    # MODELS
    # =========================================================================
    model_device: str = "cpu"

    # Both are InsightEye's production weights (YOLO26n, end-to-end, 640):
    # people.pt finds people, gender.pt finds the same people again labelled
    # female / male / child. See models/README.md.
    people_model_path: str = "models/people.pt"
    people_confidence: float = 0.5
    people_class_id: int = 0
    gender_model_path: str = "models/gender.pt"
    gender_confidence: float = 0.4  # InsightEye's production GENDER_CONFIDENCE
    # gender.pt class id -> stored label. Anything not listed is ignored.
    gender_class_map: Dict[int, str] = {0: "female", 1: "male", 2: "child"}
    yolo_input_size: int = 640
    # FP16 inference on CUDA; ignored on CPU.
    yolo_half: bool = True
    # ByteTrack tuned for walking people at ~5 processed fps (see the file).
    yolo_tracker: str = "trackers/gender_bytetrack.yaml"

    # =========================================================================
    # GENDER COUNTING
    # =========================================================================
    # gender.pt runs on every Nth processed frame (InsightEye: every 3rd), and
    # each of its boxes votes for the person track it overlaps most.
    gender_every_n: int = 3
    # A gender box is the person's when it covers this much of the smaller of
    # the two boxes (gender boxes are often just the head and shoulders).
    gender_match_overlap: float = 0.6
    # Votes needed before a track's label is trusted; until then it is unknown.
    gender_min_votes: int = 2
    # A track unseen for this long has left: its visit is written.
    visit_gap_seconds: float = 6.0
    # Shorter visits are dropped - mostly detector flicker, not people.
    visit_min_dwell_s: float = 1.5
    # One occupancy row (and annotated frame) per camera this often.
    snapshot_interval_s: float = 60.0
    snapshot_store_frames: bool = True

    # =========================================================================
    # RTSP / STREAM
    # =========================================================================
    rtsp_transport: str = "tcp"
    rtsp_buffer_size: int = 1
    rtsp_open_timeout: float = 15.0
    rtsp_read_failure_limit: int = 30
    rtsp_reconnect_delay_base: float = 2.0
    rtsp_reconnect_delay_max: float = 30.0

    frame_skip: int = 5
    target_process_fps: float = 5.0
    jpeg_quality: int = 85

    stream_start_stagger_delay: float = 2.0
    stream_worker_restart_delay: float = 5.0

    # Every live viewer costs one JPEG encode per frame; cap them so a wall of
    # open browser tabs cannot starve detection.
    max_mjpeg_clients: int = 4

    # =========================================================================
    # WORKER SUPERVISION
    # =========================================================================
    # Restarts workers that died, errored, or wedged inside a blocking read,
    # and starts enabled cameras that have no worker. Without it a camera whose
    # model load failed stays dark until someone notices by hand.
    worker_supervision_enabled: bool = True
    worker_supervision_interval_s: float = 15.0
    worker_restart_backoff_base_s: float = 5.0
    worker_restart_backoff_max_s: float = 300.0

    # =========================================================================
    # OBJECT STORAGE (MinIO)
    # =========================================================================
    # Snapshot frames go to MinIO; Postgres keeps the records and object keys.
    # Empty endpoint = disabled: frames stay in Postgres bytes.
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "gender"
    minio_secure: bool = False

    # =========================================================================
    # RETENTION
    # =========================================================================
    # Snapshot frames are the bulk of the storage; their rows are small. Each
    # pass deletes frames older than frame_retention_days, and snapshot and
    # visit rows older than data_retention_days (0 = keep forever).
    retention_enabled: bool = True
    retention_interval_s: float = 21600.0  # 6 hours
    frame_retention_days: int = 30
    data_retention_days: int = 365


config = Settings()
