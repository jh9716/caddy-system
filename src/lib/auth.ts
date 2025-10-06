import { cookies } from 'next/headers';

export type Session = {
  role: 'admin' | 'caddy';
  user: string;
} | null;

export function getSession(): Session {
  const store = cookies();
  const role = store.get('session_role')?.value as 'admin' | 'caddy' | undefined;
  const user = store.get('session_user')?.value;
  if (!role || !user) return null;
  return { role, user };
}

export function isAdmin(): boolean {
  const s = getSession();
  return !!s && s.role === 'admin';
}
