"""Tests for sklearn_agent.py — the random-forest ("reason forest") path.

Run with:  cd agent && uv run pytest tests/test_sklearn_agent.py -v

Covers the uniform agent contract for non-MLP models:
  - SklearnProxy predicts on [board ‖ style], so a forest conditions on style
    out of the box (it splits on style columns alongside board columns).
  - fit_and_export_sklearn emits a single `features` input (board ‖ style) and
    an `equity` output — the same ONNX contract the MLP export produces.
"""
from __future__ import annotations

import numpy as np
import torch

from sklearn_agent import SklearnProxy, build_sklearn_model, fit_and_export_sklearn

# A minimal random-forest agent, as a mint would supply via model code.
FOREST_SRC = (
    "from sklearn.ensemble import RandomForestRegressor\n"
    "def build_model():\n"
    "    return RandomForestRegressor(n_estimators=16, random_state=0)\n"
)


def test_sklearn_proxy_conditions_on_style():
    """Outcome here depends only on a style column — a board-only model could
    never learn it, but [board ‖ style] rows let the forest split on style, so
    flipping that style column flips the prediction."""
    rng = np.random.default_rng(0)
    n, board_dim, style_dim = 400, 198, 4
    board = rng.standard_normal((n, board_dim)).astype("float32")
    style = rng.standard_normal((n, style_dim)).astype("float32")
    X = np.concatenate([board, style], axis=1)
    y = (style[:, 0] > 0.0).astype("float32")  # label depends on style[0] only

    model = build_sklearn_model(FOREST_SRC)
    model.fit(X, y)

    proxy = SklearnProxy(extras_dim=style_dim)
    proxy.update_model(model)
    assert proxy.extras_dim == style_dim  # signals "this model takes style"

    feats = torch.from_numpy(board[:32])
    ext_pos = torch.tensor([2.0, 0.0, 0.0, 0.0]).unsqueeze(0).expand(32, -1)
    ext_neg = torch.tensor([-2.0, 0.0, 0.0, 0.0]).unsqueeze(0).expand(32, -1)

    p_pos = proxy(feats, ext_pos).mean().item()
    p_neg = proxy(feats, ext_neg).mean().item()
    assert p_pos > p_neg + 0.25, (
        f"style must move the forest's prediction; got pos={p_pos} neg={p_neg}"
    )


def test_sklearn_proxy_unfitted_returns_half():
    proxy = SklearnProxy(extras_dim=4)
    out = proxy(torch.zeros(5, 198), torch.zeros(5, 4))
    assert out.shape == (5,)
    assert torch.allclose(out, torch.full((5,), 0.5))


def test_fit_and_export_sklearn_features_contract(tmp_path):
    """The exported ONNX has a single `features` input whose width is the
    fitted feature width (board + style) and an `equity` output."""
    import onnxruntime as ort

    rng = np.random.default_rng(1)
    board_dim, style_dim = 198, 4
    width = board_dim + style_dim
    X = rng.standard_normal((150, width)).astype("float32")
    y = (X[:, board_dim] > 0.0).astype("float32")

    path, root_hash = fit_and_export_sklearn(
        FOREST_SRC, X, y, agent_id=7, checkpoint_dir=tmp_path,
    )
    assert path.exists()
    assert root_hash is None  # upload=False

    sess = ort.InferenceSession(str(path))
    inputs = sess.get_inputs()
    assert len(inputs) == 1
    assert inputs[0].name == "features"
    assert inputs[0].shape[-1] == width
    assert "equity" in [o.name for o in sess.get_outputs()]

    res = sess.run(["equity"], {"features": X[:3]})[0]
    assert res.reshape(-1).shape[0] == 3
