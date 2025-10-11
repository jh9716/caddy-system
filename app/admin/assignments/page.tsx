import { redirect } from 'next/navigation';

export default function AdminAssignments() {
  redirect('/assignments'); // 기존 페이지 재사용
}
