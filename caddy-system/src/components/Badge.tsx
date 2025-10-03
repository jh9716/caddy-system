.export default function Badge({ text, color = '#e2e8f0' }: { text: string; color?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 9999,
        background: color,
        fontSize: 12,
        lineHeight: '18px',
        color: '#0f172a',
        border: '1px solid rgba(0,0,0,.06)',
      }}
    >
      {text}
    </span>
  );
}
