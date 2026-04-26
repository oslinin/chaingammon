import subprocess
import time
import sys

def test_startup():
    proc = subprocess.Popen(["npm", "run", "dev"], cwd="frontend", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(3)
    if proc.poll() is not None:
        sys.exit(f"Failed with {proc.returncode}")
    proc.terminate()
    print("Success")

test_startup()
