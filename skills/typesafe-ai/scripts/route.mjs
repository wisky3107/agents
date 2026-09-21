#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  mode: "shadow",
  auto_route: true,
  model: "jev-1.13.0",
  min_confidence: 0.6,
  fail_open: true,
});

function parseScalar(raw) {
  const value = raw.split(/\s+#/, 1)[0].trim().replace(/^['"]|['"]$/g, "");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function readConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  const markdown = fs.readFileSync(configPath, "utf8");
  const yaml = markdown.match(/```yaml\s*\n([\s\S]*?)\n```/)?.[1] ?? markdown;
  const block = yaml.match(/^typesafe:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1];
  if (!block) return { ...DEFAULT_CONFIG };

  const parsed = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^\s+([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (match) parsed[match[1]] = parseScalar(match[2]);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function buildQuestions(preset) {
  if (preset !== "game-routing") throw new Error(`Unsupported preset: ${preset}`);
  return {
    task_size: {
      type: "choice",
      instructions: "Classify the implementation task size for this Cocos game workflow.",
      criteria: {
        S: "A small isolated tweak with a narrow change surface.",
        M: "One bounded feature or adjustment spanning a few related files or one editor flow.",
        L: "Cross-system work, or coordinated code, scene, art, integration, and review work.",
        BUG: "A correction to existing behavior with a reproducible failure or regression.",
      },
    },
    lane: {
      type: "choice",
      instructions: "Which execution lane best fits this task, ignoring any explicit director override?",
      criteria: {
        single: "A single agent can implement and verify the task sequentially.",
        fleet_lite: "Independent implementation and review help, but no new art pipeline is needed.",
        fleet: "The task benefits from supervised specialist tasks, integration, and independent review.",
      },
    },
    model_tier: {
      type: "choice",
      instructions: "What minimum worker model tier does the semantic difficulty require?",
      criteria: {
        cheap: "Mechanical discovery, extraction, or a tightly specified low-risk change.",
        default: "Ordinary bounded implementation with moderate judgment.",
        quality: "Architecture, ambiguity, difficult debugging, security, migration, or consequential review.",
      },
    },
    primary_skill: {
      type: "choice",
      instructions: "Which single workflow skill is the best starting point?",
      criteria: {
        none: "No specialized workflow skill is needed.",
        setup_project: "Required project contracts or initial setup are missing.",
        grill_with_docs: "The feature is under-specified or has unresolved product decisions.",
        cocos_orca_fleet: "A supervised multi-agent Cocos feature fleet is warranted.",
        cocos_editor: "The main work is a Cocos scene, prefab, asset, or editor operation.",
        tdd: "The main work is engine-independent game logic suited to tests first.",
        diagnosing_bugs: "The main work is reproducing and fixing an existing defect.",
        understand: "The code or existing flow must be mapped before implementation.",
        create_docs: "The requested outcome is mechanic or flow documentation.",
        smoke_test: "The requested outcome is runtime verification of the game.",
        commit_guard: "The change is ready for final commit verification.",
        ship: "The requested outcome is build, preview deployment, or release.",
      },
    },
    possible_human_gate: {
      type: "noul",
      instructions: "Does the request appear to contain a material product decision or an authorization boundary that code must not decide automatically?",
    },
  };
}

function parseArgs(argv) {
  const args = { preset: "game-routing", config: "AGENT_NOTES.md", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--preset") args.preset = argv[++i];
    else if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function emit(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = exitCode;
}

function fallback(config, preset, reason, detail) {
  emit(
    {
      schema_version: 1,
      status: "fallback",
      mode: config.mode,
      preset,
      reason,
      ...(detail ? { detail } : {}),
      use_deterministic_router: true,
    },
    config.fail_open ? 0 : 2,
  );
}

function decisionSummary(answers, config) {
  const decisions = {};
  for (const [id, answer] of Object.entries(answers ?? {})) {
    if (answer.type === "choice") {
      decisions[id] = {
        value: answer.choice,
        confidence: answer.confidence,
        allowed: config.mode === "active" && answer.confidence >= config.min_confidence,
      };
    } else if (answer.type === "score") {
      decisions[id] = {
        value: answer.score,
        confidence: answer.confidence,
        allowed: config.mode === "active" && answer.confidence >= config.min_confidence,
      };
    } else if (answer.type === "noul") {
      decisions[id] = { probability_yes: answer.noul, allowed: false };
    }
  }
  return decisions;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    emit({ schema_version: 1, status: "error", reason: "invalid_arguments", detail: error.message }, 2);
    return;
  }

  const configPath = path.resolve(args.config);
  const config = readConfig(configPath);
  if (!config.enabled || config.mode === "off" || !config.auto_route) {
    emit({
      schema_version: 1,
      status: "disabled",
      mode: config.mode,
      preset: args.preset,
      use_deterministic_router: true,
    });
    return;
  }

  let state;
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) throw new Error("stdin is empty");
    try {
      state = JSON.parse(raw);
    } catch {
      state = { request: raw };
    }
  } catch (error) {
    fallback(config, args.preset, "invalid_state", error.message);
    return;
  }

  let questions;
  try {
    questions = buildQuestions(args.preset);
  } catch (error) {
    fallback(config, args.preset, "invalid_preset", error.message);
    return;
  }

  const request = { state, model: config.model, questions };
  if (args.dryRun) {
    emit({ schema_version: 1, status: "dry_run", mode: config.mode, preset: args.preset, request });
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    fallback(config, args.preset, "missing_api_key", "Set TYPESAFE_API_KEY in the parent process environment.");
    return;
  }

  const configuredEndpoint = process.env.TYPESAFE_ENDPOINT;
  const endpoint = configuredEndpoint
    ? configuredEndpoint.endsWith("/v1/systemone")
      ? configuredEndpoint
      : `${configuredEndpoint.replace(/\/$/, "")}/v1/systemone`
    : "https://api.typesafe.ai/v1/systemone";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      fallback(config, args.preset, `http_${response.status}`, JSON.stringify(body).slice(0, 500));
      return;
    }
    emit({
      schema_version: 1,
      status: "ok",
      mode: config.mode,
      preset: args.preset,
      model_requested: config.model,
      model_returned: body.model,
      min_confidence: config.min_confidence,
      latency_ms: Date.now() - startedAt,
      decisions: decisionSummary(body.answers, config),
      answers: body.answers,
      usage: body.usage,
      use_deterministic_router: config.mode !== "active",
    });
  } catch (error) {
    fallback(config, args.preset, error.name === "AbortError" ? "timeout" : "request_failed", error.message);
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
