#!/usr/bin/env bun
/**
 * Phase 7 verification — MLflow telemetry exporter over the AgentTree observer seam.
 * Run: bun run pi-plugin/rlm/test/phase7-telemetry.ts
 */

import { AgentTree } from "../src/state/agent-tree.ts";
import { observerWith } from "../src/state/events.ts";
import { MlflowSink } from "../src/telemetry/mlflow-sink.ts";
import {
  SpanStatusCode,
  type EndSpanOptions,
  type SpanTracer,
  type StartSpanOptions,
} from "../src/telemetry/mlflow.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

class RecordingSpan {
  readonly attributes: Record<string, unknown> = {};
}

interface StartRecord {
  readonly options: StartSpanOptions<RecordingSpan>;
  readonly span: RecordingSpan;
  endOptions?: EndSpanOptions;
}

class RecordingTracer implements SpanTracer<RecordingSpan> {
  readonly starts: StartRecord[] = [];
  flushes = 0;
  shutdowns = 0;

  startSpan(options: StartSpanOptions<RecordingSpan>): RecordingSpan | undefined {
    const span = new RecordingSpan();
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) span.attributes[key] = value;
    }
    this.starts.push({ options, span });
    return span;
  }

  endSpan(span: RecordingSpan, options: EndSpanOptions = {}): void {
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) span.attributes[key] = value;
    }
    const record = this.starts.find((entry) => entry.span === span);
    if (record) record.endOptions = options;
  }

  async flush(): Promise<void> {
    this.flushes++;
  }

  async shutdown(): Promise<void> {
    this.shutdowns++;
  }
}

async function main(): Promise<void> {
  const tree = new AgentTree();
  const tracer = new RecordingTracer();
  const sink = new MlflowSink({ trackingUri: "memory://test" }, 100, tracer);
  const obs = observerWith(tree, sink);

  const root = obs.start({ kind: "root", depth: 0, model: "smart", label: "root", detail: "top-level" });
  const rlm = obs.start({ kind: "rlm", depth: 1, parentId: root, model: "smart", label: "rlm_query", detail: "child" });
  const llm = obs.start({ kind: "llm", depth: 1, parentId: rlm, model: "worker", label: "llm_query", detail: "summarize" });
  const tool = obs.start({ kind: "tool", depth: 1, parentId: llm, label: "read_file", detail: "src/a.ts" });
  const orphan = obs.start({ kind: "tool", depth: 1, parentId: root, label: "grep", detail: "orphan" });

  obs.usage(tool, 0.01, 10);
  obs.usage(tool, 0.02, 20);
  obs.end(tool, { error: "failed", resultPreview: "read failed" });
  obs.end(llm, { costUsd: 0.03, tokens: 30, resultPreview: "worker result" });
  obs.end(rlm, { resultPreview: "child result" });
  obs.end(root, { resultPreview: "root result" });

  await sink.shutdown();

  const [rootSpan, rlmSpan, llmSpan, toolSpan, orphanSpan] = tracer.starts;
  check("creates five spans", tracer.starts.length === 5, String(tracer.starts.length));
  check("root span has no parent", rootSpan?.options.parent === undefined);
  check("rlm span parent is root", rlmSpan?.options.parent === rootSpan?.span);
  check("llm span parent is rlm", llmSpan?.options.parent === rlmSpan?.span);
  check("tool span parent is llm", toolSpan?.options.parent === llmSpan?.span);
  check("orphan span parent is root", orphanSpan?.options.parent === rootSpan?.span);
  check(
    "root carries kind/depth/model attrs",
    rootSpan?.span.attributes["rlm.kind"] === "root" && rootSpan.span.attributes["rlm.depth"] === 0 && rootSpan.span.attributes["rlm.model"] === "smart",
  );
  check("tool marks error status", toolSpan?.endOptions?.status === SpanStatusCode.ERROR, String(toolSpan?.endOptions?.status));
  check("tool outputs result preview", toolSpan?.endOptions?.outputs?.result === "read failed");
  check(
    "tool usage accumulates cost",
    Math.abs(Number(toolSpan?.span.attributes["rlm.usage.cost_usd"]) - 0.03) < 0.000001,
    String(toolSpan?.span.attributes["rlm.usage.cost_usd"]),
  );
  check("tool usage accumulates tokens", toolSpan?.span.attributes["rlm.usage.tokens"] === 30, String(toolSpan?.span.attributes["rlm.usage.tokens"]));
  check(
    "end opts usage is forwarded before end",
    Math.abs(Number(llmSpan?.span.attributes["rlm.usage.cost_usd"]) - 0.03) < 0.000001 && llmSpan?.span.attributes["rlm.usage.tokens"] === 30,
  );
  check("shutdown closes orphan as error", orphanSpan?.endOptions?.status === SpanStatusCode.ERROR, String(orphanSpan?.endOptions?.status));
  check("tree mirrors canonical parent ids", tree.get(tool)?.parentId === llm && tree.get(llm)?.parentId === rlm && tree.get(rlm)?.parentId === root && tree.get(orphan)?.parentId === root);
  check("shutdown flushes tracer", tracer.flushes > 0, String(tracer.flushes));
  check("sink does not own tracer teardown", tracer.shutdowns === 0, String(tracer.shutdowns));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
