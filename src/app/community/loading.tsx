import { FREE_BOARD_LABEL } from "@/lib/freeBoardConstants";
import RoutePendingSkeleton from "@/components/ui/RoutePendingSkeleton";

export default function CommunityLoading() {
  return <RoutePendingSkeleton title={FREE_BOARD_LABEL} />;
}
