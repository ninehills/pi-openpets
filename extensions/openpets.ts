import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createOpenPetsClient, type OpenPetsClient } from "@open-pets/client";
import { MAX_MESSAGE_LENGTH, type OpenPetsState } from "@open-pets/core";
import { installAndActivatePet } from "@open-pets/installer";
import { basename } from "node:path";

const MAX_PROJECT_NAME = 32;
const MAX_SPEECH = MAX_MESSAGE_LENGTH;
const MAX_DETAIL = 80;
const CONTENT_THROTTLE_MS = 2000;
const SEND_DEBOUNCE_MS = 250;
const TEMP_STATE_MS = 1800;
const LEASE_TTL_MS = 120_000;
const HEARTBEAT_MS = 45_000;

type Runtime = {
  client: OpenPetsClient;
  projectName: string;
  source: string;
  leaseId: string;
  heartbeat?: ReturnType<typeof setInterval>;
  lastKey?: string;
  lastSentAt: number;
  pending?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastContent?: string;
  lastContentAt: number;
};

type ToolKind = { state: OpenPetsState; tool: string };

export default function openPetsPiExtension(pi: ExtensionAPI) {
  let runtime: Runtime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    runtime = createRuntime(ctx);
    try {
      await runtime.client.getHealth({ timeoutMs: 500 });
      await acquireLease(runtime);
      safeSend(runtime, "idle", `Pi(${runtime.projectName}): OpenPets link established.`, "pi.session.start");
    } catch {
      ctx.ui.notify("OpenPets is not running; Pi activity will not be mirrored to the pet.", "warning");
    }
  });

  pi.on("input", async (_event, ctx) => {
    ensureRuntime(ctx);
    safeSend(runtime, "thinking", `Pi(${runtime?.projectName}): New thought incoming.`, "pi.input");
  });

  pi.on("agent_start", async (_event, ctx) => {
    ensureRuntime(ctx);
    safeSend(runtime, "working", `Pi(${runtime?.projectName}): Rolling up my sleeves.`, "pi.agent.start");
  });

  pi.on("turn_start", async (_event, ctx) => {
    ensureRuntime(ctx);
    safeSend(runtime, "thinking", `Pi(${runtime?.projectName}): Thinking...`, "pi.turn.start");
  });

  pi.on("tool_call", async (event, ctx) => {
    ensureRuntime(ctx);
    const kind = classifyTool(event.toolName, isToolCallEventType("bash", event) ? event.input.command : undefined);
    safeSend(runtime, kind.state, `Pi(${runtime?.projectName}): Using ${event.toolName}.`, `pi.tool.${kind.tool}`, kind.tool);
  });

  pi.on("tool_result", async (event, ctx) => {
    ensureRuntime(ctx);
    const kind = classifyTool(event.toolName, getBashCommand(event));
    if (event.isError) {
      safeSend(runtime, "error", `Pi(${runtime?.projectName}): ${kind.tool} stumbled.`, `pi.tool.${kind.tool}.error`, kind.tool);
      return;
    }
    safeSend(runtime, kind.state === "testing" ? "success" : "working", `Pi(${runtime?.projectName}): ${kind.tool} wrapped up.`, `pi.tool.${kind.tool}.done`, kind.tool);
  });

  pi.on("message_update", async (_event, ctx) => {
    ensureRuntime(ctx);
    sendContentPreview(runtime, "working", `Pi(${runtime?.projectName}): Drafting a reply...`, "pi.message.update");
  });

  pi.on("message_end", async (event, ctx) => {
    ensureRuntime(ctx);
    if (event.message?.role !== "assistant") return;
    sendContentPreview(runtime, "success", `Pi(${runtime?.projectName}): Reply ready.`, "pi.message.end", true);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ensureRuntime(ctx);
    safeSend(runtime, "success", `Pi(${runtime?.projectName}): Mission complete.`, "pi.agent.end.success");
    scheduleIdle(runtime);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ensureRuntime(ctx);
    if (!runtime) return;
    clearTimers(runtime);
    await runtime.client.safeSendEvent({ state: "sleeping", source: runtime.source, type: "pi.session.shutdown", message: `Pi(${runtime.projectName}): Logging off.` });
    await runtime.client.leaseRelease(runtime.leaseId, { timeoutMs: 500 }).catch(() => undefined);
  });

  pi.registerCommand("openpets", {
    description: "OpenPets Pi extension commands: install | show | hide | status | test",
    handler: async (args, ctx) => {
      const rt = ensureRuntime(ctx);
      const parts = String(args ?? "status").trim().split(/\s+/).filter(Boolean);
      const action = parts[0] || "status";
      if (action === "install") {
        await handleInstallCommand(parts.slice(1), ctx);
        return;
      }
      if (action === "show" || action === "hide") {
        const result = await rt.client.windowAction(action, { timeoutMs: 1000 }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
        ctx.ui.notify(result instanceof Error ? `OpenPets ${action} failed: ${result.message}` : `OpenPets ${action === "show" ? "shown" : "hidden"}.`, result instanceof Error ? "warning" : "info");
        return;
      }
      if (action === "test") {
        const result = await rt.client.safeSendEvent({ state: "waving", source: rt.source, type: "pi.command.test", message: `Pi(${rt.projectName}): Hello from the Pi bridge.` });
        ctx.ui.notify(result.ok ? "OpenPets test event sent." : `OpenPets test failed: ${result.error.message}`, result.ok ? "info" : "warning");
        return;
      }
      if (action === "status") {
        try {
          const health = await rt.client.getHealth({ timeoutMs: 800 });
          ctx.ui.notify(`OpenPets connected (${health.version ?? "unknown version"}). Source: ${rt.source}`, "info");
        } catch (error) {
          ctx.ui.notify(`OpenPets unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return;
      }
      ctx.ui.notify(`Unknown /openpets command: ${action}. Use install, show, hide, status, or test.`, "warning");
    },
  });

  function ensureRuntime(ctx: ExtensionContext) {
    runtime ??= createRuntime(ctx);
    return runtime;
  }
}

async function handleInstallCommand(args: string[], ctx: ExtensionContext) {
  const source = args.join(" ").trim();
  if (!source) {
    ctx.ui.notify("Usage: /openpets install <zip-url|local-zip|pet-folder>", "warning");
    return;
  }

  ctx.ui.notify("Installing OpenPets pet...", "info");
  const result = await installAndActivatePet(source);
  if (!result.ok) {
    ctx.ui.notify(`OpenPets install failed: ${result.message}`, "warning");
    return;
  }

  if (result.activated) {
    ctx.ui.notify(`Installed and activated ${result.activationDisplayName ?? result.displayName}.`, "info");
  } else if (result.openPetsRunning) {
    ctx.ui.notify(`Installed ${result.displayName}. Restart OpenPets to use it.`, "info");
  } else {
    ctx.ui.notify(`Installed ${result.displayName}. Open OpenPets to use it.`, "info");
  }
}

function createRuntime(ctx: ExtensionContext): Runtime {
  const projectName = sanitizeProjectName(basename(ctx.cwd || process.cwd()));
  const sessionId = sanitizeId(ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? `${Date.now()}`);
  const leaseId = `pi:${projectName}:${sessionId.slice(0, 48)}`;
  return {
    client: createOpenPetsClient({ timeoutMs: 500 }),
    projectName,
    source: leaseId,
    leaseId,
    lastSentAt: 0,
    lastContentAt: 0,
  };
}

async function acquireLease(rt: Runtime) {
  await rt.client.leaseAcquire({ id: rt.leaseId, client: "cli", label: `Pi Agent - ${rt.projectName}`, ttlMs: LEASE_TTL_MS, autoClose: false }, { timeoutMs: 800 });
  rt.heartbeat = setInterval(() => {
    rt.client.leaseHeartbeat({ id: rt.leaseId, ttlMs: LEASE_TTL_MS }, { timeoutMs: 500 }).catch(() => undefined);
  }, HEARTBEAT_MS);
}

function safeSend(rt: Runtime | undefined, state: OpenPetsState, message: string | undefined, type: string, tool?: string) {
  if (!rt) return;
  if (state !== "idle" && rt.idleTimer) {
    clearTimeout(rt.idleTimer);
    rt.idleTimer = undefined;
  }
  const safeMessage = message ? sanitizeSpeech(message) : undefined;
  const key = `${state}|${type}|${tool ?? ""}|${safeMessage ?? ""}`;
  if (rt.lastKey === key && Date.now() - rt.lastSentAt < 1500) return;
  if (rt.pending) clearTimeout(rt.pending);
  rt.pending = setTimeout(() => {
    rt.lastKey = key;
    rt.lastSentAt = Date.now();
    rt.client.safeSendEvent({ state, source: rt.source, type, ...(safeMessage ? { message: safeMessage } : {}), ...(tool ? { tool } : {}) }).catch(() => undefined);
  }, SEND_DEBOUNCE_MS);
}

function scheduleIdle(rt: Runtime | undefined) {
  if (!rt) return;
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  rt.idleTimer = setTimeout(() => safeSend(rt, "idle", `Pi(${rt.projectName}): Back on standby.`, "pi.idle"), TEMP_STATE_MS);
}

function sendContentPreview(rt: Runtime | undefined, state: OpenPetsState, text: string, type: string, force = false) {
  if (!rt) return;
  const detail = truncateDetail(text);
  if (!detail || (!force && Date.now() - rt.lastContentAt < CONTENT_THROTTLE_MS)) return;
  if (detail === rt.lastContent) return;
  rt.lastContent = detail;
  rt.lastContentAt = Date.now();
  safeSend(rt, state, detail, type);
}

function clearTimers(rt: Runtime) {
  if (rt.pending) clearTimeout(rt.pending);
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  if (rt.heartbeat) clearInterval(rt.heartbeat);
}

function getBashCommand(event: { toolName: string; input?: unknown }) {
  if (event.toolName !== "bash" || !event.input || typeof event.input !== "object") return undefined;
  const command = (event.input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function classifyTool(toolName: string, command?: string): ToolKind {
  if (toolName === "edit" || toolName === "write") return { state: "editing", tool: toolName };
  if (toolName === "bash") {
    return looksLikeTest(command) ? { state: "testing", tool: "test" } : { state: "running", tool: "bash" };
  }
  if (["read", "grep", "find_files", "fff_multi_grep"].includes(toolName)) return { state: "working", tool: toolName };
  return { state: "working", tool: safeToolName(toolName) };
}

function looksLikeTest(command = "") {
  return /\b(test|typecheck|check|spec|vitest|jest|pytest|bun\s+test|npm\s+test|pnpm\s+test)\b/i.test(command);
}

function sanitizeProjectName(value: string) {
  return (value || "project").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_PROJECT_NAME) || "project";
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(-64) || `${Date.now()}`;
}

function truncateDetail(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

function safeToolName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "tool";
}

function sanitizeSpeech(value: string) {
  return value.replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH);
}
