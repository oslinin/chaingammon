import base64

def decode_position_id(pos_id: str):
    b = base64.b64decode(pos_id + "==")
    bits = ""
    for byte in b:
        # gnubg uses little-endian bit order!
        bits += "".join(str((byte >> i) & 1) for i in range(8))
    
    def parse_player(bits_iter):
        points = []
        count = 0
        for _ in range(25): # 24 points + bar
            while next(bits_iter) == '1':
                count += 1
            points.append(count)
            count = 0
        return points

    bits_iter = iter(bits)
    player0 = parse_player(bits_iter)
    player1 = parse_player(bits_iter)
    
    return player0, player1

print(decode_position_id("4HPwATDgc/ABMA"))
