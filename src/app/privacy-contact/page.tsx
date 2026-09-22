import type { Metadata } from "next";
import Link from "next/link";
import PrivacyInquiryForm from "@/app/privacy-contact/PrivacyInquiryForm";
import {
  ACCOUNT_DELETION_PATH,
  PRIVACY_CONTACT_LINK_LABEL,
  PRIVACY_CONTACT_PUBLIC_URL,
  PRIVACY_OPERATOR_NAME,
  PRIVACY_PATH,
  PRIVACY_SERVICE_NAME,
  readPrivacyContactEmail,
} from "@/lib/privacy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: PRIVACY_CONTACT_LINK_LABEL,
  description: `${PRIVACY_SERVICE_NAME} 개인정보 문의`,
  alternates: { canonical: PRIVACY_CONTACT_PUBLIC_URL },
};

export default function PrivacyContactPage() {
  const contactEmail = readPrivacyContactEmail();

  return (
    <article className="privacy-page">
      <header className="privacy-page-head">
        <p className="privacy-kicker">{PRIVACY_SERVICE_NAME}</p>
        <h1 className="ui-page-title">{PRIVACY_CONTACT_LINK_LABEL}</h1>
        <p className="ui-page-sub">
          공개 주소 {PRIVACY_CONTACT_PUBLIC_URL} · 로그인 없이 문의할 수
          있습니다.
        </p>
      </header>

      <section className="privacy-section">
        <h2>1. 문의 대상</h2>
        <p>
          {PRIVACY_SERVICE_NAME}({PRIVACY_OPERATOR_NAME}) 개인정보 처리에
          대한 문의, 열람·정정 요청, 계정 삭제 안내를 접수합니다.
        </p>
        {contactEmail ? (
          <p>
            이메일로도 문의할 수 있습니다.{" "}
            <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
          </p>
        ) : null}
      </section>

      <section className="privacy-section">
        <h2>2. 문의 보내기</h2>
        <p>
          아래 폼을 보내면 운영자가 확인합니다. 로그인하지 않아도 됩니다.
          비밀번호, 인증 코드, 세션 정보는 입력하지 마세요.
        </p>
        <PrivacyInquiryForm />
      </section>

      <section className="privacy-section">
        <h2>3. 계정 삭제</h2>
        <p>
          계정 삭제는{" "}
          <Link href={ACCOUNT_DELETION_PATH}>계정 삭제 요청</Link>{" "}
          페이지에서 접수할 수 있습니다. 요청을 받은 뒤 본인 확인을 거쳐
          계정 및 관련 개인정보를 삭제하거나 익명화합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>4. 개인정보처리방침</h2>
        <p>
          수집 항목과 보관 안내는{" "}
          <Link href={PRIVACY_PATH}>개인정보처리방침</Link>을 보세요.
        </p>
      </section>
    </article>
  );
}
