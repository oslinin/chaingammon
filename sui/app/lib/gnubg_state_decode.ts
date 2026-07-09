import { Board } from "./rules_engine";

export function decodePositionId(posId: string): Board {
    // Decode base64 to bits
    const binary = atob(posId);
    let bitOffset = 0;

    function readBit(): number {
        const byteIdx = Math.floor(bitOffset / 8);
        const bitInByte = bitOffset % 8;
        if (byteIdx >= binary.length) return 0;
        const val = binary.charCodeAt(byteIdx);
        const bit = (val & (1 << bitInByte)) !== 0 ? 1 : 0;
        bitOffset++;
        return bit;
    }

    const board = new Array(24).fill(0);
    const bar: [number, number] = [0, 0];
    const off: [number, number] = [0, 0];

    // Player 0 (positive counts)
    for (let i = 0; i < 24; i++) {
        let count = 0;
        while (readBit() === 1) count++;
        // Position id stores player 0's point 24 first
        board[23 - i] = count;
    }
    let bar0 = 0;
    while (readBit() === 1) bar0++;
    bar[0] = bar0;

    // Player 1 (negative counts)
    for (let i = 0; i < 24; i++) {
        let count = 0;
        while (readBit() === 1) count++;
        // Position id stores player 1's point 1 first
        if (count > 0) board[i] = -count;
    }
    let bar1 = 0;
    while (readBit() === 1) bar1++;
    bar[1] = bar1;

    // Off counts are not in position id, they are derived later or assumed 0 in the simplest decode
    // Actually we can deduce off counts because total checkers = 15
    const sum0 = board.reduce((acc, c) => acc + (c > 0 ? c : 0), 0) + bar[0];
    const sum1 = board.reduce((acc, c) => acc + (c < 0 ? -c : 0), 0) + bar[1];
    off[0] = 15 - sum0;
    off[1] = 15 - sum1;

    return { points: board, bar, off };
}
