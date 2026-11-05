#!/usr/bin/env node
// One-command local demo: Hardhat node -> deploy + seed -> Vite dev server.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8545";
const children = [];

function run(cmd, args, cwd, opts = {}) {
  const child = spawn(cmd, args, { cwd: path.join(root, cwd), stdio: opts.quiet ? ["ignore", "pipe", "inherit"] : "inherit", shell: process.platform === "win32" });
  children.push(child);
  return child;
}

async function rpcReady() {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return res.ok;
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  for (const c of children) c.kill("SIGINT");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await rpcReady()) {
  console.log("› A node is already running on :8545, reusing it.");
} else {
  console.log("› Starting Hardhat node on :8545 …");
  const node = run("npx", ["hardhat", "node", "--hostname", "127.0.0.1"], "contracts", { quiet: true });
  node.on("exit", (c) => { console.error(`Hardhat node exited (${c})`); shutdown(1); });
  for (let i = 0; i < 120 && !(await rpcReady()); i++) await sleep(500);
  if (!(await rpcReady())) { console.error("Hardhat node did not start"); shutdown(1); }
}

console.log("› Deploying contracts and seeding demo data …");
const deploy = run("npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], "contracts");
const code = await new Promise((r) => deploy.on("exit", r));
if (code !== 0) { console.error("Deploy failed"); shutdown(1); }

console.log("› Starting web app on http://localhost:5173 …");
run("npx", ["vite", "--host", "0.0.0.0", "--port", "5173"], "web");
