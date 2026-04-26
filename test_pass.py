import subprocess

def get_output(cmds):
    proc = subprocess.Popen(["gnubg", "-t", "-q"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.communicate(cmds)[0]

print(get_output("set matchid MAFSAAAAAAAE\nset board cAlHAAAAAAAAAA\nset player 0 gnubg\nplay\nshow board\n"))
