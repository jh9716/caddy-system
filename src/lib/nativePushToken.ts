/**
 * DevicePushToken persistence. Never logs or returns the raw token in errors.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

export const NATIVE_PUSH_PLATFORM_ANDROID = "ANDROID" as const;
export const MAX_NATIVE_PUSH_TOKEN_LENGTH = 4096;

export class NativePushTokenError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message);
    this.name = "NativePushTokenError";
  }
}

export function isDevicePushStoreMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /does not exist|DevicePushToken/i.test(msg) && /relation|table/i.test(msg);
}

export function parseNativePushToken(raw: unknown): string {
  const token = String(raw ?? "").trim();
  if (!token) {
    throw new NativePushTokenError("invalid_token", "token이 필요합니다.", 400);
  }
  if (token.length > MAX_NATIVE_PUSH_TOKEN_LENGTH) {
    throw new NativePushTokenError("invalid_token", "token이 올바르지 않습니다.", 400);
  }
  if (/\s/.test(token)) {
    throw new NativePushTokenError("invalid_token", "token이 올바르지 않습니다.", 400);
  }
  return token;
}

export function parseNativePushPlatform(raw: unknown): "ANDROID" {
  const platform = String(raw ?? NATIVE_PUSH_PLATFORM_ANDROID).trim().toUpperCase();
  if (platform !== NATIVE_PUSH_PLATFORM_ANDROID) {
    throw new NativePushTokenError("invalid_platform", "Android만 지원합니다.", 400);
  }
  return NATIVE_PUSH_PLATFORM_ANDROID;
}

export async function upsertDevicePushToken(
  db: PrismaClient,
  input: { userId: number; token: string; platform: "ANDROID" }
) {
  return db.devicePushToken.upsert({
    where: {
      userId_token: { userId: input.userId, token: input.token },
    },
    create: {
      userId: input.userId,
      token: input.token,
      platform: input.platform,
      enabled: true,
    },
    update: {
      enabled: true,
      platform: input.platform,
    },
  });
}

export async function disableDevicePushTokenById(
  db: PrismaClient,
  id: number
): Promise<number> {
  const result = await db.devicePushToken.updateMany({
    where: { id },
    data: { enabled: false, lastFailureAt: new Date() },
  });
  return result.count;
}

export async function touchDevicePushTokenFailure(
  db: PrismaClient,
  id: number
): Promise<number> {
  const result = await db.devicePushToken.updateMany({
    where: { id },
    data: { lastFailureAt: new Date() },
  });
  return result.count;
}

export async function disableDevicePushToken(
  db: PrismaClient,
  input: { userId: number; token: string }
): Promise<number> {
  const result = await db.devicePushToken.updateMany({
    where: { userId: input.userId, token: input.token },
    data: { enabled: false },
  });
  return result.count;
}

export async function disableAllDevicePushTokensForUser(
  db: PrismaClient,
  userId: number
): Promise<number> {
  const result = await db.devicePushToken.updateMany({
    where: { userId, enabled: true },
    data: { enabled: false },
  });
  return result.count;
}

export async function userHasEnabledDevicePushToken(
  db: PrismaClient,
  input: { userId: number; token: string }
): Promise<boolean> {
  const row = await db.devicePushToken.findUnique({
    where: { userId_token: { userId: input.userId, token: input.token } },
    select: { enabled: true },
  });
  return row?.enabled === true;
}
