export function logAudit(..._args: any[]) {
  // 필요한 순간까지는 no-op
}
const defaultLogAudit = logAudit;
export default defaultLogAudit;
