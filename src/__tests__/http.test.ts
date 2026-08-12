import { describe, expect, test, vi } from "vitest";
import { notionRagMcpCloudflareWorker } from "../worker";
import { NotionIndexWorkItemWorkflow } from "../app/create-app";
import type { NotionRagMcpBindings, NotionReindexWorkflowPayload } from "../worker/bindings";
import type { WorkflowStep } from "cloudflare:workers";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
}));

describe("Notion index worker HTTP contract", () => {
  test("staggers work items and retries transient processing failures", async () => {
    const workflow = new NotionIndexWorkItemWorkflow({}, {});
    const step = {
      sleep: vi.fn(async () => {}),
      do: vi.fn(async (_name: string, config: unknown) => config),
    } as unknown as WorkflowStep;

    const result = await workflow.run(
      {
        payload: {
          jobId: "job-staggered",
          itemId: "page-0006",
          itemType: "page",
          sourceId: "source-1",
          indexedAt: "2026-07-16T00:00:00.000Z",
          pageId: "page-1",
          startDelaySeconds: 12,
        },
      },
      step,
    );

    expect(step.sleep).toHaveBeenCalledWith("stagger notion index work item", "12 seconds");
    expect(result).toEqual({
      retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
    });
  });

  test("starts reindex jobs through the Workflow binding", async () => {
    const workflow = new FakeWorkflowBinding();

    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(createPayload({ jobId: "job-1" })),
      }),
      createEnv({ workflow }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workflowInstanceId: "job-1",
      jobId: "job-1",
    });
    expect(workflow.created[0]).toMatchObject({
      id: "job-1",
      params: { sourceId: "source-1" },
    });
  });

  test("accepts an explicit Vectorize repair workflow", async () => {
    const workflow = new FakeWorkflowBinding();

    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(createPayload({ jobId: "job-repair", mode: "repair" })),
      }),
      createEnv({ workflow }),
    );

    expect(response.status).toBe(200);
    expect(workflow.created[0]).toMatchObject({
      id: "job-repair",
      params: { sourceId: "source-1", mode: "repair" },
    });
  });

  test("accepts job requests without Worker bearer authentication", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        body: JSON.stringify(createPayload({ jobId: "job-unauthorized" })),
      }),
      createEnv({ workflow: new FakeWorkflowBinding() }),
    );

    expect(response.status).toBe(200);
  });

  test("reports missing Workflow binding", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        body: JSON.stringify(createPayload({ jobId: "job-no-workflow" })),
      }),
      createEnv(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_configured",
      reason: "workflow_missing",
    });
  });

  test("returns bad_request for invalid JSON", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      createEnv({ workflow: new FakeWorkflowBinding() }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "bad_request",
      reason: "invalid_json",
    });
  });

  test("returns bad_request for an invalid workflow payload", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "job-without-source" }),
      }),
      createEnv({ workflow: new FakeWorkflowBinding() }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "bad_request",
      reason: "invalid_payload",
    });
  });

  test("reports Workflow create failures", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ jobId: "job-fails" })),
      }),
      createEnv({ workflow: new FakeWorkflowBinding({ createError: new Error("workflow down") }) }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "workflow_error",
      reason: "workflow_create_failed",
    });
  });

  test("returns Workflow status for a job id", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs/job-1", {
      }),
      createEnv({ workflow: new FakeWorkflowBinding({ status: { state: "running" } }) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workflowInstanceId: "job-1",
      status: { state: "running" },
    });
  });

  test("creates weekly scheduled workflow jobs for enabled sources", async () => {
    const workflow = new FakeWorkflowBinding();
    const context = new FakeExecutionContext();

    await notionRagMcpCloudflareWorker.scheduled(
      {},
      createEnv({ workflow, db: new FakeD1() }),
      context,
    );
    await context.flush();

    expect(workflow.created).toHaveLength(2);
    expect(workflow.created[0]?.params).toMatchObject({
      sourceId: "source-1",
      actorUserId: "scheduled",
      mode: "scheduled-reindex",
    });
  });

  test("reports Workflow status failures", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://index.example.test/reindex-jobs/job-1", {
      }),
      createEnv({ workflow: new FakeWorkflowBinding({ statusError: new Error("status down") }) }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "workflow_error",
      reason: "workflow_status_failed",
    });
  });
});

function createPayload(
  overrides: Partial<NotionReindexWorkflowPayload> = {},
): NotionReindexWorkflowPayload {
  return {
    jobId: "job-1",
    sourceId: "source-1",
    actorUserId: "user-1",
    orgId: "org-1",
    ...overrides,
  };
}

function createEnv(
  input: {
    readonly workflow?: FakeWorkflowBinding;
    readonly db?: FakeD1;
  } = {},
): NotionRagMcpBindings {
  return {
    NOTION_RAG_DB: input.db ?? new FakeD1([]),
    ...(input.workflow ? { NOTION_REINDEX_WORKFLOW: input.workflow } : {}),
  };
}

class FakeD1 {
  readonly runs: { readonly query: string; readonly values: readonly unknown[] }[] = [];

  constructor(
    readonly sources: readonly {
      readonly id: string;
      readonly org_id: string;
      readonly name: string;
      readonly root_page_id: string;
    }[] = [
      { id: "source-1", org_id: "org-1", name: "Source 1", root_page_id: "page-1" },
      { id: "source-2", org_id: "org-1", name: "Source 2", root_page_id: "page-2" },
    ],
  ) {}

  prepare(query: string) {
    return new FakeStatement(this, query);
  }

  async batch(statements: FakeStatement[]) {
    return await Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeStatement {
  private values: readonly unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: readonly unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    this.db.runs.push({ query: this.query, values: this.values });
    return {};
  }

  async all<T>() {
    if (this.query.includes("FROM notion_sources")) {
      return { results: this.db.sources as T[] };
    }
    return { results: [] };
  }

  async first<T>() {
    return null as T | null;
  }
}

class FakeExecutionContext {
  private readonly promises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>) {
    this.promises.push(promise);
  }

  async flush() {
    await Promise.all(this.promises);
  }
}

class FakeWorkflowBinding {
  readonly created: { readonly id?: string; readonly params?: NotionReindexWorkflowPayload }[] = [];

  constructor(
    private readonly options: {
      readonly createError?: Error;
      readonly status?: unknown;
      readonly statusError?: Error;
    } = {},
  ) {}

  async create(options?: { id?: string; params?: NotionReindexWorkflowPayload }) {
    if (this.options.createError) {
      throw this.options.createError;
    }
    this.created.push({
      ...(options?.id ? { id: options.id } : {}),
      ...(options?.params ? { params: options.params } : {}),
    });
    return new FakeWorkflowInstance(options?.id ?? "generated-job", this.options);
  }

  async createBatch(options: readonly { id: string; params: NotionReindexWorkflowPayload }[]) {
    return await Promise.all(options.map(async (option) => this.create(option)));
  }

  async get(id: string) {
    return new FakeWorkflowInstance(id, this.options);
  }
}

class FakeWorkflowInstance {
  constructor(
    readonly id: string,
    private readonly options: { readonly status?: unknown; readonly statusError?: Error },
  ) {}

  async status() {
    if (this.options.statusError) {
      throw this.options.statusError;
    }
    return this.options.status ?? { state: "complete" };
  }
}
