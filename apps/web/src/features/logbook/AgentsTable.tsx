import { type AgentHistory } from "@estuary/contracts";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { formatCount } from "@/lib/formatting";

export type AgentsTableProps = {
  agents: AgentHistory[];
};

/** Per-agent submitted / approved / sent-back (→ QA pass rate), decisions asked, claims, releases. */
export const AgentsTable = ({ agents }: AgentsTableProps) => {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent activity in this range.</p>;
  }

  return (
    <>
      {/* `md` and up: a real table. */}
      <table className="hidden w-full text-sm md:table">
        <caption className="sr-only">Agent activity for this range</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-2 font-medium">
              Agent
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Submitted
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              QA pass rate
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Decisions asked
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Claims
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium">
              Releases
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.actor} className="border-b border-border last:border-0">
              <td className="py-2 pr-2">
                <ActorBadge actor={agent.actor} />
              </td>
              <td className="px-2 py-2 text-right font-mono">{agent.submitted}</td>
              <td className="px-2 py-2 text-right font-mono">{qaPassRate(agent)}</td>
              <td className="px-2 py-2 text-right font-mono">{agent.decisionsRequested}</td>
              <td className="px-2 py-2 text-right font-mono">{agent.claims}</td>
              <td className="py-2 pl-2 text-right font-mono">{agent.releases}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Below `md`: stacked cards, same data. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {agents.map((agent) => (
          <li
            key={agent.actor}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-raised"
          >
            <ActorBadge actor={agent.actor} />
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <Stat label="Submitted" value={agent.submitted} />
              <Stat label="QA pass rate" value={qaPassRate(agent)} />
              <Stat label="Decisions asked" value={agent.decisionsRequested} />
              <Stat label="Claims" value={agent.claims} />
              <Stat label="Releases" value={agent.releases} />
              <Stat label="Sent back" value={agent.sentBack} />
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
};

const qaPassRate = (agent: AgentHistory): string => {
  const total = agent.approved + agent.sentBack;
  if (total === 0) return "—";
  return `${Math.round((agent.approved / total) * 100)}%`;
};

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <div className="flex justify-between gap-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-mono text-foreground">{value}</dd>
  </div>
);

export const agentsSummary = (agents: AgentHistory[]): string =>
  `${formatCount(agents.length, "agent")} active`;
