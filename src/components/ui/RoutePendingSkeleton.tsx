type RoutePendingVariant = "list" | "dashboard";

export default function RoutePendingSkeleton({
  title,
  variant = "list",
}: {
  title: string;
  variant?: RoutePendingVariant;
}) {
  if (variant === "dashboard") {
    return (
      <div className="vh-route-pending is-dashboard" aria-busy="true" aria-live="polite">
        <div className="vh-skel vh-skel-title" />
        <div className="vh-route-pending-kpis">
          <div className="vh-skel vh-skel-card" />
          <div className="vh-skel vh-skel-card" />
          <div className="vh-skel vh-skel-card" />
        </div>
        <div className="vh-skel vh-skel-block" />
        <span className="vh-sr-only">{title} 불러오는 중</span>
      </div>
    );
  }
  return (
    <div className="vh-route-pending" aria-busy="true" aria-live="polite">
      <div className="vh-skel vh-skel-title" />
      <div className="vh-skel vh-skel-line" />
      <div className="vh-skel vh-skel-line is-wide" />
      <div className="vh-skel vh-skel-line" />
      <div className="vh-skel vh-skel-block" />
      <span className="vh-sr-only">{title} 불러오는 중</span>
    </div>
  );
}
