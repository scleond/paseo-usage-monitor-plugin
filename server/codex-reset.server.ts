import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCredentialResolver, type CredentialAdapters } from "./credentials.server";
import { UsageConfigError, UsageSourceError } from "./errors.server";
import type { UsageProviderEntry } from "./registry.server";
import type { UsageHttpRequest, UsageSourceAdapters } from "./source.server";
import type {
  CodexBankedResetDetails,
  CodexBankedResetOutcome,
} from "../shared/codex-reset.shared";
import type { UsageRateReading } from "../shared/limits.shared";
import { readTimestampAtPath } from "./json-path.server";

const CODEX_BACKEND = "https://chatgpt.com/backend-api";
const RESET_CREDITS_URL = `${CODEX_BACKEND}/wham/rate-limit-reset-credits`;
const CONSUME_RESET_URL = `${RESET_CREDITS_URL}/consume`;

const BackendCreditSchema = z.object({
  id: z.string().min(1),
  reset_type: z.string(),
  status: z.string(),
  granted_at: z.string(),
  expires_at: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const BackendCreditsSchema = z.object({
  credits: z.array(BackendCreditSchema),
  available_count: z.number().int().nonnegative(),
});

/** Read-only projection for normal usage refresh; never prepares a redemption. */
export async function readCodexResetExpiryReadings(
  source: UsageSourceAdapters,
  headers: Record<string, string>,
): Promise<UsageRateReading[]> {
  const document = await source.fetchJson({ url: RESET_CREDITS_URL, method: "GET", headers });
  const parsed = BackendCreditsSchema.safeParse(document);
  if (!parsed.success) throw new UsageSourceError("Codex returned invalid banked reset details");
  const credits = parsed.data.credits
    .filter((credit) => credit.status === "available" && credit.reset_type === "codex_rate_limits")
    .map((credit) => ({
      id: credit.id,
      expiresAt: readTimestampAtPath(credit, "expires_at"),
      grantedAt: readTimestampAtPath(credit, "granted_at"),
    }))
    .sort(
      (left, right) =>
        (left.expiresAt === null ? Infinity : Date.parse(left.expiresAt)) -
        (right.expiresAt === null ? Infinity : Date.parse(right.expiresAt)),
    );
  const common = { kind: "rate", group: "Banked reset expiries", multiplier: null } as const;
  return [
    {
      ...common,
      id: "banked-reset-next-expiry",
      label: "Next banked reset expiry",
      state: credits.length > 0 ? "Available" : "None",
      changesAt: credits[0]?.expiresAt ?? null,
      detail: null,
    },
    ...credits.map((credit, index) => ({
      kind: "rate" as const,
      group: "Banked reset expiries",
      multiplier: null,
      id: `banked-reset-${index + 1}-expires`,
      label: `Banked reset ${index + 1} expiry`,
      state: credit.id,
      changesAt: credit.expiresAt,
      detail: credit.grantedAt,
    })),
  ];
}

const BackendConsumeSchema = z.object({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  windows_reset: z.number().int().nonnegative().default(0),
});

export interface CodexBankedResetService {
  read(providerId: string): Promise<CodexBankedResetDetails>;
  consume(input: {
    providerId: string;
    creditId: string | null;
    redeemRequestId: string;
  }): Promise<{ outcome: CodexBankedResetOutcome; windowsReset: number }>;
}

export interface CodexBankedResetServiceInput {
  entries: readonly UsageProviderEntry[];
  source: UsageSourceAdapters;
  credentials: CredentialAdapters;
  createRequestId?: () => string;
}

/**
 * The account id carried inside the bearer token itself. The token and the
 * separately resolved `accountId` can come from different harnesses and
 * different accounts, and the backend rejects that mismatch. The JWT payload
 * is the middle base64url segment; the signature is never checked because
 * this only reads a claim. A malformed token yields null instead of throwing,
 * and the token is never logged.
 */
function accountFromToken(token: string): string | null {
  try {
    const segments = token.split(".");
    const payloadSegment = segments[1];
    if (payloadSegment === undefined) return null;
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    const auth = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return null;
    const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
    return typeof accountId === "string" && accountId !== "" ? accountId : null;
  } catch {
    return null;
  }
}

export function createCodexBankedResetService(
  input: CodexBankedResetServiceInput,
): CodexBankedResetService {
  const createRequestId = input.createRequestId ?? randomUUID;

  function requestFor(
    providerId: string,
    request: Omit<UsageHttpRequest, "headers">,
  ): UsageHttpRequest {
    const entry = input.entries.find((candidate) => candidate.id === providerId);
    if (!entry?.provider) {
      throw new UsageConfigError(`Usage provider "${providerId}" is not configured`);
    }
    if (!entry.provider.supportsBankedReset) {
      throw new UsageConfigError(`Usage provider "${providerId}" does not support banked resets`);
    }
    const resolver = createCredentialResolver(entry.provider.credentials, input.credentials);
    const token = resolver.resolve("token");
    const accountId = accountFromToken(token) ?? resolver.resolve("accountId");
    return {
      ...request,
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    };
  }

  async function read(providerId: string): Promise<CodexBankedResetDetails> {
    const document = await input.source.fetchJson(
      requestFor(providerId, { url: RESET_CREDITS_URL, method: "GET" }),
    );
    const parsed = BackendCreditsSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Codex returned invalid banked reset details");
    }
    const credit = parsed.data.credits.find(
      (candidate) =>
        candidate.status === "available" && candidate.reset_type === "codex_rate_limits",
    );
    return {
      availableCount: parsed.data.available_count,
      credit:
        credit === undefined
          ? null
          : {
              id: credit.id,
              title: credit.title ?? null,
              description: credit.description ?? null,
              grantedAt: credit.granted_at,
              expiresAt: credit.expires_at ?? null,
            },
      redeemRequestId: parsed.data.available_count > 0 ? createRequestId() : null,
    };
  }

  async function consume({
    providerId,
    creditId,
    redeemRequestId,
  }: {
    providerId: string;
    creditId: string | null;
    redeemRequestId: string;
  }): Promise<{ outcome: CodexBankedResetOutcome; windowsReset: number }> {
    const body: Record<string, string> = { redeem_request_id: redeemRequestId };
    if (creditId !== null) body.credit_id = creditId;
    const document = await input.source.fetchJson(
      requestFor(providerId, {
        url: CONSUME_RESET_URL,
        method: "POST",
        body,
      }),
    );
    const parsed = BackendConsumeSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Codex returned an invalid banked reset result");
    }
    return { outcome: parsed.data.code, windowsReset: parsed.data.windows_reset };
  }

  return { read, consume };
}
