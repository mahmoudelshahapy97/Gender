# app/services/stream_manager.py
"""One asyncio worker per enabled camera, plus the manager that supervises them.

Every blocking call (VideoCapture, YOLO forward pass, JPEG encode) is pushed
onto a thread so the event loop keeps serving HTTP while cameras are being
processed.

A camera's ``enabled`` column is the operator's intent: enabled cameras are
started at boot, and the supervisor keeps them running -- restarting a worker
that died, errored, or wedged, and starting any enabled camera that has no
worker at all.

Per processed frame a worker tracks the people (people.pt + ByteTrack), runs
gender.pt every GENDER_EVERY_N frames, and lets gender_service turn both into
visits (written when a person's track ends) and occupancy (written, with the
annotated frame, every SNAPSHOT_INTERVAL_S). With alert thresholds set, the
people count also feeds OccupancyAlerts; the supervisor's tick feeds
HealthWatch (camera offline / back online). Both publish through
notification_service.
"""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import numpy as np

from app.core.config import config
from app.services.alerts import OFFLINE, ONLINE, HealthWatch, OccupancyAlerts
from app.services.camera_service import camera_service
from app.services.gender_service import CountingParams, GenderCounter, Visit
from app.services.notification_service import notification_service
from app.services.rtsp_reader import RTSPReader
from app.services.snapshot_service import snapshot_service
from app.services.tracking_service import Detection, GenderDetector, PersonTracker
from app.services.visit_service import visit_service
from app.utils.image_utils import annotate_people, encode_jpeg

logger = logging.getLogger(__name__)

# A connected worker that has analysed nothing for this multiple of the open
# timeout is wedged inside a blocking read and cannot recover on its own.
STALL_TIMEOUT_MULTIPLIER = 3.0

# Worker states, as reported by status()
STARTING = "starting"
RUNNING = "running"
RECONNECTING = "reconnecting"
ERROR = "error"
STOPPED = "stopped"


def _setting(settings: Dict[str, Any], name: str, default: float) -> float:
    try:
        return float(settings.get(name, default))
    except (TypeError, ValueError):
        return default


class CameraWorker:
    """Processes a single RTSP stream until stopped."""

    def __init__(self, camera: Dict[str, Any], alerts: Optional[OccupancyAlerts] = None) -> None:
        self.camera = camera
        self.camera_id: UUID = camera["camera_id"]
        self.name: str = camera.get("name") or str(self.camera_id)
        self.rtsp_url: str = camera["rtsp_url"]

        settings = camera_service.parse_settings(camera)
        self.params = CountingParams.from_settings(settings)
        self.gender_every_n = max(1, int(_setting(settings, "gender_every_n", config.gender_every_n)))
        self.snapshot_interval = max(5.0, _setting(settings, "snapshot_interval_s", config.snapshot_interval_s))
        self.roi = camera_service.parse_roi(camera)
        self.alerts = alerts or OccupancyAlerts(settings, config.alert_sustain_s, config.alert_cooldown_s)

        self.reader = RTSPReader(self.rtsp_url)
        self.tracker: Optional[PersonTracker] = None
        self.gender: Optional[GenderDetector] = None
        self.counter = GenderCounter(self.params, session=self._session())

        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._last_frame: Optional[np.ndarray] = None
        self._last_annotated: Optional[np.ndarray] = None
        self._last_frame_at: Optional[datetime] = None
        self._min_interval = 1.0 / max(0.1, config.target_process_fps)
        # True while a blocking read is running on a thread. Releasing the
        # capture under it can crash OpenCV, so stop() leaves it alone then.
        self._reading = False
        self._next_snapshot_at = 0.0

        self.state = STOPPED
        self.started_at: Optional[datetime] = None
        self.frames_processed = 0
        self.visits_recorded = 0
        self.snapshots_recorded = 0
        self.reconnects = 0
        self.last_error: Optional[str] = None
        self.connected = False
        self.fps = 0.0
        # Monotonic progress marker read by the supervisor. A blocked read
        # cannot notice its own stall, so somebody outside has to.
        self._last_progress_at = time.monotonic()
        self._last_processed_at: Optional[float] = None

    @staticmethod
    def _session() -> str:
        """Tags this run's track ids: ByteTrack restarts them at 1."""
        return uuid.uuid4().hex[:8]

    # ---------------------------------------------------------------- control
    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self.state = STARTING
        self.started_at = datetime.now(timezone.utc)
        self._last_progress_at = time.monotonic()
        self._task = asyncio.create_task(self._run(), name=f"camera-{self.name}")
        logger.info("Worker started for camera %s (%s)", self.name, self.camera_id)

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=15)
            except asyncio.TimeoutError:
                logger.warning("Worker %s did not stop in time; cancelling.", self.name)
                self._task.cancel()
            except asyncio.CancelledError:
                pass
        if self._reading:
            logger.warning(
                "Camera %s: a read is still blocked; leaving the capture to close itself.",
                self.name,
            )
        else:
            await asyncio.to_thread(self.reader.release)
        self.connected = False
        self.state = STOPPED

        # The people still in view are counted rather than lost.
        await self._record_visits(self.counter.flush(time.time()))
        logger.info("Worker stopped for camera %s", self.name)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    @property
    def seconds_since_progress(self) -> float:
        return time.monotonic() - self._last_progress_at

    def status(self) -> Dict[str, Any]:
        return {
            "camera_id": str(self.camera_id),
            "name": self.name,
            "state": self.state,
            "running": self.running,
            "connected": self.connected,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "last_frame_at": self._last_frame_at.isoformat() if self._last_frame_at else None,
            "seconds_since_frame": round(self.seconds_since_progress, 1),
            "fps": round(self.fps, 2),
            "frames_processed": self.frames_processed,
            "visits_recorded": self.visits_recorded,
            "snapshots_recorded": self.snapshots_recorded,
            "reconnects": self.reconnects,
            "last_error": self.last_error,
            "occupancy": self.counter.occupancy(),
            "people": self.counter.snapshot(),
        }

    def last_frame(self, annotated: bool = False) -> Optional[np.ndarray]:
        if annotated and self._last_annotated is not None:
            return self._last_annotated
        return self._last_frame

    # ------------------------------------------------------------------- loop
    async def _run(self) -> None:
        """Task entrypoint. Nothing may escape here and end the task quietly:
        a worker that dies without saying why just stops watching its camera."""
        try:
            await self._loop()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.state = ERROR
            self.last_error = f"worker crashed: {e}"
            logger.error("Camera %s: worker crashed: %s", self.name, e, exc_info=True)
        finally:
            if self.state != ERROR:
                self.state = STOPPED
            self.connected = False

    def _load_models(self) -> None:
        self.tracker = PersonTracker(roi=self.roi)
        self.gender = GenderDetector()

    async def _loop(self) -> None:
        reconnect_attempt = 0

        try:
            await asyncio.to_thread(self._load_models)
        except Exception as e:
            self.state = ERROR
            self.last_error = f"model load failed: {e}"
            logger.error("Camera %s: %s", self.name, self.last_error, exc_info=True)
            return

        while not self._stop.is_set():
            if not self.reader.is_open:
                self.state = RECONNECTING if reconnect_attempt or self.frames_processed else STARTING
                opened = await asyncio.to_thread(self.reader.open)
                if not opened:
                    reconnect_attempt += 1
                    self.reconnects += 1
                    self.connected = False
                    self.last_error = f"could not open stream (attempt {reconnect_attempt})"
                    await self._sleep_backoff(reconnect_attempt)
                    continue
                reconnect_attempt = 0
                self.connected = True
                self.state = RUNNING
                self.last_error = None
                self._last_progress_at = time.monotonic()
                # Track ids restart with the connection: close the open visits
                # and start a new id session.
                await self._record_visits(self.counter.flush(time.time()))
                self.counter.session = self._session()
                if self.tracker:
                    self.tracker.reset()

            cycle_start = time.monotonic()
            ok, frame = await asyncio.to_thread(self._blocking_read)

            if not ok:
                # Each failed read on a dead server blocks for the ffmpeg
                # timeout, so counting failures alone takes minutes. Nothing
                # for rtsp_open_timeout seconds means the stream is gone.
                stalled = self.seconds_since_progress > config.rtsp_open_timeout
                if stalled or self.reader.should_reconnect():
                    logger.warning(
                        "Camera %s: no frame for %.0fs, reconnecting.",
                        self.name,
                        self.seconds_since_progress,
                    )
                    await asyncio.to_thread(self.reader.release)
                    self.connected = False
                    self.reconnects += 1
                await asyncio.sleep(0.2)
                continue

            try:
                await self._process(frame)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = str(e)
                logger.error("Camera %s processing error: %s", self.name, e, exc_info=True)

            # Hold the configured processing rate without busy-waiting.
            elapsed = time.monotonic() - cycle_start
            if elapsed < self._min_interval:
                await asyncio.sleep(self._min_interval - elapsed)

        if not self._reading:
            await asyncio.to_thread(self.reader.release)

    def _blocking_read(self):
        """Runs on the thread, so the flag reflects the read itself -- not the
        awaiting task, which a cancel can end while the read is still blocked."""
        self._reading = True
        try:
            return self.reader.read()
        finally:
            self._reading = False

    async def _process(self, frame: np.ndarray) -> None:
        now = time.monotonic()
        self._last_frame = frame
        self._last_frame_at = datetime.now(timezone.utc)
        self.frames_processed += 1
        self._last_progress_at = now
        self._tick_fps(now)
        self.state = RUNNING

        detections = await asyncio.to_thread(self.tracker.track, frame)
        # Like InsightEye: gender only every Nth frame, and only with people in view.
        gender_boxes = None
        if detections and self.frames_processed % self.gender_every_n == 0:
            gender_boxes = await asyncio.to_thread(self.gender.detect, frame)
        visits = self.counter.update(detections, time.time(), gender_boxes)

        annotated = await asyncio.to_thread(self._annotate, frame, detections)
        self._last_annotated = annotated

        await self._record_visits(visits)
        if self.alerts.enabled:
            occupancy = self.counter.occupancy()
            for alert in self.alerts.observe(occupancy["person_count"], now):
                await notification_service.occupancy_alert(self.camera, alert, occupancy)
        if now >= self._next_snapshot_at:
            self._next_snapshot_at = now + self.snapshot_interval
            await self._record_snapshot(annotated)

    def _annotate(self, frame: np.ndarray, detections: List[Detection]) -> np.ndarray:
        occupancy = self.counter.occupancy()
        header = (
            f"{self.name}  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  "
            f"People {occupancy['person_count']} | M {occupancy['male_count']} | "
            f"F {occupancy['female_count']} | C {occupancy['child_count']}"
        )
        people = [(d.box, d.track_id, self.counter.label_of(d.track_id)) for d in detections]
        return annotate_people(frame, people, self.roi, header)

    async def _record_visits(self, visits: List[Visit]) -> None:
        if visits:
            self.visits_recorded += await visit_service.record(self.camera_id, visits)

    async def _record_snapshot(self, annotated: np.ndarray) -> None:
        jpeg = None
        if config.snapshot_store_frames:
            jpeg = await asyncio.to_thread(encode_jpeg, annotated)
        if await snapshot_service.record(self.camera_id, self.counter.occupancy(), jpeg):
            self.snapshots_recorded += 1

    def _tick_fps(self, now: float) -> None:
        if self._last_processed_at is not None:
            interval = now - self._last_processed_at
            if interval > 0:
                instant = 1.0 / interval
                self.fps = instant if self.fps == 0 else 0.8 * self.fps + 0.2 * instant
        self._last_processed_at = now

    async def _sleep_backoff(self, attempt: int) -> None:
        delay = min(
            config.rtsp_reconnect_delay_base * (2 ** max(0, attempt - 1)),
            config.rtsp_reconnect_delay_max,
        )
        logger.info("Camera %s: retrying connection in %.1fs", self.name, delay)
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass


class StreamManager:
    """Owns the worker per camera and keeps the set in sync with the database."""

    def __init__(self) -> None:
        self.workers: Dict[UUID, CameraWorker] = {}
        self._lock = asyncio.Lock()
        self._supervisor: Optional[asyncio.Task] = None
        # camera_id -> restart count, and monotonic time of the next allowed retry
        self._restarts: Dict[UUID, int] = {}
        self._retry_after: Dict[UUID, float] = {}
        # Outlive the workers, so a restart does not reset an alert's cooldown
        # or forget that a camera was reported offline.
        self._alerts: Dict[UUID, OccupancyAlerts] = {}
        self.health = HealthWatch(config.camera_offline_after_s, config.camera_health_cooldown_s)

    # -------------------------------------------------------------- lifecycle
    async def startup(self) -> None:
        """Resume enabled cameras, then keep them running."""
        await self.start_enabled_cameras()
        if config.worker_supervision_enabled and self._supervisor is None:
            self._supervisor = asyncio.create_task(self._supervise(), name="worker-supervisor")

    async def start_camera(self, camera: Dict[str, Any]) -> Dict[str, Any]:
        camera_id = camera["camera_id"]
        async with self._lock:
            existing = self.workers.get(camera_id)
            if existing and existing.running:
                return existing.status()
            if existing:
                await existing.stop()

            worker = self._new_worker(camera)
            self.workers[camera_id] = worker
            await worker.start()
            return worker.status()

    async def stop_camera(self, camera_id: UUID) -> bool:
        async with self._lock:
            worker = self.workers.pop(camera_id, None)
        self._restarts.pop(camera_id, None)
        self._retry_after.pop(camera_id, None)
        # Stopped on purpose: neither "offline" nor its recovery is news.
        self.health.forget(camera_id)
        self._alerts.pop(camera_id, None)
        if worker is None:
            return False
        await worker.stop()
        return True

    async def restart_camera(self, camera_id: UUID) -> Optional[Dict[str, Any]]:
        """Replace the worker with a fresh one built from the current DB row.

        The old worker is stopped outside the lock: a wedged read can hold
        stop() for 15 s, and every other camera's start/stop would queue behind
        it. Re-reading the row under the lock means a camera the operator
        stopped a moment ago (enabled=false) is not brought back.
        """
        async with self._lock:
            worker = self.workers.pop(camera_id, None)
        if worker is not None:
            await worker.stop()

        async with self._lock:
            if camera_id in self.workers:
                # Someone else started it while the old worker was stopping.
                return self.workers[camera_id].status()
            camera = await camera_service.get_camera(camera_id)
            if not camera or not camera["enabled"]:
                return None
            fresh = self._new_worker(camera)
            self.workers[camera_id] = fresh
            await fresh.start()
            return fresh.status()

    def _new_worker(self, camera: Dict[str, Any]) -> CameraWorker:
        """A worker for the row, carrying over the alert state when the
        thresholds did not change (a supervisor restart, or an edit of
        something else)."""
        settings = camera_service.parse_settings(camera)
        alerts = OccupancyAlerts(settings, config.alert_sustain_s, config.alert_cooldown_s)
        previous = self._alerts.get(camera["camera_id"])
        if previous is not None and previous.thresholds == alerts.thresholds:
            alerts = previous
        self._alerts[camera["camera_id"]] = alerts
        return CameraWorker(camera, alerts)

    async def start_enabled_cameras(self) -> int:
        """Called at startup so enabled cameras resume without manual intervention."""
        try:
            cameras = await camera_service.list_cameras(enabled_only=True)
        except Exception as e:
            logger.error("Could not load cameras at startup: %s", e, exc_info=True)
            return 0

        started = 0
        for camera in cameras:
            try:
                await self.start_camera(camera)
                started += 1
                # Stagger so several model loads do not land at once.
                await asyncio.sleep(config.stream_start_stagger_delay)
            except Exception as e:
                logger.error("Failed to start camera %s: %s", camera.get("name"), e, exc_info=True)

        logger.info("Started %s/%s enabled cameras.", started, len(cameras))
        return started

    async def shutdown(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except asyncio.CancelledError:
                pass
            self._supervisor = None

        async with self._lock:
            workers = list(self.workers.values())
            self.workers.clear()
        # stop_grace_period is 30 s; workers usually stop in a few.
        await asyncio.gather(*(w.stop() for w in workers), return_exceptions=True)
        logger.info("All camera workers stopped.")

    # ------------------------------------------------------------ supervision
    async def _supervise(self) -> None:
        interval = max(1.0, config.worker_supervision_interval_s)
        while True:
            try:
                await asyncio.sleep(interval)
                await self.check_workers()
                await self.reconcile()
                await self.watch_health()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Worker supervisor iteration failed")

    @staticmethod
    def unhealthy_reason(worker: CameraWorker, stall_after: float) -> Optional[str]:
        if worker.stopping:
            return None
        if not worker.running:
            return f"worker is not running ({worker.last_error or 'exited'})"
        if worker.state == ERROR:
            return f"worker is in error state ({worker.last_error})"
        if worker.state == RUNNING and worker.connected and worker.seconds_since_progress > stall_after:
            return (
                f"no frame analysed for {worker.seconds_since_progress:.0f}s "
                f"(threshold {stall_after:.0f}s)"
            )
        return None

    def _next_backoff(self, camera_id: UUID, now: float) -> int:
        attempt = self._restarts.get(camera_id, 0) + 1
        delay = min(
            config.worker_restart_backoff_base_s * (2 ** (attempt - 1)),
            config.worker_restart_backoff_max_s,
        )
        self._restarts[camera_id] = attempt
        self._retry_after[camera_id] = now + delay
        return attempt

    async def check_workers(self) -> None:
        """Restart workers that died, errored, or wedged, with exponential backoff."""
        now = time.monotonic()
        stall_after = config.rtsp_open_timeout * STALL_TIMEOUT_MULTIPLIER
        due: List[UUID] = []

        for camera_id, worker in list(self.workers.items()):
            reason = self.unhealthy_reason(worker, stall_after)
            if reason is None:
                # A spell of health earns back a clean slate, so a camera that
                # flaps overnight is not stuck on a 5-minute backoff by morning.
                if worker.state == RUNNING:
                    self._restarts.pop(camera_id, None)
                    self._retry_after.pop(camera_id, None)
                continue
            if now < self._retry_after.get(camera_id, 0.0):
                continue

            attempt = self._next_backoff(camera_id, now)
            logger.warning(
                "Camera %s: %s -- restarting (attempt %s)", worker.name, reason, attempt
            )
            due.append(camera_id)

        # Concurrently: one wedged camera must not delay the rest.
        results = await asyncio.gather(
            *(self.restart_camera(camera_id) for camera_id in due), return_exceptions=True
        )
        for camera_id, result in zip(due, results):
            if isinstance(result, Exception):
                logger.warning("Camera %s: restart failed: %s", camera_id, result)

    async def reconcile(self) -> None:
        """Start enabled cameras that have no worker (e.g. the DB was not ready at boot)."""
        try:
            cameras = await camera_service.list_cameras(enabled_only=True)
        except Exception as e:
            logger.warning("Supervisor could not list cameras: %s", e)
            return

        now = time.monotonic()
        for camera in cameras:
            camera_id = camera["camera_id"]
            if camera_id in self.workers or now < self._retry_after.get(camera_id, 0.0):
                continue
            logger.info("Camera %s is enabled but has no worker; starting it.", camera.get("name"))
            try:
                await self.restart_camera(camera_id)
            except Exception as e:
                self._next_backoff(camera_id, now)
                logger.warning("Camera %s: start failed: %s", camera.get("name"), e)

    @staticmethod
    def delivering(worker: Optional[CameraWorker]) -> bool:
        """Frames are arriving and being analysed right now."""
        return (
            worker is not None
            and worker.running
            and worker.state == RUNNING
            and worker.connected
            and worker.seconds_since_progress < config.rtsp_open_timeout
        )

    async def watch_health(self) -> None:
        """Camera offline / back online notifications, for every enabled camera."""
        if not config.notifications_enabled:
            return
        try:
            cameras = await camera_service.list_cameras(enabled_only=True)
        except Exception as e:
            logger.warning("Health watch could not list cameras: %s", e)
            return

        now = time.monotonic()
        enabled = set()
        for camera in cameras:
            camera_id = camera["camera_id"]
            enabled.add(camera_id)
            worker = self.workers.get(camera_id)
            if not self.health.known(camera_id):
                # First look since the API started: was it left reported offline?
                try:
                    last = await notification_service.last_health_kind(camera_id)
                except Exception:
                    last = None
                self.health.restore(camera_id, last == OFFLINE, now)
            down_for = self.health.down_for(camera_id, now)
            event = self.health.observe(camera_id, self.delivering(worker), now)
            if event == OFFLINE:
                await notification_service.camera_health(
                    camera, OFFLINE, self.health.down_for(camera_id, now),
                    worker.last_error if worker else "no worker",
                )
            elif event == ONLINE:
                await notification_service.camera_health(camera, ONLINE, down_for)

        # Disabled or deleted since the last tick.
        for camera_id in [c for c in self.health.cameras() if c not in enabled]:
            self.health.forget(camera_id)

    # ------------------------------------------------------------------ query
    def get_worker(self, camera_id: UUID) -> Optional[CameraWorker]:
        return self.workers.get(camera_id)

    def worker_status(self, worker: CameraWorker) -> Dict[str, Any]:
        status = worker.status()
        status["supervisor_restarts"] = self._restarts.get(worker.camera_id, 0)
        return status

    def status(self) -> List[Dict[str, Any]]:
        return [self.worker_status(worker) for worker in self.workers.values()]

    @property
    def supervisor_running(self) -> bool:
        return self._supervisor is not None and not self._supervisor.done()


stream_manager = StreamManager()
