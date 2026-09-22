import type { Metadata } from "next";
import Link from "next/link";
import AccountDeletionForm from "@/app/account-deletion/AccountDeletionForm";
import {
  ACCOUNT_DELETION_LINK_LABEL,
  ACCOUNT_DELETION_PUBLIC_URL,
  PRIVACY_OPERATOR_NAME,
  PRIVACY_PATH,
  PRIVACY_SERVICE_NAME,
  readPrivacyContactEmail,
} from "@/lib/privacy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: ACCOUNT_DELETION_LINK_LABEL,
  description: `${PRIVACY_SERVICE_NAME} 계정 삭제 요청`,
  alternates: { canonical: ACCOUNT_DELETION_PUBLIC_URL },
};

export default function AccountDeletionPage() {
  const contactEmail = readPrivacyContactEmail();

  return (
    <article className="privacy-page">
      <header className="privacy-page-head">
        <p className="privacy-kicker">{PRIVACY_SERVICE_NAME}</p>
        <h1 className="ui-page-title">{ACCOUNT_DELETION_LINK_LABEL}</h1>
        <p className="ui-page-sub">
          공개 주소 {ACCOUNT_DELETION_PUBLIC_URL} · 로그인 없이 요청할 수
          있습니다.
        </p>
      </header>

      <section className="privacy-section">
        <h2>1. 요청 대상</h2>
        <p>
          {PRIVACY_SERVICE_NAME}({PRIVACY_OPERATOR_NAME}) 앱 계정 삭제를
          요청하는 페이지입니다. 카카오 로그인을 처음 완료하면 앱 계정이
          만들어지므로, 그 계정의 삭제 요청도 여기에서 접수합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>2. 삭제 또는 익명화하는 정보</h2>
        <p>
          운영자가 본인을 확인한 뒤 처리합니다. 이 페이지에서 제출하는
          즉시 계정이 지워지지는 않습니다.
        </p>
        <ul>
          <li>
            앱 로그인 계정: 로그인 아이디·카카오 연결·비밀번호 해시를
            익명화하거나 연결을 해제합니다. 관련 기록이 남아 있으면 계정을
            바로 물리 삭제하지 않습니다.
          </li>
          <li>카카오 식별값: 계정에서 분리합니다.</li>
          <li>푸시 토큰·웹 푸시 구독: 삭제하여 알림을 끊습니다.</li>
          <li>
            코스 제보·댓글: 근무 기록으로 남기되, 작성자 표시 이름은
            익명화합니다.
          </li>
          <li>
            본인확인 연결 요청: 처리 이력은 남기고, 제출 이름·전화번호는
            익명화합니다.
          </li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>3. 업무상 보존하는 정보</h2>
        <ul>
          <li>
            캐디 직원 명부: 근무 기록입니다. 앱 계정과 연결만 해제하고,
            명부 자체는 계정 삭제 요청만으로 지우지 않습니다.
          </li>
          <li>
            배치표, 휴무, 당번 등 근무 운영 기록: 개인 로그인 계정과 분리한
            뒤 운영 기록으로 보존합니다.
          </li>
          <li>감사 로그: 보안·운영 이력으로 보존합니다.</li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>4. 삭제 요청 시작</h2>
        <p>
          아래 폼을 보내면 삭제 요청이 접수됩니다. 로그인하지 않아도
          됩니다.
        </p>
        {contactEmail ? (
          <p>
            이메일로도 요청할 수 있습니다.{" "}
            <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
          </p>
        ) : null}
        <AccountDeletionForm />
      </section>

      <section className="privacy-section">
        <h2>5. 개인정보처리방침</h2>
        <p>
          수집 항목과 보관 안내는{" "}
          <Link href={PRIVACY_PATH}>개인정보처리방침</Link>을 보세요.
        </p>
      </section>
    </article>
  );
}
