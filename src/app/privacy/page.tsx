import type { Metadata } from "next";
import {
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_LINK_LABEL,
  PRIVACY_PUBLIC_URL,
  PRIVACY_SERVICE_NAME,
} from "@/lib/privacy";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: PRIVACY_LINK_LABEL,
  description: `${PRIVACY_SERVICE_NAME} 캐디 근무 시스템의 개인정보 처리 안내`,
  alternates: { canonical: PRIVACY_PUBLIC_URL },
};

export default function PrivacyPage() {
  return (
    <article className="privacy-page">
      <header className="privacy-page-head">
        <p className="privacy-kicker">{PRIVACY_SERVICE_NAME}</p>
        <h1 className="ui-page-title">{PRIVACY_LINK_LABEL}</h1>
        <p className="ui-page-sub">
          공개 주소 {PRIVACY_PUBLIC_URL} · 시행일 {PRIVACY_EFFECTIVE_DATE}
        </p>
      </header>

      <section className="privacy-section">
        <h2>1. 서비스명 및 운영 주체</h2>
        <p>
          이 방침은 {PRIVACY_SERVICE_NAME}(VERTHILL Caddy System, Android
          패키지 <code>kr.verthill.caddy</code>, 웹{" "}
          <code>https://www.verthill.kr</code>)에 적용됩니다. 골프장 캐디 근무·배치
          운영을 위한 내부 업무용 서비스입니다.
        </p>
        <p>
          운영 주체의 법적 명칭, 사업장 주소, 전화번호, 개인정보 담당
          연락처는 현재 이 서비스 코드에서 확정된 값이 없습니다. 확정되는
          즉시 이 페이지를 갱신합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>2. 수집하는 정보</h2>
        <p>
          아래 항목은 실제 데이터베이스 스키마와 API를 기준으로 한
          목록입니다. 카카오 이메일·닉네임·프로필 사진, 위치, 주소록, 광고
          식별자는 수집하지 않습니다.
        </p>
        <h3>계정 및 인증</h3>
        <ul>
          <li>
            카카오 로그인: 카카오 숫자 회원번호만 저장합니다. 앱 아이디는{" "}
            <code>kakao_숫자</code> 형식으로 생성합니다. 카카오 액세스 토큰은
            저장하지 않습니다.
          </li>
          <li>
            아이디/비밀번호 로그인: 로그인 아이디와 비밀번호 해시(bcrypt)를
            저장합니다. 카카오 전용 계정은 비밀번호가 없습니다.
          </li>
          <li>
            세션 쿠키 <code>vh_session</code>: 사용자 번호, 아이디, 역할,
            세션 버전, 만료 시각을 담은 서명 쿠키입니다. HttpOnly, SameSite=Lax
            이며 HTTPS에서는 Secure입니다.
          </li>
        </ul>
        <h3>직원 연결 및 근무 정보</h3>
        <ul>
          <li>
            본인확인 연결 요청: 제출한 이름, 정규화한 휴대전화번호
            (010XXXXXXXX), 처리 상태.
          </li>
          <li>
            캐디 명부: 이름, 조, 사번, 재직 상태, 캐디 유형, 휴대전화번호,
            메모 등 근무 운영 정보. 관리자가 관리합니다.
          </li>
          <li>
            휴무 신청, 배치표, 예약 배정, 당번·마샬 등 근무 운영 기록. 예약
            팀명 등 운영 정보가 포함될 수 있습니다.
          </li>
        </ul>
        <h3>이용자가 작성하는 내용</h3>
        <ul>
          <li>코스 제보: 제목, 본문, 코스/홀, 분류, 작성 당시 표시 이름.</li>
          <li>
            제보 사진: 이미지 파일. 데이터베이스에는 저장 키·형식·크기만
            두고, 파일은 비공개 객체 저장소에 둡니다.
          </li>
          <li>댓글: 본문과 작성자 계정. 표시 이름은 조회 시 캐디 이름을 우선합니다.</li>
          <li>공지: 관리자가 작성한 제목·본문·작성자 표시 문자열.</li>
        </ul>
        <h3>기기 및 알림</h3>
        <ul>
          <li>
            Android 푸시: Firebase Cloud Messaging 기기 토큰.
          </li>
          <li>
            웹 푸시: 구독 endpoint, 암호화 키(p256dh, auth), User-Agent,
            플랫폼 구분.
          </li>
        </ul>
        <h3>운영 기록</h3>
        <ul>
          <li>
            관리자 작업 감사 로그: 작업 종류, 대상, 일부 요청의 접속 IP
            (x-forwarded-for).
          </li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>3. 수집 및 이용 목적</h2>
        <ul>
          <li>로그인과 세션 유지, 권한 확인</li>
          <li>카카오 계정과 캐디 명부 연결(본인확인 후 관리자 승인)</li>
          <li>근무 배치, 휴무, 공지, 코스 제보·댓글 등 업무 기능 제공</li>
          <li>공지·배치·제보 관련 푸시 알림 전달</li>
          <li>운영 변경 이력 보존 및 장애 대응</li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>4. 보유 및 이용 기간</h2>
        <p>
          코드에 개인정보 자동 파기 주기는 없습니다. 서비스 이용에 필요한
          동안 보관하며, 삭제 요청이 있으면 아래 절차에 따라 검토합니다.
        </p>
        <ul>
          <li>
            세션 쿠키: 환경 계정 최대 8시간, 관리자 계정 최대 24시간,
            캐디·조장 계정 최대 30일. 슬라이딩 연장은 없습니다.
          </li>
          <li>카카오 로그인 임시 쿠키: 최대 10분.</li>
          <li>
            코스 제보·댓글: 작성자 또는 관리자가 삭제하면 화면에서 숨기는
            소프트 삭제를 사용합니다.
          </li>
          <li>
            푸시 토큰·웹 푸시 구독: 로그아웃·전송 실패·구독 만료 시
            비활성화하거나 제거합니다. 계정에 연결된 기기는 여러 대일 수
            있습니다.
          </li>
          <li>
            휴무 신청, 본인확인 연결 요청, 감사 로그는 운영 이력으로
            유지합니다.
          </li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>5. 제3자 서비스 및 처리 위탁</h2>
        <p>
          아래 서비스는 기능 제공을 위해 사용합니다. 광고·분석 SDK는
          사용하지 않습니다. 알림톡 미리보기 화면은 있으나, 이 앱에서
          알림톡을 실제 발송하지는 않습니다.
        </p>
        <ul>
          <li>
            카카오: 로그인 인증. 앱은 카카오 회원번호만 식별값으로
            사용합니다.
          </li>
          <li>
            Firebase Cloud Messaging(Google): Android 푸시 전달. 기기 토큰과
            알림 제목·본문·앱 내부 경로를 보냅니다.
          </li>
          <li>
            브라우저 푸시 사업자(Chrome/Firefox/Safari 등): 웹 푸시 구독
            정보로 암호화된 알림을 전달합니다.
          </li>
          <li>Vercel: 웹 호스팅, 스케줄 작업, 제보 사진 비공개 저장.</li>
          <li>Neon: PostgreSQL 데이터베이스 호스팅.</li>
          <li>
            Google Sheets: 서버가 근무표 시트를 읽어 올 수 있습니다. 이용자
            개인정보를 시트로 보내지는 않습니다.
          </li>
        </ul>
      </section>

      <section className="privacy-section">
        <h2>6. 로그인 및 인증</h2>
        <p>
          카카오 로그인 또는 관리자가 만든 아이디/비밀번호로 이용합니다.
          공개 회원가입 화면은 없습니다. 다만 카카오 로그인을 처음 완료하면
          캐디 역할의 앱 계정이 자동 생성되고, 캐디 명부와 연결되기 전에는
          본인확인(이름·휴대전화) 후 관리자 승인이 필요합니다.
        </p>
        <p>
          비밀번호는 bcrypt로 해시하여 저장합니다. 전송 구간은 운영
          환경에서 HTTPS를 사용합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>7. 푸시 알림</h2>
        <p>
          Android 앱은 알림 권한을 요청할 수 있고, 허용 시 FCM 토큰을
          계정에 연결합니다. 웹/PWA는 브라우저 알림 허용 시 웹 푸시 구독을
          저장합니다. 로그아웃하거나 알림을 끄면 해당 기기 토큰·구독을
          비활성화합니다.
        </p>
        <p>
          푸시 내용은 공지 제목, 배치표 안내, 코스 제보 상태 등 업무
          알림입니다. 위치 기반 알림은 없습니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>8. 이용자 권리</h2>
        <p>이용자는 자신의 계정과 관련해 다음을 요청할 수 있습니다.</p>
        <ul>
          <li>어떤 정보가 저장되어 있는지 확인</li>
          <li>잘못된 정보의 정정</li>
          <li>계정 또는 작성 내용의 삭제</li>
          <li>푸시 알림 수신 거부(앱·웹 알림 설정 또는 로그아웃)</li>
        </ul>
        <p>
          현재 앱에는 이용자가 직접 계정 전체를 삭제하는 버튼이 없습니다.
          열람·정정·삭제는 관리자에게 요청하면 처리합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>9. 개인정보 삭제 요청</h2>
        <p>
          계정 또는 개인정보 삭제를 원하면 로그인 후 관리자에게 요청해
          주세요. 코스 제보와 댓글은 작성자 또는 관리자가 화면에서 삭제할
          수 있습니다(소프트 삭제).
        </p>
        <p>
          로그인 없이 제출할 수 있는 공개 삭제 요청 주소나 담당 이메일은
          아직 게시하지 않습니다. 확정되면 이 페이지에 안내합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>10. 문의</h2>
        <p>
          개인정보 처리에 관한 문의는 로그인 후 관리자에게 전달해 주세요.
          운영 주체의 공개 이메일·전화번호·주소는 확정 후 이 항목에
          추가합니다.
        </p>
      </section>

      <section className="privacy-section">
        <h2>11. 시행일</h2>
        <p>
          이 방침은 {PRIVACY_EFFECTIVE_DATE}부터 시행합니다. 내용이 바뀌면
          이 페이지를 수정하고 시행일을 갱신합니다.
        </p>
      </section>
    </article>
  );
}
