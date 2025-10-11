import Link from "next/link";

export default function NavBar() {
  return (
    <nav style={{padding:"8px 12px", borderBottom:"1px solid #eee"}}>
      <Link href="/">Home</Link>
    </nav>
  );
}
