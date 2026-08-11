declare module "cloudflare:workers" {
  export class WorkflowEntrypoint<Env = unknown, Payload = unknown> {
    readonly env: Env;
    constructor(state: unknown, env: Env);
    run(event: WorkflowEvent<Payload>, step: WorkflowStep): Promise<unknown>;
  }

  export type WorkflowEvent<Payload> = {
    readonly payload: Payload;
  };

  export type WorkflowStep = {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
    do<T>(
      name: string,
      config: {
        readonly retries?: {
          readonly limit?: number;
          readonly delay?: string;
          readonly backoff?: "constant" | "linear" | "exponential";
        };
      },
      callback: () => Promise<T> | T,
    ): Promise<T>;
    sleep(name: string, duration: number | string): Promise<void>;
  };
}
