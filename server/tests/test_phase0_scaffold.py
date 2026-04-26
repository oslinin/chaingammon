"""
Phase 0 scaffold tests.

Done when: all three sub-projects start without errors.
These tests verify the server side of that contract.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]
SERVER = ROOT / "server"
CONTRACTS = ROOT / "contracts"
FRONTEND = ROOT / "frontend"


# --- dependency imports ---

def test_fastapi_importable():
    import fastapi  # noqa: F401

def test_pydantic_importable():
    import pydantic  # noqa: F401

def test_web3_importable():
    import web3  # noqa: F401

def test_httpx_importable():
    import httpx  # noqa: F401

def test_uvicorn_importable():
    import uvicorn  # noqa: F401


# --- python version ---

def test_python_version():
    assert sys.version_info >= (3, 12), f"Need Python 3.12+, got {sys.version}"


# --- directory structure ---

def test_server_app_dir_exists():
    assert (SERVER / "app").is_dir()

def test_server_tests_dir_exists():
    assert (SERVER / "tests").is_dir()

def test_contracts_src_dir_exists():
    assert (CONTRACTS / "src").is_dir()

def test_contracts_test_dir_exists():
    assert (CONTRACTS / "test").is_dir()

def test_frontend_app_dir_exists():
    assert (FRONTEND / "app").is_dir()


# --- config files ---

def test_server_pyproject_exists():
    assert (SERVER / "pyproject.toml").is_file()

def test_contracts_hardhat_config_exists():
    assert (CONTRACTS / "hardhat.config.js").is_file()

def test_frontend_package_json_exists():
    assert (FRONTEND / "package.json").is_file()


# --- .env.example files ---

def test_server_env_example_exists():
    assert (SERVER / ".env.example").is_file()

def test_contracts_env_example_exists():
    assert (CONTRACTS / ".env.example").is_file()

def test_frontend_env_example_exists():
    assert (FRONTEND / ".env.example").is_file()

def test_server_env_example_has_rpc_url():
    content = (SERVER / ".env.example").read_text()
    assert "RPC_URL" in content

def test_server_env_example_has_chain_id():
    content = (SERVER / ".env.example").read_text()
    assert "CHAIN_ID=16602" in content

def test_contracts_env_example_has_deployer_key():
    content = (CONTRACTS / ".env.example").read_text()
    assert "DEPLOYER_PRIVATE_KEY" in content

def test_frontend_env_example_has_api_url():
    content = (FRONTEND / ".env.example").read_text()
    assert "NEXT_PUBLIC_API_URL" in content


# --- hardhat compile ---

def test_hardhat_compiles():
    result = subprocess.run(
        ["npx", "hardhat", "compile"],
        cwd=CONTRACTS,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


# --- frontend dependencies declared ---

def test_frontend_declares_wagmi():
    import json
    pkg = json.loads((FRONTEND / "package.json").read_text())
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    assert "wagmi" in deps

def test_frontend_declares_viem():
    import json
    pkg = json.loads((FRONTEND / "package.json").read_text())
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    assert "viem" in deps

def test_frontend_declares_next():
    import json
    pkg = json.loads((FRONTEND / "package.json").read_text())
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    assert "next" in deps
