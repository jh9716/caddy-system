import { statusLabels } from "../utils/statusLabels";

function StatusBadge({ status }: { status: string }) {
  return <span>{statusLabels[status]}</span>;
}
