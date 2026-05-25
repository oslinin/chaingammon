"""sklearn_agent.py — support for non-MLP (scikit-learn) agents.

Sklearn agents participate in the round-robin as opponents (no TD-lambda
gradient updates). After training they are fitted on collected game data
and exported as ONNX with the correct input/output names expected by the
inference layer (`features` → `equity`, where `features` = board ‖ style).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import numpy as np
import torch

if TYPE_CHECKING:
    pass

SKLEARN_PATTERN = re.compile(r"\bfrom sklearn\b|\bimport sklearn\b")

# Board encoding width; the fitted feature vector is this plus the style dim.
BOARD_DIM = 198


def is_sklearn_code(source: str) -> bool:
    return bool(SKLEARN_PATTERN.search(source))


class SklearnProxy:
    """Callable that mimics the BackgammonNet interface for sklearn agents.

    Before the model is fitted it returns 0.5 for every candidate (random
    play). After `update_model()` is called with a fitted estimator it
    delegates to that estimator's `predict()`.

    Like the MLP, it consumes the uniform agent input — each candidate's board
    encoding concatenated with the match's style/extras vector. `extras_dim > 0`
    is the signal to callers (pick_move / search) that this model takes style;
    a decision-tree ensemble then splits on board and style columns alike, so
    style×board interaction is native.
    """

    def __init__(self, extras_dim: int = 0) -> None:
        self._model = None
        self.extras_dim = extras_dim

    def update_model(self, model) -> None:
        self._model = model

    def __call__(self, feats: torch.Tensor, ext=None) -> torch.Tensor:
        if self._model is None:
            return torch.full((feats.shape[0],), 0.5)
        # Predict on [board ‖ style], matching the rows the model was fitted on.
        if ext is not None:
            feats = torch.cat([feats, ext], dim=-1)
        arr = feats.detach().numpy().astype("float32")
        try:
            preds = np.clip(self._model.predict(arr).astype("float32"), 0.0, 1.0)
            return torch.from_numpy(preds)
        except Exception:
            return torch.full((feats.shape[0],), 0.5)

    # ------------------------------------------------------------------
    # BackgammonNet compatibility stubs (td_lambda_match never puts a
    # SklearnProxy in the learner position, but be defensive).
    # ------------------------------------------------------------------

    def parameters(self):
        return iter([])

    def zero_grad(self):
        pass


def build_sklearn_model(source: str):
    """Execute agent source code and return a fresh unfitted estimator.

    The source must define a zero-argument `build_model()` function.
    """
    ns: dict = {}
    exec(compile(source, "<model_code>", "exec"), ns)  # noqa: S102
    if "build_model" not in ns:
        raise ValueError("sklearn agent code must define a build_model() function")
    return ns["build_model"]()


def fit_and_export_sklearn(
    source: str,
    X: np.ndarray,
    y: np.ndarray,
    agent_id: int,
    checkpoint_dir: Path,
    *,
    upload: bool = False,
    encrypt: bool = True,
) -> tuple[Path, Optional[str]]:
    """Fit the sklearn model from `source` on (X, y) and export to ONNX.

    Returns `(local_onnx_path, root_hash | None)`.
    The exported ONNX has a single input `"features"` [None, X.shape[1]] — the
    board encoding concatenated with the style vector — and output name
    `"equity"` [None]: the uniform agent contract the browser worker expects.
    """
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    model = build_sklearn_model(source)
    model.fit(X, y)

    n_features = int(X.shape[1])
    initial_types = [("features", FloatTensorType([None, n_features]))]
    onnx_model = convert_sklearn(model, initial_types=initial_types)

    # skl2onnx names the output "variable" — rename to "equity"
    old_output_name = onnx_model.graph.output[0].name
    if old_output_name != "equity":
        for node in onnx_model.graph.node:
            for i, o in enumerate(node.output):
                if o == old_output_name:
                    node.output[i] = "equity"
        onnx_model.graph.output[0].name = "equity"

    checkpoint_dir = Path(checkpoint_dir)
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    out_path = checkpoint_dir / f"agent-{agent_id}.onnx"
    raw = onnx_model.SerializeToString()
    out_path.write_bytes(raw)

    if not upload:
        return out_path, None

    if encrypt:
        from checkpoint_encryption import generate_key
        from sample_trainer import ONNX_ENCRYPTED_MAGIC, seal_onnx
        key = generate_key()
        blob = seal_onnx(raw, key)
        key_path = out_path.with_suffix(out_path.suffix + ".key")
        key_path.write_bytes(key)
    else:
        blob = raw

    from og_storage_upload import upload_checkpoint
    result = upload_checkpoint(blob)
    return out_path, result.root_hash
