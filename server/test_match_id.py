import base64
b = base64.b64decode("MAFlAAAAAAAE" + "==")
bits = ""
for byte in b:
    bits += "".join(str((byte >> i) & 1) for i in range(8))
print(bits[0:16])
