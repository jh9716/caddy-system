/**
 * LOCAL POSTGRESQL ONLY — 카트 마스터 + 기숙사 자격
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:cart-local
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { GET as cartsGET, POST as cartsPOST } from "../src/app/api/carts/route";
import { PATCH as cartPATCH } from "../src/app/api/carts/[id]/route";
import { PATCH as caddyPATCH } from "../src/app/api/caddies/[id]/route";
import { CartManageError } from "../src/lib/cartManage";
import { createCart } from "../src/lib/cartService";

const TAG = "__CARTP1__";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

async function cookieReq(
  role: "admin" | "caddy" | "leader",
  url: string,
  init?: RequestInit
) {
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: role,
      role,
      sessionVersion: 0,
    })
  );
  return new NextRequest(url, {
    ...init,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

async function jsonStatus(res: Response) {
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const createdCaddyIds: number[] = [];
  const createdCartIds: number[] = [];

  try {
    const owner = await prisma.caddy.create({
      data: {
        name: `${TAG}OWNER`,
        team: "1조",
        teamOrder: 9801,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const other = await prisma.caddy.create({
      data: {
        name: `${TAG}OTHER`,
        team: "1조",
        teamOrder: 9802,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const retired = await prisma.caddy.create({
      data: {
        name: `${TAG}RETIRED`,
        team: "1조",
        teamOrder: 9803,
        employmentStatus: "RETIRED",
        caddyType: "HOUSE",
      },
    });
    createdCaddyIds.push(owner.id, other.id, retired.id);

    section("dormitoryResident default");
    assert(owner.dormitoryResident === false, "new caddy dormitoryResident=false");

    section("auth");
    const caddyGet = await jsonStatus(
      await cartsGET(await cookieReq("caddy", "http://local/api/carts"))
    );
    assert(caddyGet.status === 401, "caddy GET /api/carts 거부");
    const leaderPost = await jsonStatus(
      await cartsPOST(
        await cookieReq("leader", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({ number: `${TAG}21` }),
        })
      )
    );
    assert(leaderPost.status === 401, "leader POST /api/carts 거부");

    const adminCreate = await jsonStatus(
      await cartsPOST(
        await cookieReq("admin", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({
            number: `${TAG}12`,
            ownerCaddyId: owner.id,
          }),
        })
      )
    );
    assert(adminCreate.status === 201, "admin POST /api/carts 허용");
    const createdId = Number((adminCreate.body as { id?: number })?.id);
    assert(createdId > 0, "created cart id");
    if (createdId > 0) createdCartIds.push(createdId);

    const list = await jsonStatus(
      await cartsGET(await cookieReq("admin", "http://local/api/carts"))
    );
    assert(list.status === 200, "admin GET /api/carts 허용");
    const carts = (list.body as { carts?: Array<{ number: string }> })?.carts || [];
    assert(
      carts.some((row) => row.number === `${TAG}12`),
      "list includes created cart"
    );

    section("unique / xor");
    const dup = await jsonStatus(
      await cartsPOST(
        await cookieReq("admin", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({ number: `${TAG}12` }),
        })
      )
    );
    assert(
      dup.status === 409 &&
        (dup.body as { code?: string })?.code === "cart_number_duplicate",
      "duplicate cart number 거부"
    );

    const secondOwner = await jsonStatus(
      await cartsPOST(
        await cookieReq("admin", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({
            number: `${TAG}13`,
            ownerCaddyId: owner.id,
          }),
        })
      )
    );
    assert(
      secondOwner.status === 409 &&
        (secondOwner.body as { code?: string })?.code === "cart_owner_taken",
      "한 Caddy 두 고정카트 owner 거부"
    );

    const both = await jsonStatus(
      await cartsPOST(
        await cookieReq("admin", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({
            number: `${TAG}21`,
            dormitoryOnly: true,
            ownerCaddyId: other.id,
          }),
        })
      )
    );
    assert(
      both.status === 400 &&
        (both.body as { code?: string })?.code === "cart_dorm_owner_conflict",
      "dormitoryOnly + owner 동시 설정 거부"
    );

    try {
      await createCart({
        number: `${TAG}25`,
        ownerCaddyId: retired.id,
      });
      assert(false, "retired owner should throw");
    } catch (e) {
      assert(
        e instanceof CartManageError && e.code === "cart_owner_not_operational",
        "RETIRED owner 거부"
      );
    }

    const dorm = await jsonStatus(
      await cartsPOST(
        await cookieReq("admin", "http://local/api/carts", {
          method: "POST",
          body: JSON.stringify({
            number: `${TAG}21`,
            dormitoryOnly: true,
          }),
        })
      )
    );
    assert(dorm.status === 201, "기숙사 카트 등록");
    const dormId = Number((dorm.body as { id?: number })?.id);
    if (dormId > 0) createdCartIds.push(dormId);

    const maint = await jsonStatus(
      await cartPATCH(
        await cookieReq("admin", `http://local/api/carts/${dormId}`, {
          method: "PATCH",
          body: JSON.stringify({ operationalStatus: "MAINTENANCE" }),
        }),
        { params: { id: String(dormId) } }
      )
    );
    assert(maint.status === 200, "admin PATCH status 허용");
    assert(
      (maint.body as { operationalStatus?: string })?.operationalStatus ===
        "MAINTENANCE",
      "정비 상태 저장"
    );

    section("dormitoryResident admin write");
    const dormFlag = await jsonStatus(
      await caddyPATCH(
        await cookieReq("admin", `http://local/api/caddies/${other.id}`, {
          method: "PATCH",
          body: JSON.stringify({ dormitoryResident: true }),
        }),
        { params: { id: String(other.id) } }
      )
    );
    assert(dormFlag.status === 200, "admin PATCH dormitoryResident 허용");
    const reloaded = await prisma.caddy.findUnique({
      where: { id: other.id },
      select: { dormitoryResident: true },
    });
    assert(reloaded?.dormitoryResident === true, "dormitoryResident persisted");

    const caddyDenied = await jsonStatus(
      await caddyPATCH(
        await cookieReq("caddy", `http://local/api/caddies/${other.id}`, {
          method: "PATCH",
          body: JSON.stringify({ dormitoryResident: false }),
        }),
        { params: { id: String(other.id) } }
      )
    );
    assert(caddyDenied.status === 401, "일반 사용자 dormitoryResident 수정 거부");

    const audits = await prisma.audit.findMany({
      where: {
        OR: [
          { action: { startsWith: "CART_" }, entityId: { in: createdCartIds } },
          {
            action: "CADDY_DORMITORY_CHANGE",
            entityId: other.id,
          },
        ],
      },
    });
    assert(
      audits.some((row) => row.action === "CART_CREATE"),
      "CART_CREATE audit"
    );
    assert(
      audits.some((row) => row.action === "CART_STATUS_CHANGE"),
      "CART_STATUS_CHANGE audit"
    );
    assert(
      audits.some((row) => row.action === "CADDY_DORMITORY_CHANGE"),
      "CADDY_DORMITORY_CHANGE audit"
    );
    assert(
      !JSON.stringify(audits).includes("phone"),
      "audit payload has no phone"
    );
  } finally {
    if (createdCartIds.length) {
      await prisma.cart.deleteMany({ where: { id: { in: createdCartIds } } });
    }
    await prisma.cart.deleteMany({
      where: { number: { startsWith: TAG } },
    });
    await prisma.audit.deleteMany({
      where: {
        OR: [
          { action: { startsWith: "CART_" }, entityId: { in: createdCartIds } },
          { action: "CADDY_DORMITORY_CHANGE", entityId: { in: createdCaddyIds } },
        ],
      },
    });
    if (createdCaddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: createdCaddyIds } } });
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`\nFAIL ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

main().catch((e) => {
  console.error(e);
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(e.code, e.meta);
  }
  void prisma.$disconnect();
  process.exit(1);
});
