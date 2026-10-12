import { z } from "zod";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";
import { InvalidBalanceError, providerAccounts, setAccountBalance } from "@/services/accounts";

export const dynamic = "force-dynamic";

/** Spend this month and remaining balance per provider account (live for DataForSEO, estimated otherwise). */
export const GET = adminRoute(async () => ({ accounts: await providerAccounts() }));

const Body = z.object({ account: z.string(), amountUsd: z.number() });

/** Enter the balance shown in a provider's billing page: `{ "account": "anthropic", "amountUsd": 25.4 }`. */
export const POST = adminRoute(async (req, { actor }) => {
  const b = Body.parse(await jsonBody(req));
  try {
    await setAccountBalance(b.account, b.amountUsd, actor);
  } catch (e) {
    if (e instanceof InvalidBalanceError) throw new HttpError(422, e.message);
    throw e;
  }
  return { accounts: await providerAccounts() };
});
