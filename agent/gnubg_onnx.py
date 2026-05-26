"""gnubg_onnx.py — ONNX export and ONNX-first evaluation of the gnubg nets.

The serving half of mint-helper request #2. The faithful PyTorch evaluator in
agent/gnubg_net.py is the reference; for inference we want the same net to run
through ONNX Runtime (fast, and the format the browser already loads — see
frontend/public/backgammon_net.onnx). `export_gnubg_onnx` writes one ONNX graph
per position class (contact / race / crashed); `OnnxGnubgEvaluator` runs them,
transparently falling back to the PyTorch GnubgNet when ONNX Runtime or the
exported files are unavailable, so callers get one evaluator that works
everywhere.

Only the net forward pass is exported. Classification, the input encoders, the
SanityCheck clamps and the cubeless-equity formula stay in Python (they are
control flow / table lookups, not tensor ops) and are shared with the PyTorch
path, so the two backends agree to within float tolerance. The exported graphs
use the exact `torch.sigmoid` activation (faithful=False) — gnubg's table-based
logistic is a runtime approximation we deliberately don't bake into ONNX.
"""
from __future__ import annotations

from pathlib import Path

from gnubg_net import (
    CLASS_CONTACT,
    CLASS_CRASHED,
    CLASS_OVER,
    DEFAULT_WD_PATH,
    GnubgEvaluator,
    GnubgNet,
    GnubgNetWeights,
    calculate_contact_inputs,
    calculate_crashed_inputs,
    calculate_race_inputs,
    classify_position,
    equity_from_outputs,
    load_gnubg_wd,
    sanity_check,
)

ONNX_NET_CLASSES = ("contact", "race", "crashed")
ONNX_INPUT_NAME = "inputs"
ONNX_OUTPUT_NAME = "outputs"


def export_gnubg_onnx(
    nets: dict[str, GnubgNetWeights] | None = None,
    out_dir: str | Path = ".",
    *,
    wd_path: str | Path = DEFAULT_WD_PATH,
    opset: int = 11,
) -> dict[str, Path]:
    """Export the contact/race/crashed gnubg nets to ONNX.

    Writes gnubg_<class>.onnx into `out_dir` and returns {class: path}. Each
    graph takes a float32 `inputs` tensor [batch, N] (N = that net's input
    width) and returns the five raw outputs [batch, 5] before SanityCheck.
    """
    import torch
    import torch.onnx

    if nets is None:
        nets = load_gnubg_wd(wd_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    paths: dict[str, Path] = {}
    for name in ONNX_NET_CLASSES:
        net = GnubgNet(nets[name], faithful=False)
        net.eval()
        dummy = torch.zeros(1, net.c_input, dtype=torch.float32)
        path = out_dir / f"gnubg_{name}.onnx"
        torch.onnx.export(
            net,
            (dummy,),
            str(path),
            input_names=[ONNX_INPUT_NAME],
            output_names=[ONNX_OUTPUT_NAME],
            dynamic_axes={ONNX_INPUT_NAME: {0: "batch"}, ONNX_OUTPUT_NAME: {0: "batch"}},
            opset_version=opset,
            dynamo=False,
        )
        paths[name] = path
    return paths


class OnnxGnubgEvaluator:
    """gnubg's 0-ply evaluator backed by ONNX Runtime, with a PyTorch fallback.

    Mirrors GnubgEvaluator.evaluate. On construction it tries to load ONNX
    Runtime and the three exported graphs from `onnx_dir`; if either is
    unavailable it falls back to a PyTorch GnubgEvaluator (unless
    allow_fallback=False, which re-raises). `backend` is "onnx" or "pytorch".
    """

    def __init__(
        self,
        onnx_dir: str | Path,
        *,
        wd_path: str | Path = DEFAULT_WD_PATH,
        allow_fallback: bool = True,
    ) -> None:
        self._sessions: dict | None = None
        self._fallback: GnubgEvaluator | None = None
        onnx_dir = Path(onnx_dir)
        try:
            import onnxruntime as ort

            self._sessions = {
                name: ort.InferenceSession(
                    str(onnx_dir / f"gnubg_{name}.onnx"),
                    providers=["CPUExecutionProvider"],
                )
                for name in ONNX_NET_CLASSES
            }
            self.backend = "onnx"
        except Exception:
            if not allow_fallback:
                raise
            self._fallback = GnubgEvaluator(wd_path=wd_path, faithful=False)
            self.backend = "pytorch"

    def evaluate(self, board0, board1) -> tuple[list[float], float]:
        if self._sessions is None:
            return self._fallback.evaluate(board0, board1)  # type: ignore[union-attr]

        cls = classify_position(board0, board1)
        if cls == CLASS_OVER:
            return [0.0, 0.0, 0.0, 0.0, 0.0], -1.0
        if cls == CLASS_CONTACT:
            feats, name = calculate_contact_inputs(board0, board1), "contact"
        elif cls == CLASS_CRASHED:
            feats, name = calculate_crashed_inputs(board0, board1), "crashed"
        else:
            feats, name = calculate_race_inputs(board0, board1), "race"

        import numpy as np

        x = np.asarray([feats], dtype=np.float32)
        out = self._sessions[name].run(None, {ONNX_INPUT_NAME: x})[0][0].tolist()
        out = sanity_check(board0, board1, out)
        return out, equity_from_outputs(out)
