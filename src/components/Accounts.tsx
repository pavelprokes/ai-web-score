import { balanceAction } from "@/app/(admin)/actions";
import type { AccountRow } from "@/services/accounts";
import { SubmitButton } from "./SubmitButton";
import { usd } from "./format";
import { Badge, Section, TableScroll, TimeAgo } from "./ui";

/** Spend and remaining balance per paid provider account. */
export function Accounts({ accounts, now }: { accounts: AccountRow[]; now: Date }) {
  return (
    <Section title="Accounts & balance" id="accounts-heading">
      <p className="muted">
        DataForSEO reports its balance through its API. Anthropic and Perplexity have no balance API: enter the balance from their billing page and the
        remainder is estimated from the spend tracked since.
      </p>
      <TableScroll label="Accounts (scrollable)">
        <table className="hig-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="num">
                Spent this month
              </th>
              <th scope="col" className="num">
                Balance
              </th>
              <th scope="col">Source</th>
              <th scope="col">Update balance</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <th scope="row">
                  {a.label}
                  {!a.configured && <span className="cell-sub">Not configured: set {a.missingEnv.join(", ")}</span>}
                </th>
                <td className="num">{usd(a.spentMonthUsd)}</td>
                <td className="num">
                  {a.balanceUsd === null ? (
                    <span className="muted">–</span>
                  ) : (
                    <>
                      {a.balanceSource === "estimated" ? "≈ " : ""}
                      {usd(a.balanceUsd)} {a.low && <Badge tone="critical">Low</Badge>}
                    </>
                  )}
                </td>
                <td>
                  {a.balanceSource === "live" && (
                    <span className="cell-sub">Live from the API{a.depositedUsd != null ? ` · ${usd(a.depositedUsd)} deposited in total` : ""}</span>
                  )}
                  {a.balanceSource === "estimated" && (
                    <span className="cell-sub">
                      {usd(a.enteredUsd)} entered <TimeAgo date={a.enteredAt} now={now} /> − {usd(a.spentSinceEntryUsd)} spent since
                    </span>
                  )}
                  {a.balanceSource === "unknown" && (
                    <span className="cell-sub">{a.balanceError ?? (a.id === "dataforseo" ? "Read from the API once the credentials are set" : "Not entered yet")}</span>
                  )}
                </td>
                <td>
                  {a.id === "dataforseo" ? (
                    <span className="muted">Automatic</span>
                  ) : (
                    <form action={balanceAction} className="balance-form">
                      <input type="hidden" name="account" value={a.id} />
                      <label className="sr-only" htmlFor={`balance-${a.id}`}>
                        {a.label} balance in USD
                      </label>
                      <input id={`balance-${a.id}`} name="amountUsd" type="text" inputMode="decimal" placeholder="USD, e.g. 25.40" required />
                      <SubmitButton className="hig-btn hig-btn--sm" pendingLabel="Saving…">
                        Save<span className="sr-only"> {a.label} balance</span>
                      </SubmitButton>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}
