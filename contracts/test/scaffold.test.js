// Phase 0 scaffold tests — run with: pnpm exec hardhat test test/scaffold.test.js
// Done when: all three sub-projects start without errors.

const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const opts = { stdio: "pipe" };

describe("Phase 0 — Scaffold", function () {
  this.timeout(120_000);

  it("server: uv run uvicorn starts without errors", function () {
    execSync("uv run uvicorn --version", { cwd: path.join(ROOT, "server"), ...opts });
  });

  it("contracts: pnpm exec hardhat compile exits without errors", function () {
    execSync("pnpm exec hardhat compile", { cwd: path.join(ROOT, "contracts"), ...opts });
  });

  it("frontend: pnpm build exits without errors", function () {
    execSync("pnpm build", { cwd: path.join(ROOT, "frontend"), ...opts });
  });
});
