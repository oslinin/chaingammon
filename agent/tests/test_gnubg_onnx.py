"""Tests for ONNX export + ONNX-first evaluation (agent/gnubg_onnx.py).

Run with:  cd agent && uv run pytest tests/test_gnubg_onnx.py -v

Verifies the three gnubg nets export to valid ONNX, that the ONNX backend
reproduces the PyTorch evaluator's equity/outputs across the recorded
fixture (the real "ONNX-first" path), and that the evaluator falls back to
PyTorch when the graphs or ONNX Runtime are missing.

Net tests need gnubg.wd; the ONNX-match test additionally needs onnxruntime
and skips otherwise.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from gnubg_net import DEFAULT_WD_PATH, GnubgEvaluator
from gnubg_onnx import ONNX_NET_CLASSES, OnnxGnubgEvaluator, export_gnubg_onnx

_DATA = Path(__file__).parent / "data" / "gnubg_0ply_reference.json"
_EXPECTED_INPUT_DIM = {"contact": 250, "race": 214, "crashed": 250}

_needs_wd = pytest.mark.skipif(
    not Path(DEFAULT_WD_PATH).is_file(),
    reason=f"gnubg weights not found at {DEFAULT_WD_PATH}",
)
_needs_ort = pytest.mark.skipif(
    importlib.util.find_spec("onnxruntime") is None,
    reason="onnxruntime not installed",
)


def _records():
    return json.loads(_DATA.read_text())["records"]


@pytest.fixture(scope="module")
def onnx_dir(tmp_path_factory):
    out = tmp_path_factory.mktemp("gnubg_onnx")
    export_gnubg_onnx(out_dir=out)
    return out


@_needs_wd
def test_export_creates_valid_onnx(onnx_dir):
    import onnx

    for name in ONNX_NET_CLASSES:
        path = onnx_dir / f"gnubg_{name}.onnx"
        assert path.is_file()
        model = onnx.load(str(path))
        onnx.checker.check_model(model)
        in_dim = model.graph.input[0].type.tensor_type.shape.dim[1].dim_value
        out_dim = model.graph.output[0].type.tensor_type.shape.dim[1].dim_value
        assert in_dim == _EXPECTED_INPUT_DIM[name]
        assert out_dim == 5


@_needs_wd
@_needs_ort
def test_onnx_matches_pytorch(onnx_dir):
    ref = GnubgEvaluator(faithful=False)
    onnx_ev = OnnxGnubgEvaluator(onnx_dir)
    assert onnx_ev.backend == "onnx"

    for rec in _records()[::8]:
        b0, b1 = rec["board0"], rec["board1"]
        out_t, eq_t = ref.evaluate(b0, b1)
        out_o, eq_o = onnx_ev.evaluate(b0, b1)
        assert eq_o == pytest.approx(eq_t, abs=1e-4)
        for a, b in zip(out_o, out_t):
            assert a == pytest.approx(b, abs=1e-4)


@_needs_wd
def test_falls_back_to_pytorch_when_graphs_missing(tmp_path):
    ev = OnnxGnubgEvaluator(tmp_path / "does-not-exist")
    assert ev.backend == "pytorch"
    ref = GnubgEvaluator(faithful=False)
    for rec in _records()[::20]:
        b0, b1 = rec["board0"], rec["board1"]
        assert ev.evaluate(b0, b1)[1] == pytest.approx(ref.evaluate(b0, b1)[1])


def test_allow_fallback_false_raises(tmp_path):
    with pytest.raises(Exception):
        OnnxGnubgEvaluator(tmp_path / "does-not-exist", allow_fallback=False)
