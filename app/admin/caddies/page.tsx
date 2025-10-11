import { redirect } from 'next/navigation';

export default function AdminCaddies() {
  redirect('/caddies'); // 기존 페이지 재사용
}
