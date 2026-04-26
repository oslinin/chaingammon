import base64
match_id = "MAFSAAAAAAAE"
b = base64.b64decode(match_id + "==")
turn = (b[1] >> 3) & 1
print(f"turn={turn}")
