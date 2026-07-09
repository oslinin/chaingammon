import { Board, OPENING_BOARD } from "./rules_engine";

export function encodePositionId(board: Board): string {
    const buf = new Uint8Array(10);
    let bitOffset = 0;

    function pushBits(val: number, len: number) {
        for (let i = 0; i < len; i++) {
            const byteIdx = Math.floor(bitOffset / 8);
            const bitInByte = bitOffset % 8;
            if ((val & (1 << i)) !== 0) {
                buf[byteIdx] |= (1 << bitInByte);
            }
            bitOffset++;
        }
    }

    for (let i = 0; i < 24; i++) {
        const count = board.points[23 - i] > 0 ? board.points[23 - i] : 0;
        for (let j = 0; j < count; j++) pushBits(1, 1);
        pushBits(0, 1);
    }
    const bar0 = board.bar[0];
    for (let j = 0; j < bar0; j++) pushBits(1, 1);
    pushBits(0, 1);

    for (let i = 0; i < 24; i++) {
        const count = board.points[i] < 0 ? -board.points[i] : 0;
        for (let j = 0; j < count; j++) pushBits(1, 1);
        pushBits(0, 1);
    }
    const bar1 = board.bar[1];
    for (let j = 0; j < bar1; j++) pushBits(1, 1);
    pushBits(0, 1);

    let binary = '';
    for (let i = 0; i < buf.byteLength; i++) {
        binary += String.fromCharCode(buf[i]);
    }
    return btoa(binary).slice(0, 14);
}

export function encodeMatchId(turn: number, matchLength: number, score: [number, number], gameOver: boolean, resign: number = 0): string {
    const buf = new Uint8Array(9);
    let bitOffset = 0;

    function pushBits(val: number, len: number) {
        for (let i = 0; i < len; i++) {
            const byteIdx = Math.floor(bitOffset / 8);
            const bitInByte = bitOffset % 8;
            if ((val & (1 << i)) !== 0) {
                buf[byteIdx] |= (1 << bitInByte);
            }
            bitOffset++;
        }
    }

    pushBits(0, 4);
    pushBits(3, 2);
    pushBits(turn, 1);
    pushBits(0, 1);
    const state = gameOver ? (resign ? 2 : 1) : 0;
    pushBits(state, 3);
    pushBits(turn, 1);
    pushBits(0, 1);
    pushBits(score[0], 15);
    pushBits(score[1], 15);
    pushBits(matchLength, 15);
    pushBits(0, 1);
    pushBits(0, 4);
    pushBits(0, 3);
    pushBits(0, 1);

    let binary = '';
    for (let i = 0; i < buf.byteLength; i++) {
        binary += String.fromCharCode(buf[i]);
    }
    return btoa(binary).slice(0, 12);
}
