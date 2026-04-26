import os
import sys
from pathlib import Path

# The project root is two directories up from this file's location
ROOT_DIR = Path(__file__).parent.parent.parent

def test_directory_structure():
    assert (ROOT_DIR / "server").is_dir(), "server directory is missing"
    assert (ROOT_DIR / "contracts").is_dir(), "contracts directory is missing"
    assert (ROOT_DIR / "frontend").is_dir(), "frontend directory is missing"

def test_python_version():
    assert sys.version_info >= (3, 11), "Python 3.11+ is required"

def test_server_dependencies_installed():
    import fastapi
    import pydantic
    import web3
    import httpx
    import pytest
    assert fastapi
    assert pydantic
    assert web3
    assert httpx
    assert pytest

def test_env_examples_exist():
    assert (ROOT_DIR / "server" / ".env.example").is_file(), "server/.env.example missing"
    assert (ROOT_DIR / "contracts" / ".env.example").is_file(), "contracts/.env.example missing"
    assert (ROOT_DIR / "frontend" / ".env.example").is_file(), "frontend/.env.example missing"

def test_gitignore_covers_artifacts():
    gitignore_path = ROOT_DIR / ".gitignore"
    assert gitignore_path.is_file(), ".gitignore missing"
    
    with open(gitignore_path) as f:
        content = f.read()
        
    assert ".env" in content, ".env should be ignored"
import subprocess
import os
import signal

def test_server_starts():
    proc = subprocess.Popen(
        ["uv", "run", "uvicorn", "app.main:app", "--port", "8005"], 
        cwd=ROOT_DIR / "server",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=os.setsid
    )
    try:
        # If it exits within 3 seconds, it failed to start
        proc.wait(timeout=3)
        stdout, stderr = proc.communicate()
        assert proc.returncode == 0, f"Uvicorn exited early with {proc.returncode}\n{stderr.decode('utf-8')}"
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait()

def test_frontend_starts():
    proc = subprocess.Popen(
        ["npm", "run", "dev", "--", "--port", "3335"], 
        cwd=ROOT_DIR / "frontend",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=os.setsid
    )
    try:
        proc.wait(timeout=3)
        stdout, stderr = proc.communicate()
        assert proc.returncode == 0, f"Next.js exited early with {proc.returncode}\n{stderr.decode('utf-8')}"
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait()

