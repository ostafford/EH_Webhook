/**
 * Employment Hero Payroll (AU) API client. Narrow surface: look an employee up
 * by external id, and create-or-update by external id. Auth is HTTP Basic with
 * the API key as the username. Every call returns an {@link EhResult} so callers
 * branch on outcome rather than catching.
 */
import { httpJson, type HttpResponse } from "../http/json.js";
import { parseValidationBody, type EhFieldError } from "./errors.js";
import type { EhEmployee, EhEmployeePayload } from "./types.js";

export type EhResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "validation"; issues: EhFieldError[]; status: number }
  | { outcome: "retryable"; status: number | null; detail: string }
  | { outcome: "client_error"; status: number; detail: string };

export interface EhClientConfig {
  apiKey: string;
  businessId: string;
  /** Defaults to the AU production host. Override for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.yourpayroll.com.au/api/v2";

export class EhPayrollClient {
  readonly #base: string;
  readonly #businessId: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;

  constructor(cfg: EhClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#businessId = cfg.businessId;
    this.#auth = `Basic ${btoa(`${cfg.apiKey}:`)}`;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  #url(path: string): string {
    return `${this.#base}/business/${this.#businessId}${path}`;
  }

  async getByExternalId(externalId: string): Promise<EhResult<EhEmployee | null>> {
    const r = await httpJson(
      {
        method: "GET",
        url: this.#url(`/employee/unstructured/externalid/${encodeURIComponent(externalId)}`),
        headers: { authorization: this.#auth },
      },
      this.#fetch,
    );
    if (r.kind === "success") return { outcome: "ok", data: (r.body as EhEmployee) ?? null };
    if (r.kind === "client_error" && r.status === 404) return { outcome: "ok", data: null };
    return toResult(r);
  }

  /**
   * Create the employee if no record carries this external id, otherwise update
   * the existing one. `externalId` is written into the payload so a fresh create
   * is linked from the start.
   */
  async upsertByExternalId(
    externalId: string,
    payload: EhEmployeePayload,
  ): Promise<EhResult<EhEmployee>> {
    const existing = await this.getByExternalId(externalId);
    if (existing.outcome !== "ok") return existing;

    const body: EhEmployeePayload = { ...payload, externalId };
    const write = existing.data
      ? await httpJson(
          {
            method: "PUT",
            url: this.#url(`/employee/unstructured/${existing.data.id}`),
            headers: { authorization: this.#auth },
            body,
          },
          this.#fetch,
        )
      : await httpJson(
          {
            method: "POST",
            url: this.#url(`/employee/unstructured`),
            headers: { authorization: this.#auth },
            body,
          },
          this.#fetch,
        );

    if (write.kind === "success") return { outcome: "ok", data: write.body as EhEmployee };
    return toResult(write);
  }
}

function toResult(r: HttpResponse): EhResult<never> {
  switch (r.kind) {
    case "validation":
      return { outcome: "validation", issues: parseValidationBody(r.body), status: r.status };
    case "retryable":
      return { outcome: "retryable", status: r.status, detail: r.detail };
    case "client_error":
      return {
        outcome: "client_error",
        status: r.status,
        detail: typeof r.body === "string" ? r.body : JSON.stringify(r.body).slice(0, 300),
      };
    case "success":
      return { outcome: "retryable", status: r.status, detail: "unexpected success routed as error" };
  }
}
