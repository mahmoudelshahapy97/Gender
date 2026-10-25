# Models

The two models InsightEye runs in production for gender analytics, unchanged. docker-compose
mounts this folder read-only at `/app/models`, and the root `.gitignore` tracks it in full.
Both files are byte-identical to the copies in the InsightEye repo's `models/`.

| File | Role | Classes | Config |
|---|---|---|---|
| `people.pt` | Finds people. ByteTrack follows them across frames | `0` person | `PEOPLE_MODEL_PATH`, `PEOPLE_CONFIDENCE=0.5`, `PEOPLE_CLASS_ID=0` |
| `gender.pt` | Finds the same people again, labelled | `0 female`, `1 male`, `2 child` | `GENDER_MODEL_PATH`, `GENDER_CONFIDENCE=0.4` (InsightEye's value), `GENDER_CLASS_MAP` |

## people.pt

- **Model:** Ultralytics YOLO26-N detector (2.50 M parameters), fine-tuned from `yolo26n.pt` on
  InsightEye's people dataset. 50 epochs, 640 px.
- **Checkpoint:** dated 2026-01-25, saved by Ultralytics 8.4.6.
- **Size:** 5,376,005 bytes.
- **SHA-256:** `0dcc38851079c9c5403dbb2e127be9870fd4c635b730586fd5b41572e4ffbbd7`

## gender.pt

- **Model:** Ultralytics YOLO26-N detector (2.50 M parameters), fine-tuned from `yolo26n.pt` on
  InsightEye's gender dataset (first iteration, split 1). 100 epochs, 640 px.
- **Checkpoint:** dated 2026-02-09, saved by Ultralytics 8.4.13.
- **Size:** 5,389,253 bytes.
- **SHA-256:** `170759ac501cfc3bb9d6b5bf3b769ec237ebe300bc391fb3d3a97217d45e3f65`

It is a detector, not a classifier: it boxes people with a gender label, and runs on the whole
frame. [tracking_service.py](../app/services/tracking_service.py) matches each of its boxes
to the `people.pt` track it covers, and [gender_service.py](../app/services/gender_service.py)
turns those matches into votes. `GENDER_CLASS_MAP` must match the model's `names`.
`tests/test_models.py` checks the names and that the map covers all three labels.

## Runtime

- 640 px input (`YOLO_INPUT_SIZE`), FP16 on CUDA (`YOLO_HALF`), `MODEL_DEVICE=cuda` with an
  automatic fallback to CPU.
- The api image runs Ultralytics 8.4.178 with torch 2.11.0+cu128.
- [model_registry.py](../app/services/model_registry.py) gives each camera worker its own
  instances, because the tracker state lives next to the model and sharing one would mix track
  ids. Unlike the stock COCO weights, these are never downloaded: a missing file raises
  `FileNotFoundError` and the worker goes to its error state, which the camera page shows.
- **License:** both are fine-tunes of Ultralytics YOLO26, which is AGPL-3.0. Check the terms
  before any commercial or closed-source deployment.

## Measured

`tests/test_models.py` (marked `slow`) runs both models over `videos/gender.mp4`. It checks that
people are found and tracked, and that `gender.pt` settles labels for them. In the e2e run of
2026-10-24 on a Tesla T4, a worker on the mediamtx stream of that clip ran at about 5 processed
fps and settled its first label within seconds of connecting.
