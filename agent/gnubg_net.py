"""gnubg_net.py — faithful PyTorch translation of GNU Backgammon's evaluator.

GNU Backgammon (gnubg) is the open-source backgammon engine whose published
neural-network weights this project already ships encrypted on 0G Storage
(server/app/weights.py). Until now nothing actually *ran* those weights: the
per-agent BackgammonNet in agent/sample_trainer.py initialised its first layer
from a deterministic Xavier stand-in (`gnubg_published_core_init`), not from
gnubg at all.

This module is the keystone that makes "use real gnubg weights" possible. It:

  1. Parses gnubg's binary weights dump (gnubg.wd) into PyTorch tensors —
     `load_gnubg_wd`. The file holds six feed-forward nets in a fixed order:
     contact, race, crashed, then three smaller "pruning" nets (used by gnubg
     only to filter candidate moves during multi-ply search).
  2. Reproduces gnubg's exact input encoding — the 250-input contact/crashed
     features and the 214-input race features — including the (in)famous
     side-swap in CalculateContactInputs that gnubg's author introduced "by
     accident when I trained the net" and never corrected. Bit-faithful to
     gnubg 1.07.001 lib/inputs.c + eval.c.
  3. Runs the same forward pass gnubg uses (beta-scaled logistic at both
     layers) and the same cubeless-equity readout.

Board convention follows gnubg's `TanBoard`: `board0` and `board1` are each 25
ints — indices 0..23 are that side's points 1..24 *from its own perspective*,
index 24 is the bar. `board0` is the side on roll. This is exactly what
gnubg's Python `board()` returns, so positions round-trip without remapping.

The translation is validated against the gnubg binary itself (0-ply oracle) in
agent/tests/test_gnubg_net.py.
"""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import torch
from torch import nn

# Default location of gnubg's weights dump on Debian/Ubuntu (the gnubg-data
# package). `server/app/weights.py` reads the same path.
DEFAULT_WD_PATH = "/usr/lib/gnubg/gnubg.wd"

WEIGHTS_MAGIC_BINARY = 472.3782  # gnubg's float magic + endianness marker.

# ---------------------------------------------------------------------------
# Net layout constants (eval.c)
# ---------------------------------------------------------------------------
MINPPERPOINT = 4
MORE_INPUTS = 25                       # derived contact inputs per side
NUM_INPUTS = (25 * MINPPERPOINT + MORE_INPUTS) * 2          # 250
HALF_RACE_INPUTS = 107
NUM_RACE_INPUTS = HALF_RACE_INPUTS * 2                      # 214
NUM_PRUNING_INPUTS = 25 * MINPPERPOINT * 2                  # 200

# Order the six nets appear in gnubg.wd (eval.c:EvalInitialise).
NET_NAMES = ("contact", "race", "crashed", "prune_contact", "prune_crashed", "prune_race")

# Derived contact-input slot indices, within a 25-wide per-side block (eval.c).
I_OFF1, I_OFF2, I_OFF3 = 0, 1, 2
I_BREAK_CONTACT = 3
I_BACK_CHEQUER = 4
I_BACK_ANCHOR = 5
I_FORWARD_ANCHOR = 6
I_PIPLOSS = 7
I_P1 = 8
I_P2 = 9
I_BACKESCAPES = 10
I_ACONTAIN = 11
I_ACONTAIN2 = 12
I_CONTAIN = 13
I_CONTAIN2 = 14
I_MOBILITY = 15
I_MOMENT2 = 16
I_ENTER = 17
I_ENTER2 = 18
I_TIMING = 19
I_BACKBONE = 20
I_BACKG = 21
I_BACKG1 = 22
I_FREEPIP = 23
I_BACKRESCAPES = 24

# Race-input slot indices (eval.c).
RI_OFF = 92
RI_NCROSS = 92 + 14

# gnubg position classes (eval.h). Only the three net classes are produced
# here; bearoff databases (classes < 8) are a later stage.
CLASS_OVER = 0
CLASS_RACE = 8
CLASS_CRASHED = 9
CLASS_CONTACT = 10

# Per-point base-input lookup (lib/inputs.c `inpvec`): (n==1, n==2, n>=3, extra).
_INPVEC = [
    (0.0, 0.0, 0.0, 0.0),
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 1.0, 0.0, 0.0),
] + [(0.0, 0.0, 1.0, (n - 3) / 2.0) for n in range(3, 16)]

# Bar base-input lookup (`inpvecb`): cumulative (n>=1, n>=2, n>=3, extra).
_INPVECB = [
    (0.0, 0.0, 0.0, 0.0),
    (1.0, 0.0, 0.0, 0.0),
    (1.0, 1.0, 0.0, 0.0),
] + [(1.0, 1.0, 1.0, (n - 3) / 2.0) for n in range(3, 16)]

# anPoint[n] == 1 iff a point with n chequers blocks (n >= 2) — eval.c:236.
_AN_POINT = [0, 0] + [1] * 14


# ---------------------------------------------------------------------------
# Escape tables (eval.c ComputeTable0/1 + Escapes/Escapes1)
# ---------------------------------------------------------------------------
def _compute_escape_tables() -> tuple[list[int], list[int]]:
    an_escapes = [0] * 0x1000
    for i in range(0x1000):
        c = 0
        for n0 in range(6):
            for n1 in range(n0 + 1):
                if not (i & (1 << (n0 + n1 + 1))) and not ((i & (1 << n0)) and (i & (1 << n1))):
                    c += 1 if n0 == n1 else 2
        an_escapes[i] = c

    an_escapes1 = [0] * 0x1000
    for i in range(1, 0x1000):
        c = 0
        low = 0
        while not (i & (1 << low)):
            low += 1
        for n0 in range(6):
            for n1 in range(n0 + 1):
                if (n0 + n1 + 1 > low) and not (i & (1 << (n0 + n1 + 1))) \
                        and not ((i & (1 << n0)) and (i & (1 << n1))):
                    c += 1 if n0 == n1 else 2
        an_escapes1[i] = c
    return an_escapes, an_escapes1


_AN_ESCAPES, _AN_ESCAPES1 = _compute_escape_tables()


def _escapes(an_board: Sequence[int], n: int, *, table: list[int]) -> int:
    """gnubg Escapes/Escapes1: number of rolls that move a checker `n` pips
    forward past the blocking points recorded in `an_board`."""
    m = n if n < 12 else 12
    af = 0
    for i in range(m):
        af |= _AN_POINT[an_board[24 + i - n]] << i
    return table[af]


# ---------------------------------------------------------------------------
# Hit-combination tables for the piploss inputs (eval.c CalculateHalfInputs)
# ---------------------------------------------------------------------------
_AAN_COMBINATION = [
    (0, -1, -1, -1, -1), (1, 2, -1, -1, -1), (3, 4, 5, -1, -1), (6, 7, 8, 9, -1),
    (10, 11, 12, -1, -1), (13, 14, 15, 16, 17), (18, 19, 20, -1, -1), (21, 22, 23, 24, -1),
    (25, 26, 27, -1, -1), (28, 29, -1, -1, -1), (30, -1, -1, -1, -1), (31, 32, 33, -1, -1),
    (-1, -1, -1, -1, -1), (-1, -1, -1, -1, -1), (34, -1, -1, -1, -1), (35, -1, -1, -1, -1),
    (-1, -1, -1, -1, -1), (36, -1, -1, -1, -1), (-1, -1, -1, -1, -1), (37, -1, -1, -1, -1),
    (-1, -1, -1, -1, -1), (-1, -1, -1, -1, -1), (-1, -1, -1, -1, -1), (38, -1, -1, -1, -1),
]

# (fAll, (intermediate points), nFaces, nPips)
_A_INTERMEDIATE = [
    (1, (0, 0, 0), 1, 1), (1, (0, 0, 0), 1, 2), (1, (1, 0, 0), 2, 2), (1, (0, 0, 0), 1, 3),
    (0, (1, 2, 0), 2, 3), (1, (1, 2, 0), 3, 3), (1, (0, 0, 0), 1, 4), (0, (1, 3, 0), 2, 4),
    (1, (2, 0, 0), 2, 4), (1, (1, 2, 3), 4, 4), (1, (0, 0, 0), 1, 5), (0, (1, 4, 0), 2, 5),
    (0, (2, 3, 0), 2, 5), (1, (0, 0, 0), 1, 6), (0, (1, 5, 0), 2, 6), (0, (2, 4, 0), 2, 6),
    (1, (3, 0, 0), 2, 6), (1, (2, 4, 0), 3, 6), (0, (1, 6, 0), 2, 7), (0, (2, 5, 0), 2, 7),
    (0, (3, 4, 0), 2, 7), (0, (2, 6, 0), 2, 8), (0, (3, 5, 0), 2, 8), (1, (4, 0, 0), 2, 8),
    (1, (2, 4, 6), 4, 8), (0, (3, 6, 0), 2, 9), (0, (4, 5, 0), 2, 9), (1, (3, 6, 0), 3, 9),
    (0, (4, 6, 0), 2, 10), (1, (5, 0, 0), 2, 10), (0, (5, 6, 0), 2, 11), (1, (6, 0, 0), 2, 12),
    (1, (4, 8, 0), 3, 12), (1, (3, 6, 9), 4, 12), (1, (5, 10, 0), 3, 15), (1, (4, 8, 12), 4, 16),
    (1, (6, 12, 0), 3, 18), (1, (5, 10, 15), 4, 20), (1, (6, 12, 18), 4, 24),
]

_AA_ROLL = [
    (0, 2, 5, 9), (1, 8, 17, 24), (3, 16, 27, 33), (6, 23, 32, 35), (10, 29, 34, 37),
    (13, 31, 36, 38), (0, 1, 4, -1), (0, 3, 7, -1), (1, 3, 12, -1), (0, 6, 11, -1),
    (1, 6, 15, -1), (3, 6, 20, -1), (0, 10, 14, -1), (1, 10, 19, -1), (3, 10, 22, -1),
    (6, 10, 26, -1), (0, 13, 18, -1), (1, 13, 21, -1), (3, 13, 25, -1), (6, 13, 28, -1),
    (10, 13, 30, -1),
]

# Backbone distance weights (eval.c, the `ac[23]` table).
_BACKBONE_AC = [11, 11, 11, 11, 11, 11, 11, 6, 5, 4, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]


def _msb32(x: int) -> int:
    """Index of the most-significant set bit (gnubg msb32). x must be > 0."""
    return x.bit_length() - 1


def _calc_half_inputs(an_board: Sequence[int], an_board_opp: Sequence[int]) -> list[float]:
    """Port of gnubg CalculateHalfInputs — the 22 derived inputs at slots
    I_BREAK_CONTACT..I_BACKRESCAPES for one side. Slots I_OFF1..I_OFF3 are
    left at 0.0 here; the caller fills them via menOff*.
    """
    af = [0.0] * MORE_INPUTS

    # nOppBack: distance of the opponent's most-backward chequer (local var).
    # The -1 sentinel (empty side) must survive, matching the C for-loop.
    n_opp_back = -1
    for k in range(24, -1, -1):
        if an_board_opp[k]:
            n_opp_back = k
            break
    n_opp_back = 23 - n_opp_back

    # I_BREAK_CONTACT
    np = 0
    for i in range(n_opp_back + 1, 25):
        if an_board[i]:
            np += (i + 1 - n_opp_back) * an_board[i]
    af[I_BREAK_CONTACT] = np / (15 + 152.0)

    # I_FREEPIP
    p = 0
    for i in range(0, n_opp_back):
        if an_board[i]:
            p += (i + 1) * an_board[i]
    af[I_FREEPIP] = p / 100.0

    # I_TIMING
    t = 0
    no = 0
    m = n_opp_back if n_opp_back >= 11 else 11
    t += 24 * an_board[24]
    no += an_board[24]
    i = 23
    while i > m:
        if an_board[i] and an_board[i] != 2:
            ns = (an_board[i] - 2) if an_board[i] > 2 else 1
            no += ns
            t += i * ns
        i -= 1
    while i >= 6:
        if an_board[i]:
            nc = an_board[i]
            no += nc
            t += i * nc
        i -= 1
    for i in range(5, -1, -1):
        if an_board[i] > 2:
            t += i * (an_board[i] - 2)
            no += an_board[i] - 2
        elif an_board[i] < 2:
            nm = 2 - an_board[i]
            if no >= nm:
                t -= i * nm
                no -= nm
    af[I_TIMING] = t / 100.0

    # Back chequer / back anchor / forward anchor
    n_back = -1
    for k in range(24, -1, -1):
        if an_board[k]:
            n_back = k
            break
    af[I_BACK_CHEQUER] = n_back / 24.0

    i = 23 if n_back == 24 else n_back
    while i >= 0:
        if an_board[i] >= 2:
            break
        i -= 1
    af[I_BACK_ANCHOR] = i / 24.0

    n = 0
    for j in range(18, i + 1):
        if an_board[j] >= 2:
            n = 24 - j
            break
    if n == 0:
        for j in range(17, 11, -1):
            if an_board[j] >= 2:
                n = 24 - j
                break
    af[I_FORWARD_ANCHOR] = 2.0 if n == 0 else n / 6.0

    # Piploss / P1 / P2 — count shots that hit opponent blots.
    n_board = 0
    for i in range(6):
        if an_board[i]:
            n_board += 1

    a_hit = [0] * 39
    for i in range((23 if n_board > 2 else 21), -1, -1):
        if an_board_opp[i] != 1:
            continue
        for j in range(24 - i, 25):
            if not an_board[j] or (j < 6 and an_board[j] == 2):
                continue
            for nn in range(5):
                comb = _AAN_COMBINATION[j - 24 + i][nn]
                if comb == -1:
                    break
                f_all, inter, n_faces, _n_pips = _A_INTERMEDIATE[comb]
                blocked = False
                if f_all:
                    if n_faces > 1:
                        for k in range(3):
                            if inter[k] <= 0:
                                break
                            if an_board_opp[i - inter[k]] > 1:
                                blocked = True
                                break
                else:
                    if an_board_opp[i - inter[0]] > 1 and an_board_opp[i - inter[1]] > 1:
                        blocked = True
                if not blocked:
                    a_hit[comb] |= 1 << j

    # aRoll[i] = [nChequers, nPips]
    a_roll = [[0, 0] for _ in range(21)]

    if not an_board[24]:
        for i in range(21):
            n = -1
            for j in range(4):
                r = _AA_ROLL[i][j]
                if r < 0:
                    break
                if not a_hit[r]:
                    continue
                _f, inter, n_faces, n_pips = _A_INTERMEDIATE[r]
                if n_faces == 1:
                    k = _msb32(a_hit[r])
                    if n != k or an_board[k] > 1:
                        a_roll[i][0] += 1
                    n = k
                    if k - n_pips + 1 > a_roll[i][1]:
                        a_roll[i][1] = k - n_pips + 1
                    if _AA_ROLL[i][3] >= 0 and (a_hit[r] & ~(1 << k)):
                        a_roll[i][0] += 1
                else:
                    if a_roll[i][0] == 0:
                        a_roll[i][0] = 1
                    k = _msb32(a_hit[r])
                    if k - n_pips + 1 > a_roll[i][1]:
                        a_roll[i][1] = k - n_pips + 1
                    for l in range(3):
                        if inter[l] <= 0:
                            break
                        if an_board_opp[23 - k + inter[l]] == 1:
                            a_roll[i][0] += 1
                            break
    elif an_board[24] == 1:
        for i in range(21):
            n = 0
            for j in range(4):
                r = _AA_ROLL[i][j]
                if r < 0:
                    break
                if not a_hit[r]:
                    continue
                _f, inter, n_faces, n_pips = _A_INTERMEDIATE[r]
                if n_faces == 1:
                    for k in range(24, 0, -1):
                        if a_hit[r] & (1 << k):
                            if n and k != 24:
                                break
                            if k != 24:
                                npip = _A_INTERMEDIATE[_AA_ROLL[i][1 - j]][3]
                                if an_board_opp[npip - 1] > 1:
                                    break
                                n = 1
                            a_roll[i][0] += 1
                            if k - n_pips + 1 > a_roll[i][1]:
                                a_roll[i][1] = k - n_pips + 1
                else:
                    if not (a_hit[r] & (1 << 24)):
                        continue
                    if a_roll[i][0] == 0:
                        a_roll[i][0] = 1
                    if 25 - n_pips > a_roll[i][1]:
                        a_roll[i][1] = 25 - n_pips
                    for k in range(3):
                        if inter[k] <= 0:
                            break
                        if an_board_opp[inter[k] + 1] == 1:
                            a_roll[i][0] += 1
                            break
    else:
        for i in range(21):
            for j in range(2):
                r = _AA_ROLL[i][j]
                if not (a_hit[r] & (1 << 24)):
                    continue
                _f, _inter, n_faces, n_pips = _A_INTERMEDIATE[r]
                if n_faces != 1:
                    continue
                a_roll[i][0] += 1
                if 25 - n_pips > a_roll[i][1]:
                    a_roll[i][1] = 25 - n_pips

    np = n1 = n2 = 0
    for i in range(6):
        nc = a_roll[i][0]
        np += a_roll[i][1]
        if nc > 0:
            n1 += 1
            if nc > 1:
                n2 += 1
    for i in range(6, 21):
        nc = a_roll[i][0]
        np += a_roll[i][1] * 2
        if nc > 0:
            n1 += 2
            if nc > 1:
                n2 += 2
    af[I_PIPLOSS] = np / (12.0 * 36.0)
    af[I_P1] = n1 / 36.0
    af[I_P2] = n2 / 36.0

    af[I_BACKESCAPES] = _escapes(an_board, 23 - n_opp_back, table=_AN_ESCAPES) / 36.0
    af[I_BACKRESCAPES] = _escapes(an_board, 23 - n_opp_back, table=_AN_ESCAPES1) / 36.0

    n = 36
    i = 15
    while i < 24 - n_opp_back:
        j = _escapes(an_board, i, table=_AN_ESCAPES)
        if j < n:
            n = j
        i += 1
    af[I_ACONTAIN] = (36 - n) / 36.0
    af[I_ACONTAIN2] = af[I_ACONTAIN] * af[I_ACONTAIN]

    if n_opp_back < 0:
        i = 15
        n = 36
    while i < 24:
        j = _escapes(an_board, i, table=_AN_ESCAPES)
        if j < n:
            n = j
        i += 1
    af[I_CONTAIN] = (36 - n) / 36.0
    af[I_CONTAIN2] = af[I_CONTAIN] * af[I_CONTAIN]

    n = 0
    for i in range(6, 25):
        if an_board[i]:
            n += (i - 5) * an_board[i] * _escapes(an_board_opp, i, table=_AN_ESCAPES)
    af[I_MOBILITY] = n / 3600.0

    j = 0
    n = 0
    for i in range(25):
        ni = an_board[i]
        if ni:
            j += ni
            n += i * ni
    n = (n + j - 1) // j
    j = 0
    k = 0
    for i in range(n + 1, 25):
        ni = an_board[i]
        if ni:
            j += ni
            k += ni * (i - n) * (i - n)
    if j:
        k = (k + j - 1) // j
    af[I_MOMENT2] = k / 400.0

    if an_board[24] > 0:
        loss = 0
        two = an_board[24] > 1
        for i in range(6):
            if an_board_opp[i] > 1:
                loss += 4 * (i + 1)
                for j in range(i + 1, 6):
                    if an_board_opp[j] > 1:
                        loss += 2 * (i + j + 2)
                    elif two:
                        loss += 2 * (i + 1)
            elif two:
                for j in range(i + 1, 6):
                    if an_board_opp[j] > 1:
                        loss += 2 * (j + 1)
        af[I_ENTER] = loss / (36.0 * (49.0 / 6.0))
    else:
        af[I_ENTER] = 0.0

    n = 0
    for i in range(6):
        n += 1 if an_board_opp[i] > 1 else 0
    af[I_ENTER2] = (36 - (n - 6) * (n - 6)) / 36.0

    pa = -1
    w = 0
    tot = 0
    for npt in range(23, 0, -1):
        if an_board[npt] >= 2:
            if pa == -1:
                pa = npt
                continue
            d = pa - npt
            w += _BACKBONE_AC[d] * an_board[pa]
            tot += an_board[pa]
    af[I_BACKBONE] = (1.0 - (w / (tot * 11.0))) if tot else 0.0

    n_ac = 0
    for i in range(18, 24):
        if an_board[i] > 1:
            n_ac += 1
    af[I_BACKG] = 0.0
    af[I_BACKG1] = 0.0
    if n_ac >= 1:
        tot = 0
        for i in range(18, 25):
            tot += an_board[i]
        if n_ac > 1:
            af[I_BACKG] = (tot - 3) / 4.0
        else:
            af[I_BACKG1] = tot / 8.0

    return af


def _men_off_non_crashed(an_board: Sequence[int]) -> list[float]:
    """gnubg menOffNonCrashed → I_OFF1..I_OFF3 (contact net)."""
    men_off = 15 - sum(an_board[:25])
    if men_off <= 2:
        return [men_off / 3.0 if men_off else 0.0, 0.0, 0.0]
    if men_off <= 5:
        return [1.0, (men_off - 3) / 3.0, 0.0]
    return [1.0, 1.0, (men_off - 6) / 3.0]


def _men_off_all(an_board: Sequence[int]) -> list[float]:
    """gnubg menOffAll → I_OFF1..I_OFF3 (crashed net)."""
    men_off = 15 - sum(an_board[:25])
    if men_off <= 5:
        return [men_off / 5.0 if men_off else 0.0, 0.0, 0.0]
    if men_off <= 10:
        return [1.0, (men_off - 5) / 5.0, 0.0]
    return [1.0, 1.0, (men_off - 10) / 5.0]


def _base_inputs(board0: Sequence[int], board1: Sequence[int]) -> list[float]:
    """gnubg baseInputs → 200 base features (100 per side)."""
    out = [0.0] * NUM_PRUNING_INPUTS
    for j, board in enumerate((board0, board1)):
        base = j * 25 * 4
        for i in range(24):
            v = _INPVEC[board[i]]
            out[base + i * 4] = v[0]
            out[base + i * 4 + 1] = v[1]
            out[base + i * 4 + 2] = v[2]
            out[base + i * 4 + 3] = v[3]
        v = _INPVECB[board[24]]
        out[base + 24 * 4] = v[0]
        out[base + 24 * 4 + 1] = v[1]
        out[base + 24 * 4 + 2] = v[2]
        out[base + 24 * 4 + 3] = v[3]
    return out


def calculate_contact_inputs(board0: Sequence[int], board1: Sequence[int]) -> list[float]:
    """gnubg CalculateContactInputs → 250 features. Reproduces the side-swap:
    block 0's OFF inputs come from board0 but its half-inputs from (board1,
    board0); block 1 mirrors with (board0, board1)."""
    arr = _base_inputs(board0, board1) + [0.0] * (2 * MORE_INPUTS)
    b0 = MINPPERPOINT * 25 * 2
    off0 = _men_off_non_crashed(board0)
    half0 = _calc_half_inputs(board1, board0)
    for k in range(MORE_INPUTS):
        arr[b0 + k] = off0[k] if k <= I_OFF3 else half0[k]
    b1 = b0 + MORE_INPUTS
    off1 = _men_off_non_crashed(board1)
    half1 = _calc_half_inputs(board0, board1)
    for k in range(MORE_INPUTS):
        arr[b1 + k] = off1[k] if k <= I_OFF3 else half1[k]
    return arr


def calculate_crashed_inputs(board0: Sequence[int], board1: Sequence[int]) -> list[float]:
    """gnubg CalculateCrashedInputs → 250 features (menOffAll, no side-swap of
    the OFF block relative to the half-inputs)."""
    arr = _base_inputs(board0, board1) + [0.0] * (2 * MORE_INPUTS)
    b0 = MINPPERPOINT * 25 * 2
    off0 = _men_off_all(board1)
    half0 = _calc_half_inputs(board1, board0)
    for k in range(MORE_INPUTS):
        arr[b0 + k] = off0[k] if k <= I_OFF3 else half0[k]
    b1 = b0 + MORE_INPUTS
    off1 = _men_off_all(board0)
    half1 = _calc_half_inputs(board0, board1)
    for k in range(MORE_INPUTS):
        arr[b1 + k] = off1[k] if k <= I_OFF3 else half1[k]
    return arr


def calculate_race_inputs(board0: Sequence[int], board1: Sequence[int]) -> list[float]:
    """gnubg CalculateRaceInputs → 214 features (107 per side)."""
    out = [0.0] * NUM_RACE_INPUTS
    for side, board in enumerate((board0, board1)):
        base = side * HALF_RACE_INPUTS
        men_off = 15
        for i in range(23):
            nc = board[i]
            men_off -= nc
            k = i * 4
            out[base + k] = 1.0 if nc == 1 else 0.0
            out[base + k + 1] = 1.0 if nc == 2 else 0.0
            out[base + k + 2] = 1.0 if nc >= 3 else 0.0
            out[base + k + 3] = (nc - 3) / 2.0 if nc > 3 else 0.0
        for k in range(14):
            out[base + RI_OFF + k] = 1.0 if men_off == (k + 1) else 0.0
        n_cross = 0
        for k in range(1, 4):
            for i in range(6 * k, 6 * k + 6):
                nc = board[i]
                if nc:
                    n_cross += nc * k
        out[base + RI_NCROSS] = n_cross / 10.0
    return out


def classify_position(board0: Sequence[int], board1: Sequence[int]) -> int:
    """Port of gnubg ClassifyPosition for standard backgammon. Returns
    CLASS_CONTACT / CLASS_CRASHED / CLASS_RACE / CLASS_OVER. No-contact
    positions that gnubg would route to a bearoff database are reported as
    CLASS_RACE here (bearoff DBs are a later stage)."""
    n_opp_back = -1
    for k in range(24, -1, -1):
        if board0[k]:
            n_opp_back = k
            break
    n_back = -1
    for k in range(24, -1, -1):
        if board1[k]:
            n_back = k
            break
    if n_back < 0 or n_opp_back < 0:
        return CLASS_OVER

    if n_back + n_opp_back > 22:
        N = 6
        for board in (board0, board1):
            tot = sum(board[:25])
            if tot <= N:
                return CLASS_CRASHED
            if board[0] > 1:
                if tot <= (N + board[0]):
                    return CLASS_CRASHED
                if (1 + tot - (board[0] + board[1])) <= N and board[1] > 1:
                    return CLASS_CRASHED
            else:
                if tot <= (N + (board[1] - 1)):
                    return CLASS_CRASHED
        return CLASS_CONTACT
    return CLASS_RACE


def equity_from_outputs(out: Sequence[float]) -> float:
    """gnubg cubeless equity (Utility): the five outputs are
    P(win), P(win gammon), P(win bg), P(lose gammon), P(lose bg)."""
    return 2.0 * out[0] - 1.0 + out[1] + out[2] - out[3] - out[4]


# Output indices (eval.h).
OUTPUT_WIN = 0
OUTPUT_WINGAMMON = 1
OUTPUT_WINBACKGAMMON = 2
OUTPUT_LOSEGAMMON = 3
OUTPUT_LOSEBACKGAMMON = 4


def sanity_check(board0: Sequence[int], board1: Sequence[int], out: list[float]) -> list[float]:
    """Port of gnubg SanityCheck — clamps the raw net outputs to game-legal
    values: a side that has borne off a chequer cannot be gammoned, a back
    chequer outside the opponent home means no backgammon, gammons can't
    exceed wins, backgammons can't exceed gammons, and in contact positions
    sub-1e-4 gammon noise is zeroed. Mutates and returns `out`.

    Orientation matches the input encoders: gnubg's anBoard[0] is `board0`.
    The exact bearoff-database turn count (gnubg MaxTurns via pbc1) is
    approximated by `anCross * 2`, which is gnubg's own fallback when the
    one-sided bearoff database is unavailable; it only affects the rare
    "certain win/loss/gammon" race clamps, not the borne-off clamps."""
    an_board = (board0, board1)
    ac = [0, 0]
    an_back = [0, 0]
    an_cross = [0, 0]
    an_gammon_cross = [1, 1]
    for j in range(2):
        board = an_board[j]
        nciq = 0
        for i in range(0, 6):
            if board[i]:
                an_back[j] = i
                nciq += board[i]
        ac[j] = an_cross[j] = nciq
        nciq = 0
        for i in range(6, 12):
            if board[i]:
                an_back[j] = i
                nciq += board[i]
        ac[j] += nciq
        an_cross[j] += 2 * nciq
        an_gammon_cross[j] += nciq
        nciq = 0
        for i in range(12, 18):
            if board[i]:
                an_back[j] = i
                nciq += board[i]
        ac[j] += nciq
        an_cross[j] += 3 * nciq
        an_gammon_cross[j] += 2 * nciq
        nciq = 0
        for i in range(18, 24):
            if board[i]:
                an_back[j] = i
                nciq += board[i]
        ac[j] += nciq
        an_cross[j] += 4 * nciq
        an_gammon_cross[j] += 3 * nciq
        if board[24]:
            an_back[j] = 24
            ac[j] += board[24]
            an_cross[j] += 5 * board[24]
            an_gammon_cross[j] += 4 * board[24]

    f_contact = an_back[0] + an_back[1] >= 24

    an_max_turns = [1, 1]
    if not f_contact:
        for i in range(2):
            an_max_turns[i] = an_cross[i] * 2
        if not an_max_turns[1]:
            an_max_turns[1] = 1

    if not f_contact and an_cross[0] > 4 * (an_max_turns[1] - 1):
        out[OUTPUT_WIN] = 1.0

    if ac[0] < 15:
        out[OUTPUT_WINGAMMON] = out[OUTPUT_WINBACKGAMMON] = 0.0
    elif not f_contact:
        if an_cross[1] > 8 * an_gammon_cross[0]:
            out[OUTPUT_WINGAMMON] = 0.0
        elif an_gammon_cross[0] > 4 * (an_max_turns[1] - 1):
            out[OUTPUT_WINGAMMON] = 1.0
        if an_back[0] < 18:
            out[OUTPUT_WINBACKGAMMON] = 0.0

    if not f_contact and an_cross[1] > 4 * an_max_turns[0]:
        out[OUTPUT_WIN] = 0.0

    if ac[1] < 15:
        out[OUTPUT_LOSEGAMMON] = out[OUTPUT_LOSEBACKGAMMON] = 0.0
    elif not f_contact:
        if an_cross[0] > 8 * an_gammon_cross[1] - 4:
            out[OUTPUT_LOSEGAMMON] = 0.0
        elif an_gammon_cross[1] > 4 * an_max_turns[0]:
            out[OUTPUT_LOSEGAMMON] = 1.0
        if an_back[1] < 18:
            out[OUTPUT_LOSEBACKGAMMON] = 0.0

    if out[OUTPUT_WINGAMMON] > out[OUTPUT_WIN]:
        out[OUTPUT_WINGAMMON] = out[OUTPUT_WIN]
    lose = 1.0 - out[OUTPUT_WIN]
    if out[OUTPUT_LOSEGAMMON] > lose:
        out[OUTPUT_LOSEGAMMON] = lose
    if out[OUTPUT_WINBACKGAMMON] > out[OUTPUT_WINGAMMON]:
        out[OUTPUT_WINBACKGAMMON] = out[OUTPUT_WINGAMMON]
    if out[OUTPUT_LOSEBACKGAMMON] > out[OUTPUT_LOSEGAMMON]:
        out[OUTPUT_LOSEBACKGAMMON] = out[OUTPUT_LOSEGAMMON]

    if f_contact:
        for i in range(OUTPUT_WINGAMMON, 5):
            if out[i] < 1 / 10000.0:
                out[i] = 0.0
    return out


# ---------------------------------------------------------------------------
# Weights file + forward pass
# ---------------------------------------------------------------------------
@dataclass
class GnubgNetWeights:
    """One gnubg feed-forward net as parsed from gnubg.wd. Weight matrices are
    stored in PyTorch's [out, in] convention (gnubg stores hidden weights
    input-major, so they are transposed on load)."""

    name: str
    c_input: int
    c_hidden: int
    c_output: int
    beta_hidden: float
    beta_output: float
    hidden_weight: torch.Tensor       # [c_hidden, c_input]
    hidden_threshold: torch.Tensor    # [c_hidden]
    output_weight: torch.Tensor       # [c_output, c_hidden]
    output_threshold: torch.Tensor    # [c_output]


def load_gnubg_wd(path: str | Path = DEFAULT_WD_PATH) -> dict[str, GnubgNetWeights]:
    """Parse gnubg's binary weights dump into six `GnubgNetWeights`, keyed by
    NET_NAMES. Raises ValueError if the magic/version or structure is wrong."""
    data = Path(path).read_bytes()
    magic, version = struct.unpack_from("<ff", data, 0)
    if abs(magic - WEIGHTS_MAGIC_BINARY) > 1e-2:
        raise ValueError(f"{path}: bad magic {magic!r} (expected {WEIGHTS_MAGIC_BINARY})")
    off = 8
    nets: dict[str, GnubgNetWeights] = {}
    for name in NET_NAMES:
        c_in, c_hid, c_out, _n_trained = struct.unpack_from("<iiii", data, off)
        beta_h, beta_o = struct.unpack_from("<ff", data, off + 16)
        off += 24
        n_hw = c_in * c_hid
        n_ow = c_out * c_hid
        hw = torch.tensor(struct.unpack_from(f"<{n_hw}f", data, off), dtype=torch.float32)
        off += n_hw * 4
        ow = torch.tensor(struct.unpack_from(f"<{n_ow}f", data, off), dtype=torch.float32)
        off += n_ow * 4
        th = torch.tensor(struct.unpack_from(f"<{c_hid}f", data, off), dtype=torch.float32)
        off += c_hid * 4
        to = torch.tensor(struct.unpack_from(f"<{c_out}f", data, off), dtype=torch.float32)
        off += c_out * 4
        # gnubg stores hidden weights input-major ([input][hidden]); transpose
        # to PyTorch [out, in]. Output weights are already output-major.
        nets[name] = GnubgNetWeights(
            name=name, c_input=c_in, c_hidden=c_hid, c_output=c_out,
            beta_hidden=beta_h, beta_output=beta_o,
            hidden_weight=hw.view(c_in, c_hid).t().contiguous(),
            hidden_threshold=th,
            output_weight=ow.view(c_out, c_hid).contiguous(),
            output_threshold=to,
        )
    if off != len(data):
        raise ValueError(f"{path}: {len(data) - off} trailing bytes after 6 nets")
    return nets


# gnubg's exp lookup table (lib/sigmoid.h): e[i] == exp(i/10)/10. gnubg
# approximates the logistic with a piecewise-linear interpolation over this
# table rather than a true exp; reproducing it makes the forward pass match
# gnubg's *runtime* output (not just its intended model) to float precision.
_E_TABLE = torch.tensor([math.exp(i / 10.0) / 10.0 for i in range(102)], dtype=torch.float32)
_GNUBG_SAT_HI = 19930.370438230298 / 19931.370438230298
_GNUBG_SAT_LO = 1.0 / 19931.370438230298


def gnubg_logistic(z: torch.Tensor) -> torch.Tensor:
    """gnubg's table-based approximation of the logistic 1/(1+e^-z) — the
    activation gnubg actually computes (lib/sigmoid.h `sigmoid`, called as
    sigmoid(-beta·sum)). Use this for runtime-faithful evaluation; the exact
    torch.sigmoid is a (more accurate) drop-in for the same intended model."""
    az = torch.abs(z) * 10.0
    i = torch.clamp(az.floor().to(torch.long), 0, 101)
    ei = _E_TABLE.to(z.device)[i]
    base = 1.0 / (1.0 + ei * ((10.0 - i.to(z.dtype)) + az))
    res = torch.where(z > 0, 1.0 - base, base)
    res = torch.where(z >= 10.0, torch.full_like(z, _GNUBG_SAT_HI), res)
    res = torch.where(z <= -10.0, torch.full_like(z, _GNUBG_SAT_LO), res)
    return res


class GnubgNet(nn.Module):
    """gnubg's feed-forward evaluator for one position class. Forward pass
    matches eval.c Evaluate: hidden = sigmoid(betaH·(Wh·x + thr_h)),
    output = sigmoid(betaO·(Wo·h + thr_o)). gnubg's sigmoid is the standard
    logistic with the layer's beta as gain.

    `faithful=True` swaps in gnubg's exact table-based logistic so the output
    reproduces gnubg's runtime to ~1e-4; the default uses torch.sigmoid, which
    is the same model evaluated more accurately and exports cleanly to ONNX."""

    def __init__(self, w: GnubgNetWeights, *, faithful: bool = False) -> None:
        super().__init__()
        self.beta_hidden = w.beta_hidden
        self.beta_output = w.beta_output
        self.c_input = w.c_input
        self.faithful = faithful
        self.hidden = nn.Linear(w.c_input, w.c_hidden)
        self.output = nn.Linear(w.c_hidden, w.c_output)
        with torch.no_grad():
            self.hidden.weight.copy_(w.hidden_weight)
            self.hidden.bias.copy_(w.hidden_threshold)
            self.output.weight.copy_(w.output_weight)
            self.output.bias.copy_(w.output_threshold)

    def _activate(self, z: torch.Tensor) -> torch.Tensor:
        return gnubg_logistic(z) if self.faithful else torch.sigmoid(z)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self._activate(self.beta_hidden * self.hidden(x))
        return self._activate(self.beta_output * self.output(h))


class GnubgEvaluator:
    """Full gnubg static (0-ply) evaluator: classify a position, encode the
    right inputs, run the matching net, return the five outputs and the
    cubeless equity for the side on roll (board0).

    Bearoff positions are not yet handled by an exact database; they fall
    through to the race net, which is gnubg's own behaviour when bearoff
    databases are disabled (`--no-bearoff`)."""

    def __init__(self, nets: dict[str, GnubgNetWeights] | None = None,
                 wd_path: str | Path = DEFAULT_WD_PATH, *, faithful: bool = False) -> None:
        if nets is None:
            nets = load_gnubg_wd(wd_path)
        self.contact = GnubgNet(nets["contact"], faithful=faithful)
        self.race = GnubgNet(nets["race"], faithful=faithful)
        self.crashed = GnubgNet(nets["crashed"], faithful=faithful)

    def evaluate(self, board0: Sequence[int], board1: Sequence[int]) -> tuple[list[float], float]:
        cls = classify_position(board0, board1)
        if cls == CLASS_OVER:
            return [0.0, 0.0, 0.0, 0.0, 0.0], -1.0
        if cls == CLASS_CONTACT:
            feats = calculate_contact_inputs(board0, board1)
            net = self.contact
        elif cls == CLASS_CRASHED:
            feats = calculate_crashed_inputs(board0, board1)
            net = self.crashed
        else:
            feats = calculate_race_inputs(board0, board1)
            net = self.race
        x = torch.tensor(feats, dtype=torch.float32).unsqueeze(0)
        with torch.no_grad():
            out = net(x).squeeze(0).tolist()
        out = sanity_check(board0, board1, out)
        return out, equity_from_outputs(out)
