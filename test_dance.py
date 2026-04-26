import subprocess
import base64

def get_output(cmds):
    proc = subprocess.Popen(["gnubg", "-t", "-q"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.communicate("set player 0 human\nset player 1 human\n" + cmds)[0]

# Set up a closed board for player 1 (X)
# Wait, let's just make player 0 roll 4,4 at Move 34.
print(get_output("set matchid MAFSAAAAAAAE\nset board cAlHAAAAAAAE\nhint\nshow board\n"))
