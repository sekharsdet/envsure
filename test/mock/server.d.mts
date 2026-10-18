export const VALUE: string;
export const TOKENS: Record<string, string>;
export interface MockServer {
  base: string;
  requests: {
    method: string;
    path: string;
    query: string[];
    headers: Record<string, string | string[] | undefined>;
    requestBody: string;
    status?: number;
    response?: unknown;
  }[];
  env: Record<string, string>;
  /** PR comments created through the mock's GitHub comment API (seed or inspect freely). */
  comments: { id: number; issue: number; body: string; user: { login: string } }[];
  close(): Promise<void>;
}
export function startMockServer(port?: number): Promise<MockServer>;
export function mockEnv(base: string): Record<string, string>;
